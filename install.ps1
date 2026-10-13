#Requires -Version 5.1
<#
.SYNOPSIS
    Install gstack with the DeepSeek backend patch (Windows).

.DESCRIPTION
    Clones upstream gstack, applies the DeepSeek port, builds the browser and
    PDF binaries, and optionally registers the skills with an agent.

    This script is deliberately ASCII-only. Windows PowerShell 5.1 reads a
    .ps1 file as ANSI unless it carries a UTF-8 BOM, so a script containing
    non-ASCII text corrupts its own string literals on a non-UTF-8 codepage.
    Keeping the source ASCII removes that failure mode entirely.

.PARAMETER Target
    Where to clone gstack. Default: $HOME\.gstack-src

.PARAMETER RegisterSkills
    dsh     - copy skills into ~/.dsh/skills (and junction the install root)
    claude  - copy skills into ~/.claude/skills
    none    - skip registration
    default: dsh when ~/.dsh exists, otherwise none

.PARAMETER SkipBuild
    Clone and patch only. You will need to build before anything works.

.PARAMETER Force
    Re-clone even when Target already exists.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -Target D:\gstack -RegisterSkills none
#>
[CmdletBinding()]
param(
    [string] $Target = (Join-Path $HOME '.gstack-src'),
    [ValidateSet('dsh', 'claude', 'none')]
    [string] $RegisterSkills,
    [switch] $SkipBuild,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$Upstream = 'https://github.com/garrytan/gstack.git'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Patch = Join-Path $ScriptDir 'patch\gstack-deepseek-port.patch'

function Say  { param([string]$m) Write-Host $m }
function Ok   { param([string]$m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn { param([string]$m) Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Die  { param([string]$m) Write-Host "  [fail] $m" -ForegroundColor Red; exit 1 }

# gstack's build script is bash, but Git for Windows puts only <root>\cmd on
# PATH -- never <root>\bin, where bash.exe lives. So `Get-Command bash` fails on
# a perfectly good Git install. Derive the root from git.exe instead, which
# works for any install location, then fall back to the usual suspects.
function Resolve-GitBash {
    $onPath = Get-Command bash -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $candidates = New-Object System.Collections.Generic.List[string]

    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd -and $gitCmd.Source) {
        # <root>\cmd\git.exe -> <root>, or <root>\bin\git.exe -> <root>.
        $gitDir   = Split-Path $gitCmd.Source -Parent
        $gitRoot  = Split-Path $gitDir -Parent
        foreach ($c in @(
                (Join-Path $gitRoot 'bin\bash.exe'),
                (Join-Path $gitRoot 'usr\bin\bash.exe'),
                (Join-Path $gitDir  'bash.exe'))) {
            $candidates.Add($c)
        }
    }

    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs")) {
        if ($base) { $candidates.Add((Join-Path $base 'Git\bin\bash.exe')) }
    }

    try {
        $reg = Get-ItemProperty 'HKLM:\SOFTWARE\GitForWindows' -ErrorAction Stop
        if ($reg.InstallPath) { $candidates.Add((Join-Path $reg.InstallPath 'bin\bash.exe')) }
    } catch { }

    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

Say ''
Say 'gstack-deepseek installer'
Say '=========================='
Say ''

# ---------------------------------------------------------------- prerequisites
Say 'Checking prerequisites'

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { Die 'git not found. Install Git for Windows first.' }
Ok "git      $((git --version) -replace '^git version ', '')"

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    Warn 'bun not found. gstack needs Bun >= 1.4.2.'
    Warn 'Install it with:  npm install -g bun'
    Die  'bun is required.'
}
$BunDir = Split-Path $bun.Source -Parent
Ok "bun      $(bun --version)"

$Bash = Resolve-GitBash
if ($Bash) {
    Ok "bash     $Bash"
} elseif (-not $SkipBuild) {
    Warn 'bash not found.'
    Warn 'The gstack build script is bash. Install Git for Windows'
    Warn '(https://git-scm.com/download/win), or pass -SkipBuild and build by hand.'
    Die  'bash is required to build.'
} else {
    Warn 'bash not found (fine, -SkipBuild was specified).'
}

# The build runs inside bash, so bash needs bun on ITS PATH. Git Bash does not
# inherit a usable one from PowerShell in every install, so prepend explicitly.
if ($Bash -and $BunDir) {
    $env:PATH = "$BunDir;$env:PATH"
}

if (-not (Test-Path $Patch)) { Die "Patch not found at $Patch" }
Ok "patch    $Patch"

# ---------------------------------------------------------------------- source
Say ''
Say "Preparing source at $Target"

if (Test-Path $Target) {
    if ($Force) {
        Warn 'Target exists and -Force was given; removing it.'
        Remove-Item $Target -Recurse -Force
    } elseif (Test-Path (Join-Path $Target '.git')) {
        Ok 'Reusing the existing checkout.'
    } else {
        Die "Target exists but is not a git checkout: $Target"
    }
}

if (-not (Test-Path $Target)) {
    Say '  cloning upstream (shallow)...'
    & git clone --single-branch --depth 1 $Upstream $Target
    if ($LASTEXITCODE -ne 0) { Die 'git clone failed.' }
    Ok 'cloned upstream'
} else {
    Push-Location $Target
    $behind = (& git rev-parse --short HEAD) 2>$null
    Pop-Location
    Ok "HEAD is $behind"
}

# ----------------------------------------------------------------------- patch
Say ''
Say 'Applying the DeepSeek patch'

Push-Location $Target
try {
    & git apply --check $Patch 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        & git apply $Patch
        if ($LASTEXITCODE -ne 0) { Die 'git apply failed.' }
        Ok 'patch applied'
    } else {
        # Already applied, or the checkout moved. Distinguish the two.
        & git apply --check --reverse $Patch 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Ok 'patch is already applied'
        } else {
            Warn 'patch does not apply cleanly and is not already applied.'
            Warn 'Upstream probably moved. Try a fresh clone, or apply by hand:'
            Warn "  git apply --3way `"$Patch`""
            Die 'cannot apply the patch.'
        }
    }

    # The shim binary is a compiled artifact and is gitignored upstream.
    $ignore = Join-Path $Target '.gitignore'
    if ((Test-Path $ignore) -and -not (Select-String -Path $ignore -Pattern 'gstack-deepseek-claude' -Quiet)) {
        Add-Content -Path $ignore -Value "`n# DeepSeek shim (compiled)`nbin/gstack-deepseek-claude.exe"
        Ok 'gitignore updated for the shim binary'
    }
} finally {
    Pop-Location
}

if ($SkipBuild) {
    Warn 'Skipping the build (-SkipBuild). Nothing will run until you build.'
} else {
    # ------------------------------------------------------------------- build
    Say ''
    Say 'Installing dependencies and building (this takes a few minutes)'

    Push-Location $Target
    try {
        & bun install
        if ($LASTEXITCODE -ne 0) { Die 'bun install failed.' }
        Ok 'dependencies installed'

        & bun x playwright install chromium
        if ($LASTEXITCODE -ne 0) { Warn 'chromium download failed; /browse will not work until it succeeds.' }
        else { Ok 'chromium ready' }

        & $Bash scripts/build.sh
        if ($LASTEXITCODE -ne 0) { Die "build failed. Re-run: `"$Bash`" scripts/build.sh" }
        Ok 'binaries built'

        # The standalone agent for hosts with no Claude Code.
        & bun build --compile --outfile bin/gstack-deepseek-claude.exe bin/gstack-deepseek-claude.ts
        if ($LASTEXITCODE -ne 0) { Warn 'shim build failed; install a Claude Code CLI instead.' }
        else { Ok 'DeepSeek shim built' }
    } finally {
        Pop-Location
    }
}

# ------------------------------------------------------------------- register
if (-not $RegisterSkills) {
    if (Test-Path (Join-Path $HOME '.dsh')) { $RegisterSkills = 'dsh' } else { $RegisterSkills = 'none' }
}

if ($RegisterSkills -eq 'none') {
    Say ''
    Say 'Skipping skill registration (-RegisterSkills none).'
} else {
    $skillRoot = if ($RegisterSkills -eq 'dsh') { Join-Path $HOME '.dsh\skills' } else { Join-Path $HOME '.claude\skills' }
    Say ''
    Say "Registering skills into $skillRoot"

    New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null

    # A junction is fine as a path anchor, but DSH's scanner branches on
    # Dirent.isDirectory(), which is false for a junction, so the skills
    # themselves have to be real copies.
    $skills = Get-ChildItem $Target -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') }

    $copied = 0
    foreach ($s in $skills) {
        $dest = Join-Path $skillRoot $s.Name
        & robocopy $s.FullName $dest /E /XD dist node_modules .git /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
        if ($LASTEXITCODE -lt 8) { $copied++ } else { Warn "copy failed: $($s.Name)" }
    }
    Ok "$copied skill directories copied"

    # The router skill lives at the repo root, not in a directory.
    $router = Join-Path $Target 'SKILL.md'
    if (Test-Path $router) {
        Copy-Item $router (Join-Path $skillRoot 'gstack.md') -Force
        Ok 'router skill registered as gstack.md'
    }

}

# Path anchor for anything resolving ~/.claude/skills/gstack/... -- and the only
# place lib/claude-bin.ts looks for the bundled DeepSeek shim on a host with no
# Claude Code. Created even with -RegisterSkills none, for exactly that reason:
# it costs one link, and without it there is no way to find the agent at all.
$anchor = Join-Path $HOME '.claude\skills\gstack'
if (Test-Path -LiteralPath $anchor) {
    Ok "anchor already present: $anchor"
} else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $anchor) -Force | Out-Null
    try {
        $TargetAbs = (Resolve-Path -LiteralPath $Target).Path
        New-Item -ItemType Junction -Path $anchor -Target $TargetAbs -ErrorAction Stop | Out-Null
        Ok "anchor created: $anchor"
    } catch {
        Warn "could not create the anchor at $anchor."
        Warn "Set GSTACK_ROOT=$Target instead and the shim is still found."
    }
}

# ------------------------------------------------------------------- key check
Say ''
Say 'DeepSeek key'
$haveKey = $false
if ($env:DEEPSEEK_API_KEY) { $haveKey = $true; Ok 'DEEPSEEK_API_KEY is set in this shell' }
foreach ($f in @(
        (Join-Path $HOME '.dsh\.credentials.yaml'),
        (Join-Path $HOME '.gstack\credentials.yaml'))) {
    if ((Test-Path $f) -and (Select-String -Path $f -Pattern '^\s*DEEPSEEK_API_KEY:' -Quiet)) {
        $haveKey = $true
        Ok "key found in $f"
    }
}
if (-not $haveKey) {
    Warn 'No DeepSeek key found. Nothing will run until one exists.'
    Warn 'Either:  setx DEEPSEEK_API_KEY "sk-..."   (then open a new shell)'
    Warn 'Or add:  DEEPSEEK_API_KEY: sk-...   to ~/.dsh/.credentials.yaml'
}

Say ''
Say 'Done.'
Say ''
Say "  source    : $Target"
$shim = Join-Path $Target 'bin\gstack-deepseek-claude.exe'
if (Test-Path $shim) {
    Say "  agent     : $shim"
    Say '              (used automatically when no Claude Code CLI is on PATH)'
} else {
    Say '  agent     : not built -- nothing will run until you build it:'
    Say "              bun build --compile --outfile `"$shim`" bin\gstack-deepseek-claude.ts"
}
Say '  read next : docs/SKILLS.md for the skill list, docs/ANALYSIS.md for how it works'
Say ''
Say '  Do NOT set ANTHROPIC_* environment variables. The code derives what it'
Say '  needs, and a real Claude Code install keeps working if you have one.'
Say ''

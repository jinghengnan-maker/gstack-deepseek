#!/usr/bin/env bash
#
# Install gstack with the DeepSeek backend patch (macOS / Linux).
#
# Clones upstream gstack, applies the DeepSeek port, builds the browser and PDF
# binaries, and optionally registers the skills with an agent.
#
# Usage:
#   ./install.sh [target] [--register dsh|claude|none] [--skip-build] [--force]
#
# Default target: ~/.gstack-src
set -euo pipefail

UPSTREAM="https://github.com/garrytan/gstack.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$SCRIPT_DIR/patch/gstack-deepseek-port.patch"

TARGET="${HOME}/.gstack-src"
REGISTER=""
SKIP_BUILD=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --register)   REGISTER="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --force)      FORCE=1; shift ;;
    -h|--help)    sed -n '2,12p' "$0"; exit 0 ;;
    -*)           echo "unknown option: $1" >&2; exit 2 ;;
    *)            TARGET="$1"; shift ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m[ok]\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

say ""
say "gstack-deepseek installer"
say "=========================="
say ""

# ---------------------------------------------------------------- prerequisites
say "Checking prerequisites"

command -v git >/dev/null 2>&1 || die "git not found."
ok "git      $(git --version | sed 's/^git version //')"

if ! command -v bun >/dev/null 2>&1; then
  # bun's official installer drops the binary in ~/.bun/bin, which a
  # non-interactive shell has not sourced yet.
  for d in "$HOME/.bun/bin" /usr/local/bin; do
    if [ -x "$d/bun" ]; then
      PATH="$d:$PATH"; export PATH
      break
    fi
  done
fi

if ! command -v bun >/dev/null 2>&1; then
  warn "bun not found. gstack needs Bun >= 1.4.2."
  warn "Install it with:  curl -fsSL https://bun.sh/install | bash"
  die  "bun is required."
fi
ok "bun      $(bun --version)"

[ -f "$PATCH" ] || die "Patch not found at $PATCH"
ok "patch    $PATCH"

# ---------------------------------------------------------------------- source
say ""
say "Preparing source at $TARGET"

if [ -e "$TARGET" ]; then
  if [ "$FORCE" -eq 1 ]; then
    warn "Target exists and --force was given; removing it."
    rm -rf "$TARGET"
  elif [ -d "$TARGET/.git" ]; then
    ok "Reusing the existing checkout."
  else
    die "Target exists but is not a git checkout: $TARGET"
  fi
fi

if [ ! -e "$TARGET" ]; then
  say "  cloning upstream (shallow)..."
  git clone --single-branch --depth 1 "$UPSTREAM" "$TARGET" || die "git clone failed."
  ok "cloned upstream"
else
  ok "HEAD is $(git -C "$TARGET" rev-parse --short HEAD)"
fi

# ----------------------------------------------------------------------- patch
say ""
say "Applying the DeepSeek patch"

if git -C "$TARGET" apply --check "$PATCH" 2>/dev/null; then
  git -C "$TARGET" apply "$PATCH" || die "git apply failed."
  ok "patch applied"
elif git -C "$TARGET" apply --check --reverse "$PATCH" 2>/dev/null; then
  ok "patch is already applied"
else
  warn "patch does not apply cleanly and is not already applied."
  warn "Upstream probably moved. Try a fresh clone, or apply by hand:"
  warn "  git -C \"$TARGET\" apply --3way \"$PATCH\""
  die "cannot apply the patch."
fi

# The shim binary is a compiled artifact and is gitignored upstream.
if ! grep -q 'gstack-deepseek-claude' "$TARGET/.gitignore" 2>/dev/null; then
  printf '\n# DeepSeek shim (compiled)\nbin/gstack-deepseek-claude\n' >> "$TARGET/.gitignore"
  ok "gitignore updated for the shim binary"
fi

# ----------------------------------------------------------------------- build
if [ "$SKIP_BUILD" -eq 1 ]; then
  warn "Skipping the build (--skip-build). Nothing will run until you build."
else
  say ""
  say "Installing dependencies and building (this takes a few minutes)"

  ( cd "$TARGET" && bun install ) || die "bun install failed."
  ok "dependencies installed"

  if ( cd "$TARGET" && bun x playwright install chromium ); then
    ok "chromium ready"
  else
    warn "chromium download failed; /browse will not work until it succeeds."
  fi

  ( cd "$TARGET" && bash scripts/build.sh ) || die "build failed. Re-run: bash scripts/build.sh"
  ok "binaries built"

  if ( cd "$TARGET" && bun build --compile --outfile bin/gstack-deepseek-claude bin/gstack-deepseek-claude.ts ); then
    ok "DeepSeek shim built"
  else
    warn "shim build failed; install a Claude Code CLI instead."
  fi
fi

# -------------------------------------------------------------------- register
if [ -z "$REGISTER" ]; then
  if [ -d "$HOME/.dsh" ]; then REGISTER="dsh"; else REGISTER="none"; fi
fi

case "$REGISTER" in
  none)
    say ""
    say "Skipping skill registration (--register none)."
    ;;
  dsh|claude)
    if [ "$REGISTER" = "dsh" ]; then
      SKILL_ROOT="$HOME/.dsh/skills"
    else
      SKILL_ROOT="$HOME/.claude/skills"
    fi
    say ""
    say "Registering skills into $SKILL_ROOT"
    mkdir -p "$SKILL_ROOT"

    # A symlink is fine as a path anchor, but DSH's scanner branches on
    # Dirent.isDirectory(), which is false for a symlink, so the skills
    # themselves have to be real copies.
    copied=0
    for src in "$TARGET"/*/; do
      [ -f "${src}SKILL.md" ] || continue
      name="$(basename "$src")"
      dest="$SKILL_ROOT/$name"
      mkdir -p "$dest"
      # tar is the portable way to copy a tree minus some directories.
      ( cd "$src" && tar --exclude=./dist --exclude=./node_modules --exclude=./.git -cf - . ) \
        | ( cd "$dest" && tar -xf - )
      copied=$((copied + 1))
    done
    ok "$copied skill directories copied"

    # The router skill lives at the repo root, not in a directory.
    if [ -f "$TARGET/SKILL.md" ]; then
      cp "$TARGET/SKILL.md" "$SKILL_ROOT/gstack.md"
      ok "router skill registered as gstack.md"
    fi
    ;;
  *)
    die "--register must be one of: dsh, claude, none"
    ;;
esac

# Path anchor for anything resolving ~/.claude/skills/gstack/... -- and the only
# place lib/claude-bin.ts looks for the bundled DeepSeek shim on a host with no
# Claude Code. Created even with --register none, for exactly that reason: it
# costs one symlink, and without it there is no way to find the agent at all.
ANCHOR="$HOME/.claude/skills/gstack"
if [ -e "$ANCHOR" ] || [ -L "$ANCHOR" ]; then
  ok "anchor already present: $ANCHOR"
else
  mkdir -p "$(dirname "$ANCHOR")"
  if ln -s "$(cd "$TARGET" && pwd)" "$ANCHOR" 2>/dev/null; then
    ok "anchor created: $ANCHOR"
  else
    warn "could not create the anchor at $ANCHOR."
    warn "Set GSTACK_ROOT=$TARGET instead and the shim is still found."
  fi
fi

# -------------------------------------------------------------------- key check
say ""
say "DeepSeek key"
HAVE_KEY=0
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then HAVE_KEY=1; ok "DEEPSEEK_API_KEY is set in this shell"; fi
for f in "$HOME/.dsh/.credentials.yaml" "$HOME/.gstack/credentials.yaml"; do
  if [ -f "$f" ] && grep -qE '^[[:space:]]*DEEPSEEK_API_KEY:' "$f"; then
    HAVE_KEY=1
    ok "key found in $f"
  fi
done
if [ "$HAVE_KEY" -eq 0 ]; then
  warn "No DeepSeek key found. Nothing will run until one exists."
  warn "Either:  export DEEPSEEK_API_KEY=sk-...   (add it to your shell rc)"
  warn "Or add:  DEEPSEEK_API_KEY: sk-...   to ~/.dsh/.credentials.yaml"
fi

say ""
say "Done."
say ""
say "  source    : $TARGET"
if [ -x "$TARGET/bin/gstack-deepseek-claude" ]; then
  say "  agent     : $TARGET/bin/gstack-deepseek-claude"
  say "              (used automatically when no Claude Code CLI is on PATH)"
else
  say "  agent     : not built -- nothing will run until you build it:"
  say "              bun build --compile --outfile bin/gstack-deepseek-claude bin/gstack-deepseek-claude.ts"
fi
say "  read next : docs/SKILLS.md for the skill list, docs/ANALYSIS.md for how it works"
say ""
say "  Do NOT set ANTHROPIC_* environment variables. The code derives what it"
say "  needs, and a real Claude Code install keeps working if you have one."
say ""

/**
 * claude-bin.ts — Cross-platform `claude` binary resolution.
 *
 * Uses Bun.which() for the platform handling (PATH parsing, Windows PATHEXT,
 * X_OK, case-insensitive Path/PATH on Windows). Adds the gstack-specific
 * override + arg-prefix logic on top.
 *
 * Windows .cmd shims: npm installs a global CLI as `claude`, `claude.cmd` and
 * `claude.ps1`, and Bun.which resolves the `.cmd`. child_process.spawn then
 * refuses it — "spawn ...claude.cmd EINVAL" — because Node/Bun require
 * shell:true for a batch file since the CVE-2024-27980 hardening, and gstack
 * deliberately spawns without a shell so argv needs no quoting. Rather than
 * trade that safety for a shell, this module resolves past the shim to a real
 * executable so the caller always gets something spawnable.
 *
 * Override precedence:
 *   1. GSTACK_CLAUDE_BIN (or CLAUDE_BIN as fallback) — absolute path or
 *      PATH-resolvable command. `wsl` resolves through Bun.which('wsl') just
 *      like a bare `claude` lookup would.
 *   2. Plain `Bun.which('claude')` if no override is set.
 *   3. The bundled DeepSeek shim (bin/gstack-deepseek-claude) when a DeepSeek
 *      key is resolvable — a real `claude` always wins, so this only fires on
 *      a host that has no Claude Code at all. See lib/deepseek.ts.
 *
 * Arg prefix:
 *   GSTACK_CLAUDE_BIN_ARGS (or CLAUDE_BIN_ARGS) prepends arguments to every
 *   spawn. Accepts a JSON array (e.g. '["claude", "--no-cache"]') or a single
 *   scalar string treated as one argument. Only applied when an override is
 *   active — bare `claude` resolution doesn't pick up an arg prefix.
 *
 * Returns null when nothing resolves; callers should degrade (e.g. transcript
 * classifier returns degraded:true) rather than throw.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deepSeekAvailable } from './deepseek';

export interface ClaudeCommand {
  command: string;
  argsPrefix: string[];
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}

function parseOverrideArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.GSTACK_CLAUDE_BIN_ARGS ?? env.CLAUDE_BIN_ARGS;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed;
    }
  } catch {
    // Not JSON — treat as a single scalar argument.
  }
  return [stripWrappingQuotes(raw.trim())];
}

export function resolveClaudeCommand(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCommand | null {
  const argsPrefix = parseOverrideArgs(env);
  const override = (env.GSTACK_CLAUDE_BIN ?? env.CLAUDE_BIN)?.trim();
  // Honor case-insensitive Path/PATH on Windows. Bun.which itself reads
  // process.env so we forward whichever the caller passed.
  const PATH = env.PATH ?? env.Path ?? '';

  if (override) {
    const trimmed = stripWrappingQuotes(override);
    // Absolute path: use as-is. Otherwise PATH-resolve through Bun.which so
    // overrides like GSTACK_CLAUDE_BIN=wsl find the actual binary.
    const resolved = path.isAbsolute(trimmed) ? trimmed : Bun.which(trimmed, { PATH });
    return resolved ? { command: resolved, argsPrefix } : null;
  }

  const which = Bun.which('claude', { PATH });
  const command = which ? spawnableClaudeExecutable(which) : null;
  if (command) return { command, argsPrefix: [] };

  // No spawnable Claude Code on this host: fall back to the bundled DeepSeek
  // shim, which answers the same -p/--output-format json contract. Never
  // shadows a usable `claude` — only fills the gap where resolution would
  // otherwise return null.
  const shim = resolveDeepSeekShim(env, PATH);
  return shim ? { command: shim, argsPrefix } : null;
}

/**
 * Map a Windows batch shim onto the real executable behind it, because a `.cmd`
 * cannot be spawned without a shell (see the header). Returns null when no
 * spawnable form exists, which lets the caller fall through to the DeepSeek shim.
 */
function spawnableClaudeExecutable(candidate: string): string | null {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(candidate)) return candidate;

  const dir = path.dirname(candidate);
  const stem = path.basename(candidate).replace(/\.(cmd|bat)$/i, '');

  // An .exe sitting beside the shim.
  const sibling = path.join(dir, `${stem}.exe`);
  if (fs.existsSync(sibling)) return sibling;

  // npm's global layout: <prefix>/claude.cmd next to <prefix>/node_modules/...
  const installed = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', `${stem}.exe`);
  if (fs.existsSync(installed)) return installed;

  return null;
}

/**
 * Locate bin/gstack-deepseek-claude. GSTACK_DEEPSEEK_CLAUDE_BIN names it
 * outright; otherwise probe the install roots a gstack process can be running
 * from, plus the source checkout this module was loaded from.
 */
function resolveDeepSeekShim(env: NodeJS.ProcessEnv, PATH: string): string | null {
  if (!deepSeekAvailable(env)) return null;

  const explicit = env.GSTACK_DEEPSEEK_CLAUDE_BIN?.trim();
  if (explicit) {
    const trimmed = stripWrappingQuotes(explicit);
    const resolved = path.isAbsolute(trimmed) ? trimmed : Bun.which(trimmed, { PATH });
    if (resolved) return resolved;
  }

  const home = os.homedir();
  const names = process.platform === 'win32'
    ? ['gstack-deepseek-claude.exe', 'gstack-deepseek-claude']
    : ['gstack-deepseek-claude'];
  const roots = [
    env.GSTACK_ROOT ? path.join(env.GSTACK_ROOT, 'bin') : undefined,
    path.join(home, '.claude', 'skills', 'gstack', 'bin'),
    path.join(home, '.dsh', 'skills', 'gstack', 'bin'),
    path.join(home, '.gstack', 'bin'),
    path.join(import.meta.dir, '..', 'bin'),
  ].filter((root): root is string => Boolean(root));

  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Unreadable root; try the next.
      }
    }
  }
  return null;
}

/** Convenience wrapper for callers that only need the command path. */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveClaudeCommand(env)?.command ?? null;
}

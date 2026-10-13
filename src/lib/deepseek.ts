/**
 * deepseek.ts — DeepSeek credential, endpoint and model resolution.
 *
 * gstack ships targeting Anthropic's API and the `claude` CLI. This port keeps
 * every call site, gate and refusal intact and re-points the transport at
 * DeepSeek's Anthropic-compatible endpoint instead:
 *
 *   https://api.deepseek.com/anthropic   Anthropic Messages shape, x-api-key
 *   https://api.deepseek.com/v1          OpenAI Chat Completions shape
 *
 * Credentials are read from the environment first (DEEPSEEK_API_KEY, or the
 * GSTACK_-prefixed form Conductor workspaces export) and fall back to the
 * DeepSeek Harness credential store at $DSH_HOME/.credentials.yaml, so a gstack
 * process started from any shell finds the key without the caller exporting
 * anything.
 *
 * applyDeepSeekEnv() is idempotent and never overwrites a value the caller
 * already set, so a session that means to talk to real Anthropic still can.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEEPSEEK_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic';
export const DEEPSEEK_OPENAI_BASE = 'https://api.deepseek.com/v1';
/**
 * Chat tier — the workhorse wherever gstack would call Sonnet-class models.
 * `deepseek-flash` is the id this host's Claude Code is already pinned to
 * (C:\Users\LENOVO\.claude\settings.json), so gstack and Claude Code agree on
 * one model. The API accepts `deepseek-chat` as an alias and reports back
 * `deepseek-flash`.
 */
export const DEEPSEEK_MODEL = 'deepseek-flash';
/** Reasoning tier — the cross-family outside voice for reviews. */
export const DEEPSEEK_REASONING_MODEL = 'deepseek-reasoner';

const KEY_VARS = ['DEEPSEEK_API_KEY', 'GSTACK_DEEPSEEK_API_KEY'] as const;

/** Credential stores, in precedence order. Missing files are skipped. */
function credentialFiles(env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir();
  const files = [
    env.DSH_HOME ? path.join(env.DSH_HOME, '.credentials.yaml') : undefined,
    path.join(home, '.dsh', '.credentials.yaml'),
    path.join(home, '.gstack', 'credentials.yaml'),
  ];
  return files.filter((f): f is string => Boolean(f));
}

/** Parse `DEEPSEEK_API_KEY:` out of a YAML-ish store without a YAML dependency. */
export function readDeepSeekKeyFromStore(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const file of credentialFiles(env)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const match = /^[ \t]*DEEPSEEK_API_KEY:[ \t]*["']?([^"'\s#]+)["']?/m.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * Environment first, then the DeepSeek Harness credential store.
 *
 * The store is consulted only for the ambient environment. A caller that passes
 * an env object explicitly means "this is the whole environment" — that is what
 * test/helpers/hermetic-env.ts relies on, and os.homedir() would otherwise read
 * the real user profile no matter what the caller handed us, leaking a live key
 * into a hermetic run.
 */
export function resolveDeepSeekKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of KEY_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  if (env !== process.env) return undefined;
  return readDeepSeekKeyFromStore(env);
}

export function deepSeekAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveDeepSeekKey(env));
}

export interface DeepSeekEnv {
  apiKey: string;
  anthropicBase: string;
  openaiBase: string;
  model: string;
  reasoningModel: string;
}

/** The DeepSeek settings this process should use, or undefined with no key. */
export function deepSeekEnv(env: NodeJS.ProcessEnv = process.env): DeepSeekEnv | undefined {
  const apiKey = resolveDeepSeekKey(env);
  if (!apiKey) return undefined;
  return {
    apiKey,
    anthropicBase: env.GSTACK_DEEPSEEK_ANTHROPIC_BASE?.trim() || DEEPSEEK_ANTHROPIC_BASE,
    openaiBase: env.GSTACK_DEEPSEEK_OPENAI_BASE?.trim() || DEEPSEEK_OPENAI_BASE,
    model: env.GSTACK_DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL,
    reasoningModel: env.GSTACK_DEEPSEEK_REASONING_MODEL?.trim() || DEEPSEEK_REASONING_MODEL,
  };
}

/**
 * Point the canonical Anthropic variables at DeepSeek, in place.
 *
 * Each assignment is guarded, so an explicit ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 * in the environment always wins and this can run at every import site safely.
 *
 * GSTACK_CLAUDE_MODEL matters more than it looks: lib/model-policy.ts treats a
 * non-default ANTHROPIC_BASE_URL as a *custom provider* and refuses to pick a
 * model until one is named. Setting it here satisfies that gate with a model
 * DeepSeek actually serves, instead of the catalog's claude-* ids.
 *
 * Returns true when a DeepSeek key was found and the environment now carries it.
 */
export function applyDeepSeekEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = deepSeekEnv(env);
  if (!cfg) return false;
  const set = (name: string, value: string): void => {
    if (!env[name]?.trim()) env[name] = value;
  };
  set('ANTHROPIC_API_KEY', cfg.apiKey);
  set('ANTHROPIC_AUTH_TOKEN', cfg.apiKey);
  set('ANTHROPIC_BASE_URL', cfg.anthropicBase);
  set('ANTHROPIC_MODEL', cfg.model);
  set('ANTHROPIC_SMALL_FAST_MODEL', cfg.model);
  set('GSTACK_CLAUDE_MODEL', cfg.model);
  set('GSTACK_EVAL_MODEL_DISTILL', cfg.model);
  return true;
}

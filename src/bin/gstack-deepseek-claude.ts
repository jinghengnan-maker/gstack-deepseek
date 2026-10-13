#!/usr/bin/env bun
/**
 * gstack-deepseek-claude — a `claude` CLI shim backed by DeepSeek.
 *
 * gstack's outside-voice path (lib/claude-code.ts) spawns the `claude` binary
 * with `-p --output-format json` and expects one JSON object carrying a
 * `result` string. This binary answers that contract with DeepSeek's
 * Anthropic-compatible endpoint instead of Anthropic:
 *
 *   stdout  {"type":"result","subtype":"success","is_error":false,
 *            "result":"<text>","session_id":"…","usage":{…},"model":"…"}
 *   exit    0 on success, 1 on any failure (parseClaudeCodeResult gate)
 *
 * Point gstack at it with:
 *   GSTACK_CLAUDE_BIN=<abs path to this binary>
 *   BROWSE_TERMINAL_BINARY=<abs path to this binary>   (browse sidebar PTY)
 *
 * Tool use is real, not simulated: DeepSeek's /anthropic endpoint returns
 * proper `tool_use` blocks (verified stop_reason=tool_use), so when gstack
 * grants read-only access this shim runs an actual Read/Grep/Glob loop confined
 * to --cwd. With `--tools ''` (access none) it advertises no tools at all, which
 * is what lib/claude-code.ts means by "analyze only the supplied prompt".
 *
 * A `--model` naming anything DeepSeek does not serve (a catalog claude-* id,
 * say) is substituted with the configured DeepSeek model and reported on
 * stderr, so a stale model id degrades to a correct call rather than a 404.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyDeepSeekEnv, deepSeekEnv, DEEPSEEK_MODEL } from '../lib/deepseek';

const MAX_TURNS_CAP = 40;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_GREP_HITS = 250;
const MAX_GLOB_HITS = 500;
const READ_LINE_CAP = 4000;

interface ShimArgs {
  prompt?: string;
  model?: string;
  systemPrompt?: string;
  appendSystem: string[];
  /** null means "no tools advertised"; a Set means exactly those tools. */
  tools: Set<string> | null;
  maxTurns: number;
  outputFormat: 'text' | 'json' | 'stream-json';
  resume?: string;
  sessionId: string;
}

function newSessionId(): string {
  return `deepseek-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Flags the real CLI accepts that take no value. Anything else starting with a
 * dash is assumed to consume the following token as its value: a flag we have
 * never heard of is far more likely to be `--some-option value` than a
 * free-standing boolean, and mis-reading its value as the prompt would let the
 * flag list silently overwrite the caller's prompt.
 */
const BOOLEAN_FLAGS = new Set([
  '-p', '--print', '--verbose', '--debug', '--continue', '-c', '--ide',
  '--dangerously-skip-permissions', '--strict-mcp-config', '--no-cache',
  '--disable-slash-commands', '--help', '-h', '--version', '-v',
]);

/** Tolerant flag parser: accepts `--flag value` and `--flag=value`, ignores the rest. */
function parseArgs(argv: string[]): ShimArgs {
  const out: ShimArgs = { appendSystem: [], tools: null, maxTurns: 12, outputFormat: 'text', sessionId: newSessionId() };
  const takesValue = new Set([
    '--model', '--system-prompt', '--append-system-prompt', '--tools', '--allowedTools',
    '--disallowedTools', '--max-turns', '--output-format', '--resume', '--permission-mode',
    '--settings', '--mcp-config', '--add-dir', '--session-id', '--access',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let flag = raw;
    let value: string | undefined;
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq !== -1) {
      flag = raw.slice(0, eq);
      value = raw.slice(eq + 1);
    }
    if (takesValue.has(flag) && value === undefined) {
      value = argv[++i];
      if (value === undefined) continue;
    } else if (value === undefined && flag.startsWith('-') && !BOOLEAN_FLAGS.has(flag) && !takesValue.has(flag)) {
      // Unknown flag: absorb its value so it can never be mistaken for the prompt.
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++;
      continue;
    }

    switch (flag) {
      case '-p': case '--print': break;
      case '--model': out.model = value; break;
      case '--system-prompt': out.systemPrompt = value; break;
      case '--append-system-prompt': if (value) out.appendSystem.push(value); break;
      case '--tools': case '--allowedTools': case '--disallowedTools': {
        // `--tools ''` and `--tools Read,Grep,Glob` both arrive here. A
        // disallowedTools list only ever subtracts; an empty tools list means none.
        const list = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (flag === '--disallowedTools') {
          for (const name of list) out.tools?.delete(name);
        } else {
          out.tools ??= new Set();
          for (const name of list) out.tools.add(name);
        }
        break;
      }
      case '--max-turns': {
        const n = Number(value);
        if (Number.isSafeInteger(n) && n > 0) out.maxTurns = Math.min(n, MAX_TURNS_CAP);
        break;
      }
      case '--output-format':
        if (value === 'json' || value === 'stream-json' || value === 'text') out.outputFormat = value;
        break;
      case '--resume': out.resume = value; break;
      case '--session-id': if (value) out.sessionId = value; break;
      default:
        // Positional prompt: anything not starting with '-'.
        if (!raw.startsWith('-') && out.prompt === undefined) out.prompt = raw;
        break;
    }
  }
  // An explicit empty --tools must not leave a stale empty Set meaning "some tools".
  if (out.tools && out.tools.size === 0) out.tools = null;
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------- tool surface
type Json = Record<string, unknown>;

const TOOL_SCHEMAS = [
  {
    name: 'Read',
    description: 'Read a UTF-8 text file. Returns the contents with line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'File path, absolute or relative to the working directory.' } },
      required: ['path'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with a regular expression. Returns matching lines as path:line:text.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression source.' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the working directory.' },
        glob: { type: 'string', description: 'Only search files whose path matches this substring, e.g. ".ts".' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files by path pattern. Supports * and ** segments.',
    input_schema: {
      type: 'object' as const,
      properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts".' } },
      required: ['pattern'],
    },
  },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__', '.venv', 'target']);

/** Confine every tool to the invocation's cwd; a shim must not read the whole disk. */
function confine(cwd: string, requested: string | undefined): string {
  const target = path.resolve(cwd, requested ?? '.');
  const rel = path.relative(cwd, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the working directory: ${requested}`);
  }
  return target;
}

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walk(path.join(dir, entry.name), depth + 1);
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        out += '.*';
        i++;
        if (normalized[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`(^|/)${out}$`);
}

function runTool(cwd: string, name: string, input: Json): string {
  if (name === 'Read') {
    const file = confine(cwd, typeof input.path === 'string' ? input.path : undefined);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`not a file: ${input.path}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file is ${stat.size} bytes, over the ${MAX_FILE_BYTES}-byte read limit`);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const shown = lines.slice(0, READ_LINE_CAP);
    const body = shown.map((line, i) => `${String(i + 1).padStart(5)}\t${line}`).join('\n');
    return shown.length < lines.length ? `${body}\n… truncated at ${READ_LINE_CAP} of ${lines.length} lines` : body;
  }

  if (name === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
    if (!pattern) throw new Error('pattern is required');
    const re = new RegExp(pattern);
    const glob = typeof input.glob === 'string' ? input.glob : undefined;
    const root = confine(cwd, typeof input.path === 'string' ? input.path : undefined);
    const files = fs.statSync(root).isFile() ? [root] : [...walk(root)];
    const hits: string[] = [];
    for (const file of files) {
      if (glob && !file.includes(glob)) continue;
      let text: string;
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(cwd, file).replace(/\\/g, '/')}:${i + 1}:${lines[i].slice(0, 400)}`);
          if (hits.length >= MAX_GREP_HITS) return `${hits.join('\n')}\n… capped at ${MAX_GREP_HITS} matches`;
        }
      }
    }
    return hits.length ? hits.join('\n') : 'No matches.';
  }

  if (name === 'Glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : '**/*';
    const re = globToRegExp(pattern);
    const hits: string[] = [];
    for (const file of walk(cwd)) {
      const rel = path.relative(cwd, file).replace(/\\/g, '/');
      if (re.test(rel)) {
        hits.push(rel);
        if (hits.length >= MAX_GLOB_HITS) break;
      }
    }
    return hits.length ? hits.sort().join('\n') : 'No files matched.';
  }

  throw new Error(`unknown tool: ${name}`);
}

// ------------------------------------------------------------------- transport
interface Message { role: 'user' | 'assistant'; content: unknown }

async function callDeepSeek(
  cfg: { apiKey: string; anthropicBase: string },
  model: string,
  system: string,
  messages: Message[],
  tools: unknown[],
): Promise<Json> {
  const body: Json = { model, max_tokens: 8192, system, messages };
  if (tools.length) body.tools = tools;

  const res = await fetch(`${cfg.anthropicBase.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    throw new Error(`DeepSeek returned non-JSON (${res.status}): ${text.slice(0, 600)}`);
  }
  if (!res.ok) {
    const detail = (json as any)?.error?.message ?? text.slice(0, 600);
    throw new Error(`DeepSeek ${res.status}: ${detail}`);
  }
  return json;
}

/** DeepSeek serves deepseek-*; anything else (a catalog claude-* id) is substituted. */
function resolveModel(requested: string | undefined, fallback: string): { model: string; note?: string } {
  if (!requested) return { model: fallback };
  const id = requested.includes('/') ? requested.slice(requested.indexOf('/') + 1) : requested;
  if (/^deepseek/.test(id)) return { model: id };
  return { model: fallback, note: `requested model ${JSON.stringify(requested)} is not served by DeepSeek; using ${fallback}` };
}

// ------------------------------------------------------------------------ main
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  applyDeepSeekEnv();
  const cfg = deepSeekEnv();

  const sessionId = args.resume || args.sessionId;
  try {
    // gstack writes the prompt to the child's stdin and passes no positional,
    // so piped stdin is the authoritative prompt and a positional is the
    // interactive fallback. Drain stdin even when a positional wins: leaving
    // bytes unread can hand the parent an EPIPE when it finishes writing.
    let stdinText = '';
    if (!process.stdin.isTTY) {
      try {
        stdinText = (await readStdin()).trim();
      } catch {
        // No readable stdin; fall back to argv.
      }
    }
    const prompt = stdinText || args.prompt || '';

    if (!cfg) {
      process.stderr.write('gstack-deepseek-claude: no DeepSeek API key found (set DEEPSEEK_API_KEY or add it to ~/.dsh/.credentials.yaml)\n');
      emit(args, { is_error: true, result: '', sessionId, model: '' });
      return 1;
    }
    if (!prompt) {
      emit(args, { is_error: true, result: 'No prompt supplied on argv or stdin.', sessionId, model: '' });
      return 1;
    }

    const { model, note } = resolveModel(args.model, cfg.model);
    if (note) process.stderr.write(`gstack-deepseek-claude: ${note}\n`);

    const system = [args.systemPrompt, ...args.appendSystem].filter(Boolean).join('\n\n');
    const tools = args.tools ? TOOL_SCHEMAS.filter((t) => args.tools!.has(t.name)) : [];

    const messages: Message[] = [{ role: 'user', content: prompt }];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let finalText = '';

    for (let turn = 0; turn < args.maxTurns; turn++) {
      const json = await callDeepSeek(cfg, model, system, messages, tools);
      usage.input_tokens += Number((json as any)?.usage?.input_tokens ?? 0);
      usage.output_tokens += Number((json as any)?.usage?.output_tokens ?? 0);

      const blocks = Array.isArray(json.content) ? (json.content as any[]) : [];
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b?.type === 'tool_use');
      if (text.trim()) finalText = text;

      if (json.stop_reason !== 'tool_use' || !calls.length) break;

      messages.push({ role: 'assistant', content: blocks });
      const results = calls.map((call) => {
        let body: string;
        try {
          body = runTool(process.cwd(), String(call.name), (call.input ?? {}) as Json);
        } catch (err) {
          body = `Error: ${(err as Error).message}`;
        }
        return { type: 'tool_result', tool_use_id: call.id, content: body };
      });
      messages.push({ role: 'user', content: results });
    }

    if (!finalText.trim()) {
      emit(args, { is_error: true, result: 'DeepSeek returned no response text.', sessionId, model });
      return 1;
    }
    emit(args, { is_error: false, result: finalText, sessionId, model, usage });
    return 0;
  } catch (err) {
    process.stderr.write(`gstack-deepseek-claude: ${(err as Error).message}\n`);
    emit(args, { is_error: true, result: (err as Error).message, sessionId, model: '' });
    return 1;
  }
}

/** The single stdout line lib/claude-code.ts parses. Nothing else may go to stdout. */
function emit(args: ShimArgs, payload: { is_error: boolean; result: string; sessionId: string; model: string; usage?: unknown }): void {
  const record = {
    type: 'result',
    subtype: payload.is_error ? 'error_during_execution' : 'success',
    is_error: payload.is_error,
    result: payload.result,
    session_id: payload.sessionId,
    model: payload.model || DEEPSEEK_MODEL,
    provider: 'deepseek',
    ...(payload.usage ? { usage: payload.usage } : {}),
  };
  if (args.outputFormat === 'text') {
    process.stdout.write(payload.result + (payload.result.endsWith('\n') ? '' : '\n'));
  } else if (args.outputFormat === 'stream-json') {
    process.stdout.write(JSON.stringify(record) + '\n');
  } else {
    process.stdout.write(JSON.stringify(record) + '\n');
  }
}

process.exitCode = await main();

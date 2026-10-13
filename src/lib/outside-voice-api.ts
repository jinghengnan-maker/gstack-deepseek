/**
 * outside-voice-api — the `api` runner's transport (plan B3): one direct
 * model call with OPENAI_API_KEY, ANTHROPIC_API_KEY or a DeepSeek key, chosen
 * by the model's family. It is a supplied-input review: the model sees the
 * prompt bytes and nothing else (no repository, no tools), and the runner
 * labels the record so it is never silently equal to a repo-reading review.
 * Every send writes an egress receipt first (lib/egress-receipt.ts). Base URLs
 * honor the providers' own environment variables (OPENAI_BASE_URL,
 * ANTHROPIC_BASE_URL) so a test can point them at a local server.
 *
 * DeepSeek is a first-class family here (`--outside deepseek-reasoner`), and it
 * is also the fallback transport: an anthropic- or openai-family model with no
 * key of its own is answered by DeepSeek instead of refused, because on a
 * DeepSeek-only host the alternative is that every outside voice is unavailable.
 * The substitution is not silent — the result carries provider:'deepseek' and
 * the model id that actually answered, and the runner labels its record from
 * those fields.
 */
import { deepSeekEnv, resolveDeepSeekKey } from './deepseek';
import { sha256Hex, writeReceipt } from './egress-receipt';
import { modelFamily, type ModelFamily } from './outside-voice-runner';

export interface ApiCallRequest { model: string; prompt: string; timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal; maxTokens?: number }
export interface ApiUsage { input_tokens?: number; output_tokens?: number }
export type ApiProvider = 'openai' | 'anthropic' | 'deepseek';
export interface ApiCallResult { text: string; model: string; usage: ApiUsage; provider: ApiProvider; status: number }

export const API_FAMILIES: readonly ModelFamily[] = ['openai', 'anthropic', 'deepseek'];

export function apiKeyFor(family: ModelFamily, env: Record<string, string | undefined> = process.env): { key: string; provider: ApiProvider } | undefined {
  if (family === 'openai' && env.OPENAI_API_KEY) return { key: env.OPENAI_API_KEY, provider: 'openai' };
  if (family === 'anthropic' && env.ANTHROPIC_API_KEY) return { key: env.ANTHROPIC_API_KEY, provider: 'anthropic' };
  if (family === 'deepseek') {
    const key = resolveDeepSeekKey(env);
    if (key) return { key, provider: 'deepseek' };
  }
  return undefined;
}

function receipted(url: string, body: string, provider: string): void {
  try {
    writeReceipt({
      sink: 'outside-voice-api', host: new URL(url).host, payloadClass: 'review-prompt', bytes: Buffer.byteLength(body), sha256: sha256Hex(body),
      consent: `user ran gstack-outside-voice --runner api (${provider.toUpperCase()}_API_KEY configured)`,
    });
  } catch (err) {
    process.stderr.write(`[outside-voice] egress receipt could not be written (${(err as Error).message}); proceeding (fail-open)\n`);
  }
}

async function post(url: string, headers: Record<string, string>, body: string, req: ApiCallRequest, provider: string): Promise<{ status: number; json: any }> {
  receipted(url, body, provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${req.timeoutMs} ms`)), req.timeoutMs);
  req.signal?.addEventListener('abort', () => controller.abort(req.signal!.reason), { once: true });
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally { clearTimeout(timer); }
}

/** Where a request goes and in which wire shape. */
interface Transport { shape: 'anthropic' | 'openai'; base: string; key: string; provider: ApiProvider; model: string }

function bareModelId(model: string): string {
  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
}

/**
 * Pick the credential and endpoint for a family, falling back to DeepSeek when
 * the family's own key is absent. A claude or gpt style id cannot be sent to
 * DeepSeek, so it is swapped for a model DeepSeek serves; /reason/ ids keep the
 * reasoning tier. Throws the family's original refusal when nothing can serve it.
 */
function planTransport(family: ModelFamily, model: string, env: Record<string, string | undefined>): Transport {
  const deepseek = deepSeekEnv(env);
  const onDeepSeek = (shape: 'anthropic' | 'openai'): Transport => {
    const id = bareModelId(model);
    const chosen = /^deepseek/.test(id) ? id : /reason/i.test(id) ? deepseek!.reasoningModel : deepseek!.model;
    return { shape, base: shape === 'anthropic' ? deepseek!.anthropicBase : deepseek!.openaiBase, key: deepseek!.apiKey, provider: 'deepseek', model: chosen };
  };

  if (family === 'anthropic') {
    const key = env.ANTHROPIC_API_KEY;
    if (key) return { shape: 'anthropic', base: (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, ''), key, provider: 'anthropic', model: bareModelId(model) };
    if (deepseek) return onDeepSeek('anthropic');
  } else if (family === 'openai') {
    const key = env.OPENAI_API_KEY;
    if (key) return { shape: 'openai', base: (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''), key, provider: 'openai', model: bareModelId(model) };
    if (deepseek) return onDeepSeek('openai');
  } else if (family === 'deepseek' && deepseek) {
    return onDeepSeek('openai');
  }

  throw new Error(`no API key for model family ${family} (set ${family === 'anthropic' ? 'ANTHROPIC_API_KEY' : family === 'openai' ? 'OPENAI_API_KEY' : family === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY or ANTHROPIC_API_KEY and name a model from that family'})`);
}

/** One call; throws with the provider's error text on a non-2xx status. */
export async function callModel(req: ApiCallRequest): Promise<ApiCallResult> {
  const env = req.env ?? process.env;
  const plan = planTransport(modelFamily(req.model), req.model, env);
  const model = plan.model;

  if (plan.shape === 'anthropic') {
    const body = JSON.stringify({ model, max_tokens: req.maxTokens ?? 8192, messages: [{ role: 'user', content: req.prompt }] });
    const { status, json } = await post(`${plan.base}/v1/messages`, { 'x-api-key': plan.key, 'anthropic-version': '2023-06-01' }, body, req, plan.provider);
    if (status < 200 || status >= 300) throw new Error(`${plan.provider} ${status}: ${json?.error?.message ?? json?.raw ?? JSON.stringify(json)}`);
    const text = Array.isArray(json?.content) ? json.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '';
    return { text, model: typeof json?.model === 'string' ? json.model : model, usage: { input_tokens: json?.usage?.input_tokens, output_tokens: json?.usage?.output_tokens }, provider: plan.provider, status };
  }

  const body = JSON.stringify({ model, messages: [{ role: 'user', content: req.prompt }] });
  const { status, json } = await post(`${plan.base}/chat/completions`, { authorization: `Bearer ${plan.key}` }, body, req, plan.provider);
  if (status < 200 || status >= 300) throw new Error(`${plan.provider} ${status}: ${json?.error?.message ?? json?.raw ?? JSON.stringify(json)}`);
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('\n') : '';
  return { text, model: typeof json?.model === 'string' ? json.model : model, usage: { input_tokens: json?.usage?.prompt_tokens, output_tokens: json?.usage?.completion_tokens }, provider: plan.provider, status };
}

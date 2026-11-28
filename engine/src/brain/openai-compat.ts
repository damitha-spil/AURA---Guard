import { ApiError, REQUEST_TIMEOUT_MS, RETRY_BACKOFF_MS } from "./client.ts";
import { asCancel, CancelledError, readSse, withAbort } from "./stream.ts";
import type { CompleteResult } from "./client.ts";
import type { Backend, BackendOptions } from "./backends.ts";
import { MODEL_ID_RE } from "./models.ts";
import { windowsFromHeaders } from "../usage/limits.ts";
import type { OpenAiCompatProvider } from "./providers.ts";

/** The model list is only a picker aid; it must not hold up the settings screen. */
const MODELS_TIMEOUT_MS = 6_000;
const MODELS_CACHE_MS = 10 * 60_000;
/** OpenRouter lists several hundred models; this is only a guard against a runaway reply. */
const MODELS_MAX = 600;

export function openAiCompatBackend(p: OpenAiCompatProvider, o: BackendOptions = {}): Backend {
  const env = o.env ?? process.env;
  const model = (o.model ?? "").trim();
  return {
    id: p.id,
    kind: "api",
    streams: true,
    async available() {
      const fromEnv = Boolean(env[p.env]?.trim());
      const stored = !fromEnv && Boolean(o.storedKey && (await o.storedKey.exists().catch(() => false)));
      if (!fromEnv && !stored) return { ok: false, detail: `${p.env} is not set and no key is saved in Guard` };
      if (!model) return { ok: false, detail: "A key is set. Pick a model to use it" };
      return { ok: true, detail: `${fromEnv ? `${p.env} is set` : "a key saved in Guard is set"} (model ${model})` };
    },
    async complete(req) {
      const key = env[p.env]?.trim() || (o.storedKey ? await o.storedKey.get() : null);
      if (!key) throw new Error(`No API key is set. Set ${p.env}, or save a key in Guard.`);
      if (!model) throw new Error(`No model is picked for ${p.label}.`);
      const messages = [{ role: "system", content: req.system.join("\n\n") }, { role: "user", content: req.user }];
      const base = { model, [p.maxField]: req.maxTokens, messages };
      const common = {
        onHeaders: (h: Headers) => req.limits?.(windowsFromHeaders(h)),
        url: `${p.base}/chat/completions`, key, fetch: o.fetch ?? fetch,
        sleep: o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
        ...(req.signal ? { signal: req.signal } : {}),
      };
      if (req.onText) {
        const payload = JSON.stringify({ ...base, stream: true, stream_options: { include_usage: true } });
        req.audit(payload, model);
        try {
          return await postChatStream({ ...common, payload, onText: req.onText });
        } catch (e) {
          // A provider that does not accept streaming (or stream_options) answers 400/422 before any text:
          // ask again for a whole reply. The first request carried the same masked text, and was audited.
          if (!(e instanceof StreamUnsupported)) throw e;
        }
      }
      const payload = JSON.stringify(base);
      req.audit(payload, model);
      return postChat({ ...common, payload });
    },
  };
}

/** The provider refused a streaming request (400/422) before any text. */
class StreamUnsupported extends Error {}

interface PostArgs {
  url: string; key: string; payload: string; fetch: typeof fetch; sleep: (ms: number) => Promise<void>;
  onHeaders?: (headers: Headers) => void;
  signal?: AbortSignal;
}

/** Sends the request. One retry on 429 / 5xx. Redirects are refused. */
async function sendChat(a: PostArgs): Promise<Response> {
  const send = (): Promise<Response> => a.fetch(a.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${a.key}` },
    body: a.payload,
    redirect: "error",
    signal: withAbort(REQUEST_TIMEOUT_MS, a.signal),
  });
  try {
    let res = await send();
    if (res.status === 429 || res.status >= 500) {
      await a.sleep(RETRY_BACKOFF_MS);
      res = await send();
    }
    return res;
  } catch (e) {
    throw asCancel(e, a.signal);
  }
}

/** Streams a chat completion: `delta.content` pieces go to `onText` (masked text); usage comes from the last chunk. */
async function postChatStream(a: PostArgs & { onText: (delta: string) => void }): Promise<CompleteResult> {
  const res = await sendChat(a);
  if (res.headers) a.onHeaders?.(res.headers);
  if (res.status === 400 || res.status === 422) throw new StreamUnsupported();
  if (!res.ok) throw await chatApiError(res, a.key);
  if (!res.headers?.get("content-type")?.includes("text/event-stream")) {
    // Not a stream after all: read it as a whole reply.
    return chatResult(await res.json());
  }
  let text = "";
  let usageJson: any;
  try {
    await readSse(res, (_e, data) => {
      if (data.trim() === "[DONE]") return false;
      let v: any;
      try { v = JSON.parse(data); } catch { return; }
      const piece = v?.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece) {
        text += piece;
        a.onText(piece);
      }
      if (v?.usage) usageJson = v.usage;
    });
  } catch (e) {
    throw asCancel(e, a.signal);
  }
  if (a.signal?.aborted) throw new CancelledError();
  if (!text.trim()) throw new Error("The model returned an empty response.");
  return chatResult({ choices: [{ message: { content: text } }], usage: usageJson });
}

async function chatApiError(res: Response, key: string): Promise<ApiError> {
  let detail = "";
  try {
    const j = (await res.json()) as any;
    // Gemini wraps its error object in an array.
    detail = String((Array.isArray(j) ? j[0] : j)?.error?.message ?? "").split(key).join("[key]").slice(0, 200);
  } catch { /* no body */ }
  return new ApiError(res.status, detail);
}

/** One retry on 429 / 5xx. Redirects are refused. The key never appears in an error. */
async function postChat(a: PostArgs): Promise<CompleteResult> {
  const res = await sendChat(a);
  if (res.headers) a.onHeaders?.(res.headers);
  if (!res.ok) throw await chatApiError(res, a.key);
  return chatResult(await res.json());
}

function chatResult(j: any): CompleteResult {
  const text = String(j.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("The model returned an empty response.");
  // The prompt count includes cached tokens; they are kept apart. DeepSeek names the field differently.
  const prompt = Number(j.usage?.prompt_tokens ?? 0);
  const cached = Math.min(prompt, Number(j.usage?.prompt_tokens_details?.cached_tokens ?? j.usage?.prompt_cache_hit_tokens ?? 0));
  return {
    text,
    usage: {
      input_tokens: prompt - cached, output_tokens: Number(j.usage?.completion_tokens ?? 0),
      ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
      ...(j.usage ? {} : { reported: false }),
    },
  };
}

const modelsCache = new Map<string, { at: number; ids: string[] }>();

/** The ids this key can use. Never throws: on any problem the list is empty. Sends no project text. */
export async function discoverApiModels(p: OpenAiCompatProvider, key: string, doFetch: typeof fetch = fetch): Promise<string[]> {
  const cached = modelsCache.get(p.id);
  if (cached && Date.now() - cached.at < MODELS_CACHE_MS) return cached.ids;
  try {
    const res = await doFetch(`${p.base}/models`, {
      headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (j.data ?? [])
      .map((m) => String(m.id ?? "").replace(/^models\//, "")) // Gemini prefixes its ids
      .filter((id) => MODEL_ID_RE.test(id))
      .slice(0, MODELS_MAX)
      .sort();
    if (ids.length > 0) modelsCache.set(p.id, { at: Date.now(), ids });
    return ids;
  } catch {
    return [];
  }
}

/** A changed key may see different models. */
export function forgetApiModels(id: string): void {
  modelsCache.delete(id);
}

import { ApiError, REQUEST_TIMEOUT_MS, RETRY_BACKOFF_MS } from "./client.ts";
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
      const payload = JSON.stringify({
        model,
        [p.maxField]: req.maxTokens,
        messages: [{ role: "system", content: req.system.join("\n\n") }, { role: "user", content: req.user }],
      });
      req.audit(payload, model);
      return postChat({
        onHeaders: (h) => req.limits?.(windowsFromHeaders(h)),
        url: `${p.base}/chat/completions`, key, payload, fetch: o.fetch ?? fetch,
        sleep: o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
      });
    },
  };
}

/** One retry on 429 / 5xx. Redirects are refused. The key never appears in an error. */
async function postChat(a: {
  url: string; key: string; payload: string; fetch: typeof fetch; sleep: (ms: number) => Promise<void>;
  onHeaders?: (headers: Headers) => void;
}): Promise<CompleteResult> {
  const send = (): Promise<Response> => a.fetch(a.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${a.key}` },
    body: a.payload,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let res = await send();
  if (res.status === 429 || res.status >= 500) {
    await a.sleep(RETRY_BACKOFF_MS);
    res = await send();
  }
  if (res.headers) a.onHeaders?.(res.headers);
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as any;
      // Gemini wraps its error object in an array.
      detail = String((Array.isArray(j) ? j[0] : j)?.error?.message ?? "").split(a.key).join("[key]").slice(0, 200);
    } catch { /* no body */ }
    throw new ApiError(res.status, detail);
  }
  const j = (await res.json()) as any;
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

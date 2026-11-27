import { createHash } from "node:crypto";
import { join } from "node:path";
import type { GuardConfig } from "../types.ts";
import type { DictionaryTerm } from "../mask/detectors.ts";
import { maskOutgoing, unmask } from "../mask/mask.ts";
import { auditOutgoing } from "../mask/audit.ts";

/** Default paid model. Override with AURA_GUARD_MODEL. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2023-06-01";
/** One request may not take longer than this; a stuck call must not hang a nightly job. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** Wait before the single retry (429 / 5xx only). */
export const RETRY_BACKOFF_MS = 2_000;
/** Marks the joins between blocks so one mask pass shares one placeholder map. */
export const SEP = "\n␞␞ AURA-GUARD-BLOCK-BREAK ␞␞\n";

export class MissingKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set. Set it in the environment to use the paid model.");
    this.name = "MissingKeyError";
  }
}

export class BlockedError extends Error {
  blocked: { kind: string; count: number }[];
  constructor(blocked: { kind: string; count: number }[]) {
    super(
      "Outgoing call blocked: secret-like values found (" +
        blocked.map((b) => `${b.kind} x${b.count}`).join(", ") +
        "). Nothing was sent.",
    );
    this.name = "BlockedError";
    this.blocked = blocked;
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(`Model API returned ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** False when the backend gave no token counts. */
  reported?: boolean;
}

export interface CompleteRequest {
  role: string;
  system: string[]; // stable blocks first
  user: string;
  maxTokens: number;
  dictionary?: DictionaryTerm[];
  /** The chat this call belongs to, for the usage record only. Never sent. */
  sessionId?: string;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
  /** The model that answered, when the backend says so. */
  model?: string;
}

export type CompleteFn = (req: CompleteRequest) => Promise<CompleteResult>;

export interface BrainOptions {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * mask.ts makes one placeholder map per call, so separate calls would reuse
 * CUSTOMER_01 for different names. We join all blocks with a separator, mask
 * once, and split back: one shared map, one unmask for the answer.
 */
export function maskAll(blocks: string[], dictionary?: DictionaryTerm[]) {
  const r = maskOutgoing(blocks.join(SEP), { dictionary });
  if (!r.ok) throw new BlockedError(r.blocked);
  const parts = r.text.split(SEP);
  if (parts.length !== blocks.length) throw new Error("Masking changed the block layout; nothing was sent.");
  return { parts, map: r.map, replaced: r.replaced };
}

/** The request body for the Messages API: cache_control on the last system block only. */
export function buildPayload(model: string, maxTokens: number, sys: string[], userText: string): string {
  const system = sys.map((text, i) =>
    i === sys.length - 1 ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text },
  );
  return JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: userText }] });
}

/** Sends an already-masked payload. One retry on 429 / 5xx. The key never appears in an error. */
export async function postMessages(a: {
  key: string; payload: string; fetch: typeof fetch; sleep: (ms: number) => Promise<void>;
  /** Sees the response headers, for rate limits. */
  onHeaders?: (headers: Headers) => void;
}): Promise<CompleteResult> {
  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await a.fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": a.key, "anthropic-version": API_VERSION },
      body: a.payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 1) break;
    await a.sleep(RETRY_BACKOFF_MS);
  }
  if (!res) throw new Error("No response");
  if (res.headers) a.onHeaders?.(res.headers);
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      detail = String(j.error?.message ?? "").slice(0, 200);
    } catch { /* no body */ }
    throw new ApiError(res.status, detail.split(a.key).join("[key]"));
  }
  const j = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: Usage };
  const text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  return { text, usage: j.usage ?? { input_tokens: 0, output_tokens: 0, reported: false } };
}

export function createBrain(cfg: GuardConfig, opts: BrainOptions = {}): { complete: CompleteFn } {
  const doFetch = opts.fetch ?? fetch;
  const env = opts.env ?? process.env;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());

  async function complete(req: CompleteRequest): Promise<CompleteResult> {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new MissingKeyError();
    const model = env.AURA_GUARD_MODEL || DEFAULT_MODEL;

    const { parts, map, replaced } = maskAll([...req.system, req.user], req.dictionary);
    const userText = parts[parts.length - 1]!;
    const sys = parts.slice(0, -1);
    const payload = buildPayload(model, req.maxTokens, sys, userText);

    auditOutgoing(join(cfg.root, "logs"), {
      ts: now().toISOString(),
      role: req.role,
      model,
      sha256: createHash("sha256").update(payload).digest("hex"),
      blocked: [],
      replaced,
    });

    const { text, usage } = await postMessages({ key, payload, fetch: doFetch, sleep });
    return {
      text: unmask(text, map),
      usage,
    };
  }
  return { complete };
}

// Small HTTP helpers shared by the server routes.

import type { IncomingMessage, ServerResponse } from "node:http";

/** JSON bodies larger than this are refused: a question is a few lines of text. */
export const MAX_BODY_BYTES = 32 * 1024;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Body = { ok: true; value: Record<string, unknown> } | { ok: false; error: HttpError };
const cache = new WeakMap<IncomingMessage, Promise<Body>>();

async function parse(req: IncomingMessage): Promise<Body> {
  try {
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "Send JSON.");
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > MAX_BODY_BYTES) throw new HttpError(413, "That request is too large.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "That request is too large.");
      chunks.push(c as Buffer);
    }
    let v: unknown;
    try {
      v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    } catch {
      throw new HttpError(400, "That was not valid JSON.");
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? e : new HttpError(400, "That was not valid JSON.") };
  }
}

/** Reads the JSON body once per request; later calls return the same result (or the same error). */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let p = cache.get(req);
  if (!p) {
    p = parse(req);
    cache.set(req, p);
  }
  const r = await p;
  if (!r.ok) throw r.error;
  return r.value;
}

/** The body if it is valid JSON, otherwise null (the handler that needs it reports the error). */
export async function peekJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    return await readJson(req);
  } catch {
    return null;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

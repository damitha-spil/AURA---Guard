export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }
    const err = typeof (parsed as { error?: string })?.error === "string" ? (parsed as { error: string }).error : undefined;
    return { ok: res.ok, status: res.status, data: parsed as T, ...(err ? { error: err } : {}) };
  } catch (e) {
    return { ok: false, status: 0, data: {} as T, error: (e as Error).message };
  }
}

export const apiGet = <T>(url: string) => request<T>(url, { method: "GET" });
export const apiPost = <T>(url: string, body?: unknown) =>
  request<T>(url, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
export const apiPut = <T>(url: string, body: unknown) =>
  request<T>(url, { method: "PUT", body: JSON.stringify(body) });
export const apiPatch = <T>(url: string, body: unknown) =>
  request<T>(url, { method: "PATCH", body: JSON.stringify(body) });
export const apiDelete = <T>(url: string) => request<T>(url, { method: "DELETE" });

export async function streamNdjson(
  url: string,
  body: unknown,
  onEvent: (ev: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`);
    onEvent({ type: "error", message: msg });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // skip malformed line
      }
    }
  }
}

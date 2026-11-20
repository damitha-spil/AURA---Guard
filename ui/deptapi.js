// Department API client. `fetchImpl` is injectable so Node tests can use a fake. Never throws:
// every call returns {ok, status, data}; network failures come back as status 0 with a plain error.

export function createDeptApi(fetchImpl) {
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  async function call(path, method, body) {
    const init = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    try {
      const r = await f(path, init);
      const data = await r.json().catch(() => ({}));
      if (!r.ok && !data.error) data.error = `Request failed (${r.status})`;
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: "Could not reach the server. Check that it is still running." } };
    }
  }
  const id = (x) => encodeURIComponent(x);
  return {
    list: () => call("/api/departments", "GET"),
    get: (x) => call(`/api/departments/${id(x)}`, "GET"),
    create: (body) => call("/api/departments", "POST", body),
    update: (x, department, etag) => call(`/api/departments/${id(x)}`, "PUT", { department, etag }),
    remove: (x, purge) => call(`/api/departments/${id(x)}`, "DELETE", { confirm: x, ...(purge ? { purge: true } : {}) }),
    checkSource: (x, path, kind) => call(`/api/departments/${id(x)}/sources/check`, "POST", { path, kind }),
  };
}

/** Adds `dept` to an API path (GET) or body (POST). Department endpoints themselves are left alone. */
export function withDept(path, body, dept) {
  if (!dept || !path.startsWith("/api/") || path.startsWith("/api/departments")) return { path, body };
  if (body === undefined) return { path: path + (path.includes("?") ? "&" : "?") + "dept=" + encodeURIComponent(dept), body };
  return { path, body: body && typeof body === "object" ? { dept, ...body } : body };
}

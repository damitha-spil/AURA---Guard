// QA Pillar 3: Safe Security & Adversarial ("Foreign Attack") Probe Suite.
// Strictly locked to allowedHosts (127.0.0.1 / localhost / tauri.localhost) via isLocalUrl.
// Probes SQLi canary, XSS reflection, path traversal, oversized body, security headers, and secret leaks.

import { detectSecrets } from "../mask/detectors.ts";
import type { GuardConfig } from "../types.ts";
import { maskDeep } from "./safe-out.ts";
import { isLocalUrl, loadForbidden } from "./safety.ts";

/** Safety timeout per adversarial probe in ms. */
const PROBE_TIMEOUT_MS = 4_000;
/** Oversized payload size (128 KB) for body-cap testing. */
const OVERSIZED_BODY_BYTES = 128 * 1024;

export interface SecurityProbeResult {
  id: string;
  category: "sqli" | "xss" | "traversal" | "dos" | "headers" | "secrets";
  target: string;
  status: "pass" | "fail";
  httpStatus?: number;
  detail: string;
}

export interface SecurityProbeReport {
  generatedAt: string;
  baseUrl: string;
  ok: boolean;
  passed: number;
  failed: number;
  probes: SecurityProbeResult[];
}

const SQL_ERROR_RE = /sql syntax|sqlite|ora-\d{5}|pg_query|unclosed quotation mark|odbc|sqlstate/i;

export async function runSecurityProbes(
  cfg: GuardConfig,
  opts: { baseUrl: string; paths?: string[]; fetchFn?: typeof fetch },
): Promise<SecurityProbeReport> {
  const forbidden = loadForbidden(cfg.root);
  if (!isLocalUrl(opts.baseUrl, forbidden)) {
    throw new Error(`Blocked security probes against non-local host: ${opts.baseUrl}.`);
  }

  const doFetch = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const targetPaths = opts.paths?.length ? opts.paths.slice(0, 5) : ["/"];
  const probes: SecurityProbeResult[] = [];

  for (const p of targetPaths) {
    const cleanPath = p.startsWith("/") ? p : `/${p}`;

    // 1. SQLi canary
    try {
      const r = await doFetch(`${base}${cleanPath}?q=${encodeURIComponent("' OR '1'='1")}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body = await r.text();
      const leaked = SQL_ERROR_RE.test(body) || r.status >= 500;
      probes.push({
        id: `sqli-${cleanPath}`,
        category: "sqli",
        target: cleanPath,
        status: leaked ? "fail" : "pass",
        httpStatus: r.status,
        detail: leaked ? `SQL error or 500 returned (HTTP ${r.status}).` : `Handled SQLi canary safely (HTTP ${r.status}).`,
      });
    } catch (e) {
      probes.push({ id: `sqli-${cleanPath}`, category: "sqli", target: cleanPath, status: "fail", detail: (e as Error).message });
    }

    // 2. XSS reflection
    const xssPayload = "<svg onload=alert(1)>";
    try {
      const r = await doFetch(`${base}${cleanPath}?q=${encodeURIComponent(xssPayload)}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body = await r.text();
      const reflected = body.includes(xssPayload);
      probes.push({
        id: `xss-${cleanPath}`,
        category: "xss",
        target: cleanPath,
        status: reflected ? "fail" : "pass",
        httpStatus: r.status,
        detail: reflected ? "Unescaped XSS canary reflected in response body." : "No raw XSS reflection detected.",
      });
    } catch (e) {
      probes.push({ id: `xss-${cleanPath}`, category: "xss", target: cleanPath, status: "fail", detail: (e as Error).message });
    }

    // 3. Path traversal
    try {
      const r = await doFetch(`${base}/..%2f..%2fetc%2fpasswd`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body = await r.text();
      const hit = r.status === 200 && /root:x:0:0:/i.test(body);
      probes.push({
        id: `traversal-${cleanPath}`,
        category: "traversal",
        target: "/..%2f..%2fetc%2fpasswd",
        status: hit ? "fail" : "pass",
        httpStatus: r.status,
        detail: hit ? "Path traversal returned sensitive system file!" : `Path traversal blocked (HTTP ${r.status}).`,
      });
    } catch (e) {
      probes.push({ id: `traversal-${cleanPath}`, category: "traversal", target: cleanPath, status: "fail", detail: (e as Error).message });
    }

    // 4. Security headers & secret leak check
    try {
      const r = await doFetch(`${base}${cleanPath}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body = await r.text();
      const nosniff = r.headers.get("x-content-type-options")?.toLowerCase() === "nosniff";
      const csp = Boolean(r.headers.get("content-security-policy"));
      probes.push({
        id: `headers-${cleanPath}`,
        category: "headers",
        target: cleanPath,
        status: nosniff && csp ? "pass" : "fail",
        httpStatus: r.status,
        detail: nosniff && csp ? "CSP and X-Content-Type-Options: nosniff present." : `Missing headers (nosniff=${nosniff}, csp=${csp}).`,
      });
      const secrets = detectSecrets(body);
      probes.push({
        id: `secrets-${cleanPath}`,
        category: "secrets",
        target: cleanPath,
        status: secrets.length > 0 ? "fail" : "pass",
        httpStatus: r.status,
        detail: secrets.length > 0 ? `Detected ${secrets.length} secret-like span(s) in response.` : "No secrets detected in response body.",
      });
    } catch (e) {
      probes.push({ id: `headers-${cleanPath}`, category: "headers", target: cleanPath, status: "fail", detail: (e as Error).message });
    }
  }

  // 5. Oversized payload DoS cap check
  try {
    const big = JSON.stringify({ pad: "x".repeat(OVERSIZED_BODY_BYTES) });
    const r = await doFetch(`${base}${targetPaths[0] ?? "/"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ok = r.status < 500;
    probes.push({
      id: "oversized-body",
      category: "dos",
      target: targetPaths[0] ?? "/",
      status: ok ? "pass" : "fail",
      httpStatus: r.status,
      detail: ok ? `Oversized payload handled cleanly (HTTP ${r.status}).` : `Server crashed with HTTP ${r.status} on 128 KB payload.`,
    });
  } catch (e) {
    probes.push({ id: "oversized-body", category: "dos", target: "/", status: "fail", detail: (e as Error).message });
  }

  const passed = probes.filter((p) => p.status === "pass").length;
  const failed = probes.filter((p) => p.status === "fail").length;

  return maskDeep({
    generatedAt: new Date().toISOString(),
    baseUrl: base,
    ok: failed === 0,
    passed,
    failed,
    probes,
  });
}

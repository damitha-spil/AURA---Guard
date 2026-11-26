// QA Pillar 2: Swagger / OpenAPI Contract & Endpoint Test Engine.
// Parses JSON or YAML OpenAPI 3.x / Swagger 2.0 specs, synthesizes positive/negative/boundary
// test cases, and executes safe read-only GET/HEAD checks strictly on allowed local test hosts.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { GuardConfig } from "../types.ts";
import { maskDeep } from "./safe-out.ts";
import { isLocalUrl, loadForbidden } from "./safety.ts";

/** Safety cap: maximum endpoints tested in one OpenAPI run. */
export const MAX_OPENAPI_ENDPOINTS = 40;
/** Safety timeout per local HTTP check in ms. */
export const OPENAPI_TIMEOUT_MS = 5_000;

export interface ApiEndpointSpec {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  hasPathParam: boolean;
  hasRequestBody: boolean;
  expectedStatuses: number[];
}

export interface ApiTestCase {
  id: string;
  method: string;
  path: string;
  kind: "positive" | "negative" | "boundary";
  description: string;
  executable: boolean;
}

export interface ApiCheckResult {
  caseId: string;
  method: string;
  path: string;
  kind: ApiTestCase["kind"];
  status: "pass" | "fail" | "skipped";
  httpStatus?: number;
  ms: number;
  detail: string;
}

export interface OpenApiTestReport {
  generatedAt: string;
  baseUrl: string;
  endpointsFound: number;
  casesGenerated: number;
  passed: number;
  failed: number;
  skipped: number;
  results: ApiCheckResult[];
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function parseOpenApiSpec(rawText: string): ApiEndpointSpec[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];
  const doc = (trimmed.startsWith("{") ? JSON.parse(trimmed) : parseYaml(trimmed)) as Record<string, unknown>;
  const paths = (doc?.["paths"] && typeof doc["paths"] === "object" ? doc["paths"] : {}) as Record<string, unknown>;
  const out: ApiEndpointSpec[] = [];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [mKey, opRaw] of Object.entries(pathItem as Record<string, unknown>)) {
      const method = mKey.toLowerCase();
      if (!HTTP_METHODS.has(method) || !opRaw || typeof opRaw !== "object") continue;
      const op = opRaw as Record<string, unknown>;
      const responses = (op["responses"] && typeof op["responses"] === "object" ? op["responses"] : {}) as Record<string, unknown>;
      const expectedStatuses = Object.keys(responses)
        .map((k) => Number(k))
        .filter((n) => Number.isInteger(n) && n >= 100 && n < 600);
      out.push({
        method: method.toUpperCase(),
        path: pathKey,
        ...(typeof op["operationId"] === "string" ? { operationId: op["operationId"] } : {}),
        ...(typeof op["summary"] === "string" ? { summary: op["summary"] } : {}),
        hasPathParam: /\{[^}]+\}/.test(pathKey),
        hasRequestBody: Boolean(op["requestBody"]),
        expectedStatuses: expectedStatuses.length ? expectedStatuses : [200],
      });
      if (out.length >= MAX_OPENAPI_ENDPOINTS) return out;
    }
  }
  return out;
}

export function generateApiTestCases(endpoints: ApiEndpointSpec[]): ApiTestCase[] {
  const cases: ApiTestCase[] = [];
  for (const ep of endpoints) {
    const safeExec = ep.method === "GET" || ep.method === "HEAD";
    const slug = `${ep.method.toLowerCase()}-${ep.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}`;
    cases.push({
      id: `${slug}-pos`,
      method: ep.method,
      path: ep.path.replace(/\{[^}]+\}/g, "1"),
      kind: "positive",
      description: `${ep.method} ${ep.path} returns expected status (${ep.expectedStatuses.join("/")}).`,
      executable: safeExec && !ep.hasPathParam,
    });
    cases.push({
      id: `${slug}-neg`,
      method: ep.method,
      path: ep.hasPathParam ? ep.path.replace(/\{[^}]+\}/g, "__nonexistent__") : `${ep.path}?__invalid_probe=1`,
      kind: "negative",
      description: `${ep.method} ${ep.path} rejects or safely handles unknown/invalid input without 500.`,
      executable: safeExec,
    });
    if (ep.hasRequestBody || ep.hasPathParam) {
      cases.push({
        id: `${slug}-bnd`,
        method: ep.method,
        path: ep.path.replace(/\{[^}]+\}/g, "0"),
        kind: "boundary",
        description: `${ep.method} ${ep.path} boundary check (zero/empty/max).`,
        executable: safeExec && ep.hasPathParam,
      });
    }
  }
  return cases;
}

export async function runOpenApiChecks(
  cfg: GuardConfig,
  opts: { specText?: string; specPath?: string; baseUrl: string; fetchFn?: typeof fetch },
): Promise<OpenApiTestReport> {
  const forbidden = loadForbidden(cfg.root);
  if (!isLocalUrl(opts.baseUrl, forbidden)) {
    throw new Error(`Refusing OpenAPI run against non-local host: ${opts.baseUrl}. Only allowed local test hosts are permitted.`);
  }
  const rawSpec = opts.specText ?? (opts.specPath && existsSync(opts.specPath) ? readFileSync(opts.specPath, "utf8") : "");
  const endpoints = parseOpenApiSpec(rawSpec);
  const cases = generateApiTestCases(endpoints);
  const doFetch = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const results: ApiCheckResult[] = [];

  for (const tc of cases) {
    if (!tc.executable) {
      results.push({
        caseId: tc.id,
        method: tc.method,
        path: tc.path,
        kind: tc.kind,
        status: "skipped",
        ms: 0,
        detail: "Mutating or parameterized endpoint synthesized as test case (not auto-executed).",
      });
      continue;
    }
    const t0 = Date.now();
    try {
      const res = await doFetch(`${base}${tc.path}`, {
        method: tc.method,
        signal: AbortSignal.timeout(OPENAPI_TIMEOUT_MS),
      });
      const ms = Date.now() - t0;
      const is5xx = res.status >= 500;
      const ok = tc.kind === "positive" ? res.status < 400 : !is5xx;
      results.push({
        caseId: tc.id,
        method: tc.method,
        path: tc.path,
        kind: tc.kind,
        status: ok ? "pass" : "fail",
        httpStatus: res.status,
        ms,
        detail: ok ? `HTTP ${res.status} (${ms} ms)` : `Unexpected HTTP ${res.status} (${ms} ms)`,
      });
    } catch (e) {
      results.push({
        caseId: tc.id,
        method: tc.method,
        path: tc.path,
        kind: tc.kind,
        status: "fail",
        ms: Date.now() - t0,
        detail: (e as Error).message.split("\n")[0] ?? "request failed",
      });
    }
  }

  return maskDeep({
    generatedAt: new Date().toISOString(),
    baseUrl: base,
    endpointsFound: endpoints.length,
    casesGenerated: cases.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
  });
}

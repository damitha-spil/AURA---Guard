// Detectors for the masking step. Each detector returns spans in the input.
// "secret" spans block the outgoing call; "sensitive" spans are replaced with
// stable placeholders and the call may still go out.

export type Severity = "secret" | "sensitive";

export interface Span {
  start: number;
  end: number;
  kind: string; // upper-case, e.g. "GITHUB_TOKEN", "EMAIL"
  severity: Severity;
}

export interface DictionaryTerm {
  term: string;
  kind: string;
}

/**
 * Shannon entropy threshold for the "looks random" detector.
 * Random base64/alphanumeric text of 20+ characters measures about 4.0-5.5
 * bits per character; English words, identifiers and camelCase names measure
 * about 2.5-3.6. We flag at >= 3.8 and also require three character classes
 * (upper, lower, digit, symbol) plus at least one digit, so long identifiers
 * are not caught. Pure hex has a ceiling of 4.0, so it uses a separate
 * threshold (3.0) and skips the standard digest lengths (git SHA-1 = 40,
 * MD5 = 32, SHA-256 = 64, SHA-512 = 128) and UUIDs, which are public
 * identifiers and not secrets by themselves.
 */
export const ENTROPY_THRESHOLD = 3.8;
export const HEX_ENTROPY_THRESHOLD = 3.0;
export const MIN_RANDOM_LEN = 20;
/** Longer runs are almost always embedded files (icons, fonts), not keys. */
export const MAX_RANDOM_LEN = 256;

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

interface Pattern {
  kind: string;
  re: RegExp; // must have the g flag
  group?: number; // capture group holding the span; default whole match
  /** Return true to drop a match that is a known harmless shape. Gets the span text. */
  skip?: (span: string) => boolean;
}

/**
 * Words that are placeholders, never a real credential. Compared in lower case
 * against the whole value.
 */
const PLACEHOLDER_WORDS = new Set([
  "pass", "pw", "pwd", "passwd", "password", "secret", "changeme", "xxx", "xxxx", "user", "username", "token",
]);

/**
 * A value that labels itself as a fixture: "test-token-123", "fake_key". Strict
 * on purpose: lower-case words plus at most three digits. "test-Xk39dj2Q" is not
 * skipped, so a real staging secret that starts with "test-" is still blocked.
 */
const SELF_LABELLED_FIXTURE = /^(?:test|fake|dummy|sample|example|mock)(?:[-_ ][a-z]+){0,3}[-_]?\d{0,3}$/i;

export function looksFake(v: string): boolean {
  return PLACEHOLDER_WORDS.has(v.toLowerCase()) || SELF_LABELLED_FIXTURE.test(v);
}

/**
 * For key-shaped tokens (sk-..., ghp_...): fake words inside, an alphabet or
 * number run, or a tiny alphabet repeated. Real keys are random, so none of
 * these appear by chance in 30+ characters.
 */
export function looksFakeKey(v: string): boolean {
  if (/(?:fake|dummy|example|sample|placeholder|xxxx|redacted)/i.test(v)) return true;
  if (/(?:abcdef|bcdefg|012345|123456|234567|345678|456789)/i.test(v)) return true;
  const body = v.replace(/^[A-Za-z]{2,10}[-_]/, "");
  return body.length >= 12 && new Set(body.toLowerCase()).size <= 4;
}

const SECRET_PATTERNS: Pattern[] = [
  { kind: "PRIVATE_KEY", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, skip: looksFakeKey },
  { kind: "AWS_KEY", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, skip: looksFakeKey },
  { kind: "GITHUB_TOKEN", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, skip: looksFakeKey },
  { kind: "ANTHROPIC_KEY", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, skip: looksFakeKey },
  { kind: "OPENAI_KEY", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, skip: looksFakeKey },
  { kind: "GOOGLE_KEY", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, skip: looksFakeKey },
  { kind: "SLACK_TOKEN", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, skip: looksFakeKey },
  { kind: "AZURE_SAS", re: /[?&;]sig=[A-Za-z0-9%+/=]{20,}/g },
  // Not an npm/yarn "integrity" hash (sha512-<base64>==): that is a public checksum.
  { kind: "AZURE_STORAGE_KEY", re: /(?<!sha(?:1|256|384|512)-)\b[A-Za-z0-9+/]{86}==/g },
  // Azure DevOps personal access tokens are 52 chars of base32 (a-z, 2-7).
  { kind: "AZDO_PAT", re: /(?<![A-Za-z0-9])(?=[a-z2-7]*[2-7])(?=[a-z2-7]*[a-z])[a-z2-7]{52}(?![A-Za-z0-9])/g },
  { kind: "BEARER_TOKEN", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, group: 1, skip: looksFakeKey },
  // scheme://user:password@host (postgres, mongodb, mongodb+srv, mssql, redis, https...)
  { kind: "URL_PASSWORD", re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]+:([^\s@/'"`]{3,})@/gi, group: 1, skip: looksFake },
];

// The key word, then up to 12 more name characters (password_hash, apiKeyProd).
// "pat" is only a key on its own (a personal access token): "path", "pattern"
// and "patch" are not.
const KV_KEY =
  "(?<kw>password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|account[_-]?key|access[_-]?key|private[_-]?key|credential|pat)(?<suf>[A-Za-z0-9_]{0,12})";
// "key": "value"   key=value   key: value   (value may sit on the next line)
const KV_QUOTED = new RegExp(`${KV_KEY}["']?\\s*[:=]\\s*(?<q>["'\`])(?<v>[^"'\`\\r\\n]{4,200}?)\\k<q>`, "gi");
const KV_UNQUOTED = new RegExp(`${KV_KEY}["']?\\s*[:=]\\s*(?<v>[^\\s;"'\`,<>]{6,200})`, "gi");
// Connection strings: Server=...;User Id=sa;Password=Welcome; (letters-only passwords count here).
const CONN_PASSWORD = /(?<![A-Za-z0-9_])(?:password|pwd)\s*=\s*(?<v>[^;\s"'`]{3,100})/gi;
const CONN_CONTEXT = /\b(?:server|data source|host|database|initial catalog|user id|uid|provider|driver)\s*=/i;

const NOT_A_VALUE = new Set([
  "string", "number", "boolean", "null", "none", "undefined", "true", "false",
  "required", "optional", "secret", "password", "token", "redacted", "changeme",
  "example", "placeholder", "empty", "your_password", "yourpassword", "unknown",
]);

/**
 * A name ending that says the field is not the secret itself: a label, a type,
 * a plural ("tokens": a count), a flag. Compared after the key word.
 */
const NON_SECRET_SUFFIX =
  /^(?:s|es)?[_-]?(?:(?:type|placeholder|remove|ok|label|hint|title|header|name|ref|field|input|count|limit|len|length|max|min|id|prefix|about|help|error|status|path|file|dir|url|endpoint|kind|mode|ttl|set|required|missing|empty|saved|stored|state|flag|enabled|disabled)s?)?$/i;

function keyIsSecretName(text: string, m: RegExpMatchArray & { index: number }): boolean {
  const kw = (m.groups?.kw ?? "").toLowerCase();
  const suf = m.groups?.suf ?? "";
  if (kw === "pat") {
    if (m.index > 0 && /[A-Za-z]/.test(text[m.index - 1] as string)) return false;
    if (!/^\d*$/.test(suf)) return false;
  }
  if (suf.length > 0 && NON_SECRET_SUFFIX.test(suf)) return false;
  // A page cursor is not a credential: nextPageToken, pageToken, cursor_token.
  if (kw === "token" && /(?:page|cursor|continuation|next)[_-]?$/i.test(text.slice(Math.max(0, m.index - 12), m.index))) {
    return false;
  }
  return true;
}

function plausibleValue(v: string, quoted: boolean, kw: string): boolean {
  const lower = v.toLowerCase();
  if (NOT_A_VALUE.has(lower)) return false;
  if (lower === kw.toLowerCase()) return false; // a label that repeats the key
  if (/^[*x.#\u2022\u25cf-]+$/i.test(v)) return false; // already masked
  if (/^[$%{<(&]/.test(v)) return false; // template / env reference / Rust reference or type
  if (/^\/\^/.test(v)) return false; // regex literal
  if (/^(process|env|config|settings|self|this|args|opts)\b/i.test(v)) return false;
  if (/[()]/.test(v)) return false; // function call, not a literal
  if (/\s/.test(v)) return false; // sentence, e.g. a label
  if (looksFake(v)) return false;
  if (quoted) {
    // i18n key such as auth.password.label
    if (/^[A-Za-z]+(?:\.[A-Za-z]+){1,}$/.test(v)) return false;
    return true;
  }
  // Unquoted: skip plain identifiers ("password_input", "state.token").
  if (/^[A-Za-z_][A-Za-z_.]*$/.test(v)) return false;
  return /[0-9!@#$%^&*]/.test(v);
}

function plausibleConnValue(v: string): boolean {
  if (NOT_A_VALUE.has(v.toLowerCase())) return false;
  if (/^[*x.#\u2022\u25cf-]+$/i.test(v)) return false;
  if (/^[$%{<(]/.test(v)) return false;
  if (/^(?:process|env|config|settings)\b/i.test(v) && /[.(]/.test(v)) return false;
  return !looksFake(v);
}

function kvSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(KV_QUOTED)) {
    if (!keyIsSecretName(text, m)) continue;
    const v = m.groups?.v ?? "";
    if (!plausibleValue(v, true, m.groups?.kw ?? "")) continue;
    const start = m.index + m[0].length - 1 - v.length;
    out.push({ start, end: start + v.length, kind: "PASSWORD_VALUE", severity: "secret" });
  }
  for (const m of text.matchAll(KV_UNQUOTED)) {
    if (!keyIsSecretName(text, m)) continue;
    const v = m.groups?.v ?? "";
    if (!plausibleValue(v, false, m.groups?.kw ?? "")) continue;
    const start = m.index + m[0].length - v.length;
    out.push({ start, end: start + v.length, kind: "PASSWORD_VALUE", severity: "secret" });
  }
  for (const m of text.matchAll(CONN_PASSWORD)) {
    const v = m.groups?.v ?? "";
    // 200 characters either side must look like a connection string.
    const ctx = text.slice(Math.max(0, m.index - 200), m.index + m[0].length + 200);
    if (!CONN_CONTEXT.test(ctx)) continue;
    if (!plausibleConnValue(v)) continue;
    const start = m.index + m[0].length - v.length;
    out.push({ start, end: start + v.length, kind: "PASSWORD_VALUE", severity: "secret" });
  }
  return out;
}

function patternSpans(text: string, patterns: Pattern[], severity: Severity): Span[] {
  const out: Span[] = [];
  for (const p of patterns) {
    for (const m of text.matchAll(p.re)) {
      let start = m.index;
      let end = m.index + m[0].length;
      if (p.group !== undefined) {
        const g = m[p.group];
        if (g === undefined) continue;
        start = m.index + m[0].lastIndexOf(g);
        end = start + g.length;
      }
      if (p.skip?.(text.slice(start, end))) continue;
      out.push({ start, end, kind: p.kind, severity });
    }
  }
  return out;
}

const HEX_ONLY = /^[0-9a-fA-F]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DIGEST_LENGTHS = new Set([32, 40, 64, 128]);
/** npm/yarn/SRI integrity hashes are public checksums. */
const INTEGRITY_HASH = /^sha(?:1|256|384|512)-/i;
/** SVG path data: command letters, digits and minus signs only. */
const SVG_PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9-]+$/;
/**
 * One piece of a dash/underscore/slash/plus/equals separated name: a word
 * (lower, UPPER, Capitalised or camelCase) with up to four trailing digits, or
 * a number with up to three trailing letters ("70b", "1px"), or one block of up
 * to eight digits between consistently-cased letters ("a12b", "20AURA").
 */
const CASED = "(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)";
const WORDLIKE_SEGMENT = new RegExp(
  `^(?:(?:[A-Z]?[a-z]+|[A-Z]+)(?:[A-Z][a-z]+)*\\d{0,8}|\\d{1,8}[A-Za-z]{0,3}|${CASED}?\\d{1,8}${CASED}?)$`,
);

/**
 * Identifier-shaped: a snake_case / kebab-case / Tailwind class / path / branch
 * name / env var name. Needs at least two pieces and every piece wordlike.
 * Real random keys have digits and capitals scattered inside the pieces.
 */
function identifierLike(tok: string): boolean {
  const segs = tok.split(/[-_/+=]+/).filter((s) => s.length > 0);
  return segs.length >= 2 && segs.every((s) => WORDLIKE_SEGMENT.test(s));
}

/** Base64 that decodes to readable prose (an embedded test message, not a key). */
function base64OfProse(tok: string): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(tok)) return false;
  const raw = Buffer.from(tok.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length < 12) return false;
  let printable = 0;
  let spaces = 0;
  for (const b of raw) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) printable++;
    if (b === 0x20) spaces++;
  }
  // Prose has spaces; "user:password" (a Basic auth pair) does not and is still flagged.
  return printable / raw.length >= 0.95 && spaces >= 2;
}

function entropySpans(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{20,}/g)) {
    const tok = m[0];
    if (tok.length > MAX_RANDOM_LEN) continue;
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (/base64,$/i.test(before)) continue; // data: URI
    if (UUID.test(tok)) continue;
    if (INTEGRITY_HASH.test(tok)) continue;
    if (SVG_PATH_DATA.test(tok)) continue;
    if (HEX_ONLY.test(tok)) {
      if (DIGEST_LENGTHS.has(tok.length) || tok.length < 24 || !/[a-fA-F]/.test(tok) || !/[0-9]/.test(tok)) continue;
      if (shannonEntropy(tok) >= HEX_ENTROPY_THRESHOLD) {
        out.push({ start: m.index, end: m.index + tok.length, kind: "HIGH_ENTROPY", severity: "secret" });
      }
      continue;
    }
    const classes =
      Number(/[a-z]/.test(tok)) + Number(/[A-Z]/.test(tok)) + Number(/[0-9]/.test(tok)) + Number(/[+/_=-]/.test(tok));
    if (classes < 3 || !/[0-9]/.test(tok)) continue;
    // A path, class list, snake_case name or branch name is not a key.
    if (identifierLike(tok)) continue;
    if (looksFakeKey(tok)) continue;
    if (base64OfProse(tok)) continue;
    if (shannonEntropy(tok) >= ENTROPY_THRESHOLD) {
      out.push({ start: m.index, end: m.index + tok.length, kind: "HIGH_ENTROPY", severity: "secret" });
    }
  }
  return out;
}

export function detectSecrets(text: string): Span[] {
  return [...patternSpans(text, SECRET_PATTERNS, "secret"), ...kvSpans(text), ...entropySpans(text)];
}

/** File extensions that look like a top-level domain: icon@2x.png, foo@bar.ts. */
const FILE_EXTENSION_TLD = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "css", "js", "ts", "tsx", "jsx", "mjs", "cjs", "rs", "md",
  "json", "toml", "yml", "yaml", "html", "txt", "lock", "pdf", "mp4", "woff", "woff2", "map",
]);
/** Role/automation mailboxes that are public by design. */
const PUBLIC_LOCAL_PART = /^(?:git|noreply|no-reply|donotreply)$/i;

function harmlessEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
  return FILE_EXTENSION_TLD.has(tld) || PUBLIC_LOCAL_PART.test(local);
}

/** User names that are placeholders in docs and fixtures, not a private name. */
const GENERIC_USER =
  /^(?:user|users|username|name|you|me|someone|staff|admin|runner|test|tester|example|demo|public|default|x|y|z|a|b|<[^>]*>|%[^%]*%|\$\{?\w+\}?)$/i;

function genericUserPath(p: string): boolean {
  const name = p.split(/[\\/]+/).pop() ?? "";
  return name.length <= 1 || GENERIC_USER.test(name);
}

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const SENSITIVE_PATTERNS: Pattern[] = [
  {
    kind: "INTERNAL_IP",
    re: new RegExp(
      `(?<![\\d.])(?:10\\.${OCTET}\\.${OCTET}\\.${OCTET}|192\\.168\\.${OCTET}\\.${OCTET}|172\\.(?:1[6-9]|2\\d|3[01])\\.${OCTET}\\.${OCTET})(?![\\d])`,
      "g",
    ),
  },
  { kind: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, skip: harmlessEmail },
  // C:\Users\<name>, C:/Users/<name>, C:\\Users\\<name> and /home/<name>, /Users/<name>: the user name is the private part.
  { kind: "USER_PATH", re: /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"'<>|:*?]+/gi, skip: genericUserPath },
  { kind: "USER_PATH", re: /(?<![\w.:])\/(?:home|Users)\/[A-Za-z0-9._-]+/g, skip: genericUserPath },
  // \\server\share (the share starts with a letter or digit, so regex text such as \\frac\{ is not a share)
  { kind: "UNC_PATH", re: /(?<![\\\w])\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$_][^\\\s"'<>|:*?]*/g },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectSensitive(text: string, dictionary: DictionaryTerm[] = []): Span[] {
  const out = patternSpans(text, SENSITIVE_PATTERNS, "sensitive");
  for (const d of dictionary) {
    if (!d.term.trim()) continue;
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(d.term.trim())}(?![A-Za-z0-9_])`, "gi");
    for (const m of text.matchAll(re)) {
      out.push({ start: m.index, end: m.index + m[0].length, kind: d.kind.toUpperCase(), severity: "sensitive" });
    }
  }
  return out;
}

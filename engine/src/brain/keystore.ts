import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the Anthropic API key lives. It is stored encrypted by the operating system, never in
 * settings.json or any plain file, and never returned by any function here except `get()` /
 * `resolve()`, which hand it to the code that is about to send a request.
 *
 * What this protects: other Windows users and anyone who copies the disk (DPAPI, CurrentUser scope).
 * What it does not: a program running as the same signed-in user can ask Windows to decrypt it too.
 */

export const KEY_ENV = "ANTHROPIC_API_KEY";
export const KEY_MIN_CHARS = 20;
export const KEY_MAX_CHARS = 300;
/** Not secret: a fixed extra input that ties the encrypted file to Guard's key use. */
const DPAPI_ENTROPY = "aura-guard:anthropic-api-key:v1";
const KEYCHAIN_SERVICE = "aura-guard-anthropic-api-key";
const KEYCHAIN_ACCOUNT = "aura-guard";
/** A secure-store helper that takes longer than this is stuck. */
const TOOL_TIMEOUT_MS = 20_000;

export const NO_STORE_HELP =
  "This computer has no secure key store Guard can use. Set the ANTHROPIC_API_KEY environment variable instead.";

export class KeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyStoreError";
  }
}

export type StoreName = "dpapi" | "keychain" | "secret-service";

export interface SecretBackend {
  name: StoreName | (string & {});
  /** Can this machine protect a secret right now? */
  available(): Promise<boolean>;
  /** Is something stored? Must not decrypt. Optional: without it the store is asked with get(). */
  exists?(): Promise<boolean>;
  set(secret: string): Promise<void>;
  get(): Promise<string | null>;
  remove(): Promise<void>;
}

// ---- checking and hiding ----

export type KeyCheck = { ok: true; key: string } | { ok: false; error: string };

/** Ends are trimmed (a pasted key often has a newline); anything inside is refused. No prefix is required. */
export function validateApiKey(raw: unknown): KeyCheck {
  if (typeof raw !== "string") return { ok: false, error: "The key must be text." };
  const key = raw.trim();
  if (!key) return { ok: false, error: "Paste the key first." };
  if (/\s/.test(key)) return { ok: false, error: "The key must not contain spaces or line breaks." };
  if (key.length < KEY_MIN_CHARS) return { ok: false, error: `That is too short for an API key (at least ${KEY_MIN_CHARS} characters).` };
  if (key.length > KEY_MAX_CHARS) return { ok: false, error: `That is too long for an API key (at most ${KEY_MAX_CHARS} characters).` };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, error: "The key may only use plain printable characters." };
  return { ok: true, key };
}

/** Anything that looks like an Anthropic key, plus the exact secrets we know about. */
export function scrubSecrets(text: string, known: (string | null | undefined)[] = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 8) out = out.split(k).join("[key]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "[key]");
}

// ---- running a helper program with the secret on stdin ----

interface ToolResult { code: number | null; stdout: Buffer; stderr: string }

/** Argument array, no shell. The secret only ever goes through `input` (stdin). */
function runTool(command: string, args: string[], input?: Buffer): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      reject(new KeyStoreError(`Could not start ${command}.`));
      return;
    }
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new KeyStoreError(`${command} did not answer in time.`)));
    }, TOOL_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => { if (err.length < 2000) err += d.toString("utf8"); });
    child.on("error", () => finish(() => reject(new KeyStoreError(`Could not start ${command}.`))));
    child.on("close", (code) => finish(() => resolve({ code, stdout: Buffer.concat(out), stderr: err })));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function wipe(...bufs: Buffer[]): void {
  for (const b of bufs) b.fill(0);
}

// ---- Windows: DPAPI through PowerShell ----

const PS_ENCRYPT =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
  "$s=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($s);" +
  `$e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}');` +
  "$c=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($c))";
const PS_DECRYPT =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
  "$s=[Console]::In.ReadToEnd().Trim();$c=[Convert]::FromBase64String($s);" +
  `$e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}');` +
  "$b=[Security.Cryptography.ProtectedData]::Unprotect($c,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))";

const psArgs = (script: string): string[] => [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
];

export const DPAPI_FILE = ["secrets", "anthropic.key.dpapi"] as const;

export function dpapiBackend(dataDir: string): SecretBackend {
  const file = join(dataDir, ...DPAPI_FILE);
  let ok: boolean | undefined;
  return {
    name: "dpapi",
    async available() {
      if (process.platform !== "win32") return false;
      if (ok === undefined) {
        try {
          ok = (await runTool("powershell.exe", psArgs("Add-Type -AssemblyName System.Security"))).code === 0;
        } catch {
          ok = false;
        }
      }
      return ok;
    },
    async exists() {
      return existsSync(file);
    },
    async set(secret) {
      const input = Buffer.from(secret, "utf8");
      let r: ToolResult;
      try {
        r = await runTool("powershell.exe", psArgs(PS_ENCRYPT), input);
      } finally {
        wipe(input);
      }
      const cipher = r.stdout.toString("utf8").trim();
      if (r.code !== 0 || !/^[A-Za-z0-9+/=]{16,}$/.test(cipher)) throw new KeyStoreError("Windows could not protect the key.");
      mkdirSync(join(dataDir, DPAPI_FILE[0]), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, cipher, { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, file);
      } catch {
        rmSync(tmp, { force: true });
        throw new KeyStoreError("Guard could not write the protected key file.");
      }
    },
    async get() {
      if (!existsSync(file)) return null;
      const input = Buffer.from(readFileSync(file, "utf8").trim(), "utf8");
      const r = await runTool("powershell.exe", psArgs(PS_DECRYPT), input);
      try {
        if (r.code !== 0 || r.stdout.length === 0) {
          throw new KeyStoreError("Windows could not unlock the stored key. It may belong to another Windows user. Remove it and set it again.");
        }
        return r.stdout.toString("utf8");
      } finally {
        wipe(input, r.stdout);
      }
    },
    async remove() {
      rmSync(file, { force: true });
    },
  };
}

// ---- macOS / Linux: the OS keychain tools, only if present ----

async function toolPresent(command: string, args: string[]): Promise<boolean> {
  try {
    await runTool(command, args);
    return true;
  } catch {
    return false;
  }
}

/** `security -i` reads its commands from stdin, so the key is not on the command line. */
export function keychainBackend(): SecretBackend {
  return {
    name: "keychain",
    available: () => (process.platform === "darwin" ? toolPresent("security", ["help"]) : Promise.resolve(false)),
    async exists() {
      const r = await runTool("security", ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
      return r.code === 0;
    },
    async set(secret) {
      if (/["\\']/.test(secret)) throw new KeyStoreError("The macOS keychain helper cannot take a key with quote marks or backslashes. Use the ANTHROPIC_API_KEY environment variable.");
      const line = Buffer.from(`add-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -U -w "${secret}"\n`, "utf8");
      let r: ToolResult;
      try {
        r = await runTool("security", ["-i"], line);
      } finally {
        wipe(line);
      }
      if (r.code !== 0) throw new KeyStoreError("The macOS keychain refused the key.");
    },
    async get() {
      const r = await runTool("security", ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"]);
      try {
        return r.code === 0 ? r.stdout.toString("utf8").trim() || null : null;
      } finally {
        wipe(r.stdout);
      }
    },
    async remove() {
      await runTool("security", ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
    },
  };
}

/** `secret-tool store` reads the secret from stdin. */
export function secretServiceBackend(): SecretBackend {
  const attrs = ["service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT];
  return {
    name: "secret-service",
    available: () => (process.platform === "linux" ? toolPresent("secret-tool", ["--version"]) : Promise.resolve(false)),
    async exists() {
      return (await this.get()) !== null;
    },
    async set(secret) {
      const input = Buffer.from(secret, "utf8");
      let r: ToolResult;
      try {
        r = await runTool("secret-tool", ["store", "--label=SPIL Guard Anthropic API key", ...attrs], input);
      } finally {
        wipe(input);
      }
      if (r.code !== 0) throw new KeyStoreError("The system secret service refused the key.");
    },
    async get() {
      const r = await runTool("secret-tool", ["lookup", ...attrs]);
      try {
        return r.code === 0 ? r.stdout.toString("utf8").trim() || null : null;
      } finally {
        wipe(r.stdout);
      }
    },
    async remove() {
      await runTool("secret-tool", ["clear", ...attrs]);
    },
  };
}

/** The store for this operating system. It may turn out to be unavailable; check `available()`. */
export function defaultSecretBackend(dataDir: string, platform: string = process.platform): SecretBackend {
  if (platform === "win32") return dpapiBackend(dataDir);
  if (platform === "darwin") return keychainBackend();
  return secretServiceBackend();
}

// ---- the store the rest of Guard uses ----

export interface KeyStatus {
  source: "env" | "stored" | null;
  /** The secure store that holds the key; null when the key comes from the environment or there is none. */
  backend: StoreName | null;
}

export interface KeyStore {
  status(): Promise<KeyStatus>;
  /** The key to use right now (environment first, then the stored one). The caller must not keep or log it. */
  resolve(): Promise<{ key: string; source: "env" | "stored" } | null>;
  hasStored(): Promise<boolean>;
  /** Name of this computer's secure store when it works; null when it has none. */
  storage(): Promise<StoreName | null>;
  set(key: string): Promise<void>;
  remove(): Promise<void>;
  /** The environment key and the stored key, for hiding them in error text. */
  secretsForScrub(): Promise<string[]>;
}

export interface KeyStoreOptions {
  dataDir: string;
  env?: Record<string, string | undefined>;
  backend?: SecretBackend;
}

export function createKeyStore(o: KeyStoreOptions): KeyStore {
  const env = o.env ?? process.env;
  const backend = o.backend ?? defaultSecretBackend(o.dataDir);
  const envKey = (): string | undefined => {
    const v = env[KEY_ENV]?.trim();
    return v ? v : undefined;
  };
  const hasStored = async (): Promise<boolean> => {
    try {
      if (backend.exists) return await backend.exists();
      return (await backend.get()) !== null;
    } catch {
      return false;
    }
  };
  const store: KeyStore = {
    hasStored,
    async storage() {
      return (await backend.available()) ? (backend.name as StoreName) : null;
    },
    async status() {
      if (envKey()) return { source: "env", backend: null };
      if (await hasStored()) return { source: "stored", backend: backend.name as StoreName };
      return { source: null, backend: null };
    },
    async resolve() {
      const e = envKey();
      if (e) return { key: e, source: "env" };
      if (!(await hasStored())) return null;
      try {
        const k = await backend.get();
        return k ? { key: k, source: "stored" } : null;
      } catch (err) {
        throw new KeyStoreError(scrubSecrets((err as Error).message));
      }
    },
    async set(key) {
      const v = validateApiKey(key);
      if (!v.ok) throw new KeyStoreError(v.error);
      if (!(await backend.available())) throw new KeyStoreError(NO_STORE_HELP);
      try {
        await backend.set(v.key);
      } catch (err) {
        throw new KeyStoreError(scrubSecrets((err as Error).message, [v.key]));
      }
    },
    async remove() {
      try {
        await backend.remove();
      } catch (err) {
        throw new KeyStoreError(scrubSecrets((err as Error).message));
      }
    },
    async secretsForScrub() {
      const list: string[] = [];
      const e = envKey();
      if (e) list.push(e);
      try {
        if (await hasStored()) {
          const k = await backend.get();
          if (k) list.push(k);
        }
      } catch { /* nothing to hide */ }
      return list;
    },
  };
  return store;
}

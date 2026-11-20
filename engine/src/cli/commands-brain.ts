// `brain backend | model | models | key ...`: choose the model and keep the API key.
// The key is read from STDIN or a hidden prompt, never from the command line, and is never printed.

import type { GuardConfig } from "../types.ts";
import { BUILTIN_MODELS, loadCatalogue, validateModelId } from "../brain/models.ts";
import { MODEL_BACKENDS } from "../brain/models.ts";
import { createKeyStore, KeyStoreError, NO_STORE_HELP, scrubSecrets, validateApiKey } from "../brain/keystore.ts";
import type { SecretBackend } from "../brain/keystore.ts";
import { BACKEND_CHOICES, effectiveBrain, machineDataDir, updateSettings } from "../brain/settings.ts";

/** Subcommands this module handles. `status` and `test` stay in main.ts. */
export const BRAIN_SETTINGS_SUBS = ["backend", "model", "models", "key"] as const;

/** The lines to add to the help text (see copy.ts). */
export const BRAIN_SETTINGS_HELP = [
  "  brain models                List the models you can choose",
  "  brain backend <auto|anthropic-api|claude-cli>   Choose where model calls go",
  "  brain model <backend> <id>  Choose the model for a backend (a listed name, or your own)",
  "  brain key set               Save the Anthropic API key (read from stdin or a hidden prompt)",
  "  brain key status | remove   Where the key comes from / delete the saved key",
];

export interface BrainSettingsContext {
  /** rest[0] is the subcommand; the rest are its arguments. */
  rest: string[];
  out: (s: string) => void;
  cfg: GuardConfig;
  env?: Record<string, string | undefined>;
  /** Replaces the OS secure store (tests). */
  secrets?: SecretBackend;
  /** Replaces the hidden prompt / stdin read (tests). */
  readSecret?: () => Promise<string>;
}

/** Reads one secret: all of stdin when piped, a prompt with no echo on a terminal. */
export async function readSecretInput(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  process.stderr.write("API key (typing is hidden): ");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (fn: () => void): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const usage = (out: (s: string) => void, line: string): number => {
  out(`Usage: ${line}`);
  return 2;
};

/** Returns the exit code. */
export async function runBrainSettings(sub: string | undefined, ctx: BrainSettingsContext): Promise<number> {
  const { out, cfg } = ctx;
  const args = ctx.rest.slice(1);
  const dir = machineDataDir(cfg);
  const keys = (): ReturnType<typeof createKeyStore> =>
    createKeyStore({ dataDir: dir, ...(ctx.env ? { env: ctx.env } : {}), ...(ctx.secrets ? { backend: ctx.secrets } : {}) });

  if (sub === "models") {
    const eff = effectiveBrain(cfg, ctx.env);
    const list = loadCatalogue(cfg.root);
    for (const b of MODEL_BACKENDS) {
      out(`${b}  (now: ${eff.models[b].id}, from ${eff.models[b].source})`);
      for (const m of list.filter((x) => x.backends.includes(b))) {
        out(`  ${m.id.padEnd(20)} ${m.label}: ${m.note}${m.id === eff.models[b].id ? "  [in use]" : ""}`);
      }
    }
    out("You can also type any other model name that your key or plan can use.");
    return 0;
  }

  if (sub === "backend") {
    const v = args[0];
    if (!v) return usage(out, `brain backend <${BACKEND_CHOICES.join("|")}>`);
    const r = updateSettings(dir, { backend: v });
    if (!r.ok) {
      out(r.error);
      return 2;
    }
    const eff = effectiveBrain(cfg, ctx.env);
    out(`Backend set to ${v}.`);
    if (eff.backendSource === "env") out(`Note: the environment (QSB_BRAIN or AURA_GUARD_BRAIN) is set to ${eff.backend} and wins over this setting.`);
    return 0;
  }

  if (sub === "model") {
    const backend = args[0];
    const id = args[1];
    if (!backend || !id) return usage(out, "brain model <anthropic-api|claude-cli> <model name>");
    if (!(MODEL_BACKENDS as readonly string[]).includes(backend)) {
      out(`Unknown backend "${backend.slice(0, 40)}". Use ${MODEL_BACKENDS.join(" or ")}.`);
      return 2;
    }
    const v = validateModelId(id);
    if (!v.ok) {
      out(v.error);
      return 2;
    }
    const r = updateSettings(dir, { models: { [backend]: v.id } });
    if (!r.ok) {
      out(r.error);
      return 2;
    }
    out(`Model for ${backend} set to ${v.id}.`);
    if (!BUILTIN_MODELS.concat(loadCatalogue(cfg.root)).some((m) => m.id === v.id)) out("That name is not in the list. It is saved as given; run `brain test` to check it works.");
    const eff = effectiveBrain(cfg, ctx.env);
    if (eff.models[backend as "anthropic-api" | "claude-cli"].source === "env") out("Note: an environment variable sets this model and wins over this setting.");
    return 0;
  }

  if (sub === "key") {
    const action = args[0];
    if (action === "status") {
      const store = keys();
      const st = await store.status();
      if (st.source === "env") out("API key: set by the ANTHROPIC_API_KEY environment variable (it wins over a saved key).");
      else if (st.source === "stored") out(`API key: saved on this computer (protected by ${st.backend}).`);
      else out("API key: none.");
      const where = await store.storage();
      out(where ? `Secure storage: ${where}.` : NO_STORE_HELP);
      return 0;
    }
    if (action === "remove") {
      try {
        await keys().remove();
      } catch (e) {
        out(e instanceof KeyStoreError ? e.message : "Could not remove the saved key.");
        return 1;
      }
      out("The saved API key was removed.");
      if ((await keys().status()).source === "env") out("The ANTHROPIC_API_KEY environment variable is still set.");
      return 0;
    }
    if (action === "set") {
      const store = keys();
      if (!(await store.storage())) {
        out(NO_STORE_HELP);
        return 1;
      }
      let raw: string;
      try {
        raw = await (ctx.readSecret ?? readSecretInput)();
      } catch {
        out("No key was read.");
        return 1;
      }
      const v = validateApiKey(raw);
      if (!v.ok) {
        out(v.error);
        return 2;
      }
      try {
        await store.set(v.key);
      } catch (e) {
        out(e instanceof KeyStoreError ? scrubSecrets(e.message, [v.key]) : "Could not save the key.");
        return 1;
      }
      out("The API key was saved, encrypted for your user account on this computer.");
      if ((await store.status()).source === "env") out("The ANTHROPIC_API_KEY environment variable is also set and is used instead.");
      return 0;
    }
    return usage(out, "brain key <set|remove|status>   (for set, pipe the key in or type it at the hidden prompt; never put it on the command line)");
  }

  return usage(out, "brain <status|test|models|backend|model|key>");
}

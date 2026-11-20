// "Model & API key" screen. Two halves in one file so the screen stays one module:
//  1. Pure logic (importable in Node): validation, wording, lock rules, the state reducer and a
//     controller that talks to /api/brain through an injected fetch.
//  2. mountSettings(): builds and paints the DOM. It only touches `document` when called.
// The API key is never kept: the controller receives it as an argument, puts it in one request body,
// and nothing here stores, renders or logs it. Error text from the server is shown as plain text.

export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
export const KEY_MIN = 20;
export const KEY_MAX = 300;
export const BACKEND_IDS = ["anthropic-api", "claude-cli"];

/** A model name typed by hand. The server checks it again. */
export function validateModelId(raw) {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return { ok: false, error: "Type a model name first." };
  if (v.length > 80) return { ok: false, error: "A model name is at most 80 characters." };
  if (!MODEL_RE.test(v)) return { ok: false, error: "Use only letters, digits and . _ : - and start with a letter or digit." };
  return { ok: true, value: v };
}

/** Checks the shape of a key without ever repeating it in a message. */
export function validateKeyInput(raw) {
  const v = typeof raw === "string" ? raw : "";
  if (!v) return { ok: false, error: "Paste your key first." };
  if (/\s/.test(v)) return { ok: false, error: "A key has no spaces or line breaks. Paste it again without them." };
  if (v.length < KEY_MIN) return { ok: false, error: "That is too short to be a key." };
  if (v.length > KEY_MAX) return { ok: false, error: "That is too long to be a key." };
  if (!/^[\x21-\x7e]+$/.test(v)) return { ok: false, error: "A key uses only plain letters, digits and symbols." };
  return { ok: true };
}

const SOURCE_WORDS = { env: "from the environment", settings: "saved here", config: "from the config file", default: "default" };
export function sourceLabel(src) {
  return SOURCE_WORDS[src] || "default";
}

/** Which controls cannot be changed on screen, and why. */
export function locks(view) {
  const out = { backend: false, models: { "anthropic-api": false, "claude-cli": false } };
  if (!view) return out;
  out.backend = view.wantedSource === "env";
  for (const b of BACKEND_IDS) out.models[b] = view.models?.sources?.[b] === "env";
  return out;
}

export function keyStatusText(apiKey) {
  if (!apiKey || !apiKey.source) return "No key saved";
  if (apiKey.source === "env") return "Using the ANTHROPIC_API_KEY environment variable";
  if (apiKey.storage === "dpapi") return "Saved on this computer (encrypted by Windows)";
  if (apiKey.storage === "keychain") return "Saved on this computer (in the macOS Keychain)";
  if (apiKey.storage === "secret-service") return "Saved on this computer (in the system keyring)";
  return "Saved on this computer";
}

export function protectionText(apiKey) {
  const tail = "It protects the key from other users and from a copied disk, not from programs already running as you.";
  if (apiKey?.storage === "keychain") return `Kept in the macOS Keychain for your account only. ${tail}`;
  if (apiKey?.storage === "secret-service") return `Kept in the system keyring for your account only. ${tail}`;
  return `Encrypted for your Windows account only. ${tail}`;
}

export const NO_STORE_TEXT = "This computer has no secure place to keep a key, so AURA QA will not save it. Set the ANTHROPIC_API_KEY environment variable instead, then restart AURA QA.";

/** The catalogue entries that apply to one backend. */
export function modelsFor(view, backend) {
  return (view?.models?.catalogue || []).filter((m) => Array.isArray(m.backends) && m.backends.includes(backend));
}

export function backendLabel(view, id) {
  return (view?.backends || []).find((b) => b.id === id)?.label || id || "";
}

export function formatSeconds(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/** What the screen shows for a pending choice, before the server confirms it. */
export function applyPatch(view, patch) {
  if (!view) return view;
  const next = { ...view, models: { ...view.models, current: { ...view.models.current }, sources: { ...view.models.sources } } };
  if (patch.backend) {
    next.wanted = patch.backend;
    next.wantedSource = "settings";
  }
  for (const [b, id] of Object.entries(patch.models || {})) {
    const def = modelsFor(view, b).find((m) => m.default)?.id;
    next.models.current[b] = id === null ? def || next.models.current[b] : id;
    next.models.sources[b] = id === null ? "default" : "settings";
  }
  return next;
}

export const initialState = () => ({
  phase: "loading", // loading | ready | error
  view: null,
  error: "",
  saving: false,
  notice: null, // { kind: "ok" | "error", text }
  keyBusy: false,
  keyStoredBehindEnv: false,
  test: { status: "idle", result: null, error: "" }, // idle | running | done | error
});

export function reduce(s, a) {
  switch (a.type) {
    case "load-start": return { ...s, phase: s.view ? s.phase : "loading", error: "" };
    case "loaded": return { ...s, phase: "ready", view: a.view, error: "" };
    case "load-failed": return { ...s, phase: s.view ? "ready" : "error", error: a.error };
    case "save-start": return { ...s, saving: true, view: a.optimistic, notice: null };
    case "save-ok": return { ...s, saving: false, view: a.view, notice: { kind: "ok", text: a.text || "Saved." } };
    case "save-failed": return { ...s, saving: false, view: a.revertTo, notice: { kind: "error", text: a.error } };
    case "key-start": return { ...s, keyBusy: true, notice: null };
    case "key-saved": return { ...s, keyBusy: false, view: a.view, keyStoredBehindEnv: !!a.behindEnv, notice: { kind: "ok", text: a.text || "Saved. The key is kept on this computer and is not shown again." } };
    case "key-removed": return { ...s, keyBusy: false, view: a.view, keyStoredBehindEnv: false, notice: { kind: "ok", text: "Key removed." } };
    case "key-failed": return { ...s, keyBusy: false, notice: { kind: "error", text: a.error } };
    case "test-start": return { ...s, test: { status: "running", result: null, error: "" } };
    case "test-done": return { ...s, test: { status: "done", result: a.result, error: "" } };
    case "test-failed": return { ...s, test: { status: "error", result: null, error: a.error } };
    case "dismiss-notice": return { ...s, notice: null };
    default: return s;
  }
}

const OFFLINE = "Could not reach AURA QA. Check that it is still running, then try again.";

/** Talks to the API and feeds the reducer. `fetchImpl` is injectable for tests. */
export function createController({ fetchImpl, onChange }) {
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  let state = initialState();
  let pending = null;
  const emit = (a) => {
    state = reduce(state, a);
    onChange(state);
  };
  async function call(path, method, body) {
    try {
      const init = { method, headers: { Accept: "application/json" }, cache: "no-store" };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const r = await f(path, init);
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: data && typeof data === "object" ? data : {} };
    } catch {
      return { ok: false, status: 0, data: { error: OFFLINE } };
    }
  }
  const errText = (r) => (typeof r.data.error === "string" && r.data.error ? r.data.error : `That did not work (${r.status || "no answer"}).`);

  async function load() {
    emit({ type: "load-start" });
    const r = await call("/api/brain", "GET");
    if (r.ok && r.data.backends) emit({ type: "loaded", view: r.data });
    else emit({ type: "load-failed", error: errText(r) });
  }

  /** patch: { backend? , models? }. Changes made while a save runs are merged and sent next. */
  async function save(patch) {
    if (!state.view) return;
    if (state.saving) {
      pending = { backend: patch.backend ?? pending?.backend, models: { ...(pending?.models || {}), ...(patch.models || {}) } };
      state = { ...state, view: applyPatch(state.view, pending) };
      onChange(state);
      return;
    }
    const before = state.view;
    emit({ type: "save-start", optimistic: applyPatch(before, patch) });
    const body = {};
    if (patch.backend) body.backend = patch.backend;
    if (patch.models) body.models = patch.models;
    const r = await call("/api/brain", "PUT", body);
    if (r.ok && r.data.backends) emit({ type: "save-ok", view: r.data });
    else emit({ type: "save-failed", revertTo: before, error: errText(r) });
    if (pending) {
      const p = pending;
      pending = null;
      const clean = {};
      if (p.backend) clean.backend = p.backend;
      if (Object.keys(p.models || {}).length) clean.models = p.models;
      if (Object.keys(clean).length) await save(clean);
    }
  }

  /** The key goes into this one request body and nowhere else. It is not stored on `state`. */
  async function saveKey(key) {
    if (state.keyBusy) return false;
    const v = validateKeyInput(key);
    if (!v.ok) {
      emit({ type: "key-failed", error: v.error });
      return false;
    }
    emit({ type: "key-start" });
    const r = await call("/api/brain/key", "PUT", { key });
    if (!r.ok) {
      emit({ type: "key-failed", error: errText(r) });
      return false;
    }
    const fresh = await call("/api/brain", "GET");
    emit({ type: "key-saved", view: fresh.ok && fresh.data.backends ? fresh.data : state.view, behindEnv: r.data.source === "env", text: typeof r.data.message === "string" ? r.data.message : undefined });
    return true;
  }

  async function removeKey() {
    if (state.keyBusy) return;
    emit({ type: "key-start" });
    const r = await call("/api/brain/key", "DELETE");
    if (!r.ok) return emit({ type: "key-failed", error: errText(r) });
    const fresh = await call("/api/brain", "GET");
    emit({ type: "key-removed", view: fresh.ok && fresh.data.backends ? fresh.data : state.view });
  }

  async function runTest() {
    if (state.test.status === "running") return;
    emit({ type: "test-start" });
    const r = await call("/api/brain/test", "POST", {});
    if (r.status === 409) return emit({ type: "test-failed", error: "A test is already running. Wait for it to finish." });
    if (r.ok && typeof r.data.ok === "boolean") emit({ type: "test-done", result: r.data });
    else emit({ type: "test-failed", error: errText(r) });
  }

  return { load, save, saveKey, removeKey, runTest, get state() { return state; }, dismiss: () => emit({ type: "dismiss-notice" }) };
}

/* ------------------------------------------------------------------ DOM ------------------------------------------------------------------ */

const NS = "http://www.w3.org/2000/svg";
const ICON = {
  check: "m5.5 12.5 4 4 9-9",
  cpu: "M8 8h8v8H8V8Zm2-4v4m4-4v4m-4 8v4m4-4v4M4 10h4m-4 4h4m8-4h4m-4 4h4",
  key: "M8 11.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10.5 13 19 4.5M16 7.5l2.5 2.5",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  shield: "M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-2.5Zm-2.5 8.5 2 2 3.5-4",
  back: "M10 6l-6 6 6 6M4 12h16",
};
function icon(d, cls = "i") {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", cls);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.6");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  s.appendChild(p);
  return s;
}
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Builds the screen inside `root` (the <main id="view-settings"> element). Returns { show, hide, ctl }. */
export function mountSettings({ root, onBack, fetchImpl }) {
  let armed = false;
  let armTimer = 0;
  let armedBackend = "";
  const customDraft = { "anthropic-api": "", "claude-cli": "" };
  const customError = { "anthropic-api": "", "claude-cli": "" };
  let keyError = "";

  const ctl = createController({ fetchImpl, onChange: (s) => paint(s) });

  /* skeleton, built once so inputs keep their text and focus between paints */
  root.replaceChildren();
  const top = h("header", "topbar");
  const back = h("button", "btn st-back");
  back.type = "button";
  back.append(icon(ICON.back), h("span", "", "Back"));
  back.title = "Back (Esc)";
  const title = h("h1", "chat-title", "Model & API key");
  top.append(back, title);
  const scroll = h("div", "scroll st-scroll");
  scroll.tabIndex = -1;
  const wrap = h("div", "st-wrap");
  scroll.appendChild(wrap);
  root.append(top, scroll);

  const intro = h("div", "st-intro");
  intro.append(h("p", "st-lede", "Choose where Claude answers come from and which model to use."), h("p", "st-scope", "These settings are for this whole computer."));
  const banner = h("div", "st-banner");
  banner.setAttribute("role", "alert");
  banner.hidden = true;
  const live = h("div", "st-live");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  const body = h("div", "st-body");
  wrap.append(intro, banner, live, body);

  /* persistent key input */
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.id = "st-key";
  keyInput.className = "field st-key-input";
  keyInput.setAttribute("autocomplete", "off");
  keyInput.setAttribute("autocapitalize", "off");
  keyInput.setAttribute("autocorrect", "off");
  keyInput.setAttribute("inputmode", "none");
  keyInput.setAttribute("data-lpignore", "true");
  keyInput.setAttribute("data-1p-ignore", "true");
  keyInput.spellcheck = false;
  keyInput.maxLength = 400;
  keyInput.placeholder = "Paste your Anthropic API key";

  const customInputs = {};
  for (const b of BACKEND_IDS) {
    const i = document.createElement("input");
    i.type = "text";
    i.className = "field st-custom-input";
    i.id = `st-custom-${b}`;
    i.setAttribute("autocomplete", "off");
    i.spellcheck = false;
    i.maxLength = 120;
    i.placeholder = "For example claude-sonnet-5-5";
    i.addEventListener("input", () => {
      customDraft[b] = i.value;
      customError[b] = "";
      const e = body.querySelector(`[data-err="${b}"]`);
      if (e) e.textContent = "";
    });
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        useCustom(b);
      }
    });
    customInputs[b] = i;
  }
  keyInput.addEventListener("input", () => {
    keyError = "";
    const e = body.querySelector("[data-key-err]");
    if (e) e.textContent = "";
    const sv = body.querySelector("[data-key-save]");
    if (sv) sv.disabled = ctl.state.keyBusy || !validateKeyInput(keyInput.value).ok;
  });
  keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitKey();
    }
  });

  function useCustom(b) {
    const v = validateModelId(customInputs[b].value);
    if (!v.ok) {
      customError[b] = v.error;
      const e = body.querySelector(`[data-err="${b}"]`);
      if (e) e.textContent = v.error;
      customInputs[b].setAttribute("aria-invalid", "true");
      return;
    }
    customInputs[b].removeAttribute("aria-invalid");
    customInputs[b].value = "";
    customDraft[b] = "";
    ctl.save({ models: { [b]: v.value } });
  }

  async function submitKey() {
    const value = keyInput.value;
    const v = validateKeyInput(value);
    if (!v.ok) {
      keyError = v.error;
      keyInput.setAttribute("aria-invalid", "true");
      const e = body.querySelector("[data-key-err]");
      if (e) e.textContent = v.error;
      return;
    }
    if (ctl.state.keyBusy) return;
    keyInput.removeAttribute("aria-invalid");
    keyInput.value = ""; // cleared before the request goes out: the key lives only in this local variable
    keyError = "";
    await ctl.saveKey(value);
  }

  function disarm() {
    armed = false;
    clearTimeout(armTimer);
  }

  function section(titleText, sub, iconPath) {
    const sec = h("section", "st-card");
    const head = h("header", "st-card-head");
    const ic = h("span", "st-card-icon");
    ic.appendChild(icon(iconPath));
    const t = h("div", "st-card-titles");
    const hid = "st-h-" + titleText.toLowerCase().replace(/[^a-z]+/g, "-");
    const hh = h("h2", "st-card-title", titleText);
    hh.id = hid;
    t.appendChild(hh);
    if (sub) t.appendChild(h("p", "st-card-sub", sub));
    head.append(ic, t);
    sec.setAttribute("aria-labelledby", hid);
    sec.appendChild(head);
    return sec;
  }

  function chip(text, kind) {
    return h("span", `st-chip st-chip-${kind}`, text);
  }

  function lockNote(text) {
    const n = h("p", "st-lock");
    n.append(icon("M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6v-9Z", "i st-lock-i"), h("span", "", text));
    return n;
  }

  function radioGroup(label, items, current, locked, onPick, grid = false) {
    const g = h("div", "st-radios" + (grid ? " st-grid" : ""));
    g.setAttribute("role", "radiogroup");
    g.setAttribute("aria-label", label);
    const sel = items.findIndex((x) => x.id === current);
    items.forEach((it, i) => {
      const on = i === sel;
      const b = h("button", "st-radio" + (on ? " on" : "") + (it.className ? " " + it.className : ""));
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(on));
      b.dataset.k = it.id;
      b.tabIndex = on || (sel < 0 && i === 0) ? 0 : -1;
      if (locked) b.setAttribute("aria-disabled", "true");
      const dot = h("span", "st-dot");
      dot.setAttribute("aria-hidden", "true");
      const txt = h("span", "st-radio-text");
      txt.appendChild(h("span", "st-radio-label", it.label));
      if (it.note) txt.appendChild(h("span", "st-radio-note", it.note));
      if (it.extra) txt.appendChild(it.extra);
      b.append(dot, txt);
      if (it.badges?.length) {
        const bw = h("span", "st-radio-badges");
        for (const x of it.badges) bw.appendChild(x);
        b.appendChild(bw);
      }
      b.addEventListener("click", () => {
        if (!locked && !on) onPick(it.id);
      });
      g.appendChild(b);
    });
    g.addEventListener("keydown", (e) => {
      const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const all = [...g.querySelectorAll(".st-radio")];
      const at = all.indexOf(document.activeElement);
      const to = all[(at + keys[e.key] + all.length) % all.length];
      if (!to) return;
      to.focus();
      if (!locked) to.click();
    });
    return g;
  }

  function backendSection(s) {
    const v = s.view;
    const lk = locks(v);
    const sec = section("Where do answers come from?", null, ICON.cpu);
    const blurb = {
      auto: "Uses your API key if there is one, otherwise your Claude plan.",
      "claude-cli": "",
      "anthropic-api": "",
    };
    const items = v.backends.map((b) => {
      const inUse = v.picked === b.id || (b.id === "auto" && v.wanted === "auto");
      const badges = [chip(b.available ? "Ready" : "Not set up", b.available ? "ok" : "warn")];
      const extra = h("span", "st-radio-detail");
      extra.textContent = b.detail || "";
      const note = blurb[b.id] || "";
      if (b.id === "auto" && v.picked) extra.textContent = [note, b.detail].filter(Boolean).join(" ");
      if (b.id === "auto" && !v.picked) extra.textContent = [note, b.detail].filter(Boolean).join(" ");
      if (b.id !== "auto" && v.picked === b.id) badges.push(chip("In use", "use"));
      return { id: b.id, label: b.label === "Automatic" || b.id === "auto" ? "Automatic" : b.label, extra, badges, className: inUse && b.id !== "auto" ? "is-use" : "" };
    });
    sec.appendChild(radioGroup("Where answers come from", items, v.wanted, lk.backend || s.saving, (id) => ctl.save({ backend: id })));
    const use = h("p", "st-inuse");
    use.append(h("strong", "", v.picked ? "In use now" : "Nothing is ready"), h("span", "", v.reason));
    sec.appendChild(use);
    if (v.problem) sec.appendChild(h("p", "st-problem", v.problem));
    if (lk.backend) sec.appendChild(lockNote("Set by an environment variable on this computer. Change it there to pick a different source."));
    return sec;
  }

  function modelBlock(s, b) {
    const v = s.view;
    const lk = locks(v).models[b.id];
    const cat = modelsFor(v, b.id);
    const cur = v.models.current[b.id];
    const inCat = cat.some((m) => m.id === cur);
    const src = v.models.sources[b.id];
    const blk = h("div", "st-model");
    const head = h("div", "st-model-head");
    head.appendChild(h("h3", "st-model-title", b.label));
    head.appendChild(chip(`Source: ${sourceLabel(src)}`, src === "env" ? "warn" : "plain"));
    blk.appendChild(head);
    const items = cat.map((m) => ({ id: m.id, label: m.label, note: m.note, badges: m.default ? [chip("Default", "plain")] : [] }));
    if (!inCat && cur) items.push({ id: cur, label: cur, note: "A model name you chose yourself.", badges: [chip("Custom", "plain")] });
    blk.appendChild(radioGroup(`Model for ${b.label}`, items, cur, lk || s.saving, (id) => ctl.save({ models: { [b.id]: id } }), true));
    if (lk) {
      blk.appendChild(lockNote("Set by an environment variable on this computer."));
      return blk;
    }
    const row = h("div", "st-custom");
    const lab = h("label", "st-label", "Use another model name");
    lab.htmlFor = customInputs[b.id].id;
    const line = h("div", "st-line");
    const use = h("button", "btn st-use", "Use this name");
    use.type = "button";
    use.disabled = s.saving;
    use.addEventListener("click", () => useCustom(b.id));
    const reset = h("button", "btn st-reset", "Reset to default");
    reset.type = "button";
    reset.disabled = s.saving || src === "default";
    reset.addEventListener("click", () => ctl.save({ models: { [b.id]: null } }));
    customInputs[b.id].setAttribute("aria-describedby", `st-err-${b.id}`);
    line.append(customInputs[b.id], use, reset);
    const err = h("p", "st-err", customError[b.id]);
    err.id = `st-err-${b.id}`;
    err.dataset.err = b.id;
    row.append(lab, line, err);
    blk.appendChild(row);
    return blk;
  }

  function modelSection(s) {
    const sec = section("Model", "Each way of answering keeps its own model.", ICON.sliders);
    for (const b of s.view.backends.filter((x) => x.id !== "auto")) sec.appendChild(modelBlock(s, b));
    return sec;
  }

  function keySection(s) {
    const v = s.view;
    const k = v.apiKey || {};
    const sec = section("API key", null, ICON.key);
    const status = h("p", "st-keystatus");
    const dotk = h("span", "st-state " + (k.source ? "ok" : "off"));
    dotk.setAttribute("aria-hidden", "true");
    status.append(dotk, h("span", "", keyStatusText(k)));
    sec.appendChild(status);
    if (s.keyStoredBehindEnv && k.source === "env") sec.appendChild(h("p", "st-card-sub", "A key is also saved here, but the environment variable is used first."));
    if (!k.canStore) {
      sec.appendChild(h("p", "st-problem", NO_STORE_TEXT));
      keyInput.disabled = true;
    } else keyInput.disabled = s.keyBusy;
    const lab = h("label", "st-label", "Anthropic API key");
    lab.htmlFor = "st-key";
    const line = h("div", "st-line");
    const save = h("button", "btn btn-primary st-save", s.keyBusy ? "Saving..." : "Save key");
    save.type = "button";
    save.dataset.keySave = "1";
    save.disabled = !k.canStore || s.keyBusy || !validateKeyInput(keyInput.value).ok;
    save.addEventListener("click", submitKey);
    line.append(keyInput, save);
    keyInput.setAttribute("aria-describedby", "st-key-err st-key-help");
    const err = h("p", "st-err", keyError);
    err.id = "st-key-err";
    err.dataset.keyErr = "1";
    const help = h("p", "st-help", "Paste it here once. AURA QA encrypts it and never shows it again, not even part of it.");
    help.id = "st-key-help";
    sec.append(lab, line, err, help);
    const canRemove = k.source === "stored" || s.keyStoredBehindEnv;
    if (canRemove) {
      const row = h("div", "st-line st-remove");
      const rm = h("button", "btn btn-danger" + (armed ? " armed" : ""), armed ? "Yes, remove the saved key" : "Remove saved key");
      rm.type = "button";
      rm.disabled = s.keyBusy;
      rm.dataset.remove = "1";
      rm.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          clearTimeout(armTimer);
          armTimer = setTimeout(() => {
            armed = false;
            paint(ctl.state);
          }, 6000);
          paint(ctl.state);
          body.querySelector("[data-remove]")?.focus();
          return;
        }
        disarm();
        await ctl.removeKey();
      });
      row.appendChild(rm);
      if (armed) {
        const cancel = h("button", "btn", "Keep it");
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          disarm();
          paint(ctl.state);
        });
        row.appendChild(cancel);
      }
      sec.appendChild(row);
    }
    const prot = h("p", "st-protect");
    prot.append(icon(ICON.shield, "i st-protect-i"), h("span", "", protectionText(k)));
    const strong = h("strong", "", "How it is protected. ");
    prot.lastChild.prepend(strong);
    sec.appendChild(prot);
    return sec;
  }

  function planSection(s) {
    const p = s.view.planCli || { found: false };
    const sec = section("Claude plan", "Uses the Claude Code program on this computer and your Claude subscription.", ICON.cpu);
    const row = h("p", "st-keystatus");
    const dotk = h("span", "st-state " + (p.found ? "ok" : "off"));
    dotk.setAttribute("aria-hidden", "true");
    row.append(dotk, h("span", "", p.found ? `Claude Code found${p.version ? `, version ${p.version}` : ""}` : "Claude Code was not found"));
    sec.appendChild(row);
    if (!p.found) {
      const steps = h("ol", "st-steps");
      for (const t of ["Install Claude Code.", "Open a terminal and run claude once.", "Sign in when it asks, then come back and test the connection."]) steps.appendChild(h("li", "", t));
      sec.appendChild(steps);
    }
    if (p.help) sec.appendChild(h("p", "st-help", p.help));
    return sec;
  }

  function testSection(s) {
    const t = s.test;
    const sec = section("Test the connection", "Sends one tiny question through whatever is in use now.", ICON.check);
    const line = h("div", "st-line");
    const bt = h("button", "btn btn-primary st-test", t.status === "running" ? "Testing..." : "Test the connection");
    bt.type = "button";
    bt.disabled = t.status === "running";
    bt.dataset.test = "1";
    if (t.status === "running") bt.setAttribute("aria-busy", "true");
    bt.addEventListener("click", () => ctl.runTest());
    line.appendChild(bt);
    sec.appendChild(line);
    const out = h("div", "st-result st-result-" + (t.status === "done" ? (t.result.ok ? "ok" : "bad") : t.status === "error" ? "bad" : t.status === "running" ? "run" : "idle"));
    if (t.status === "running") {
      out.append(h("span", "st-spin"), h("span", "", "Waiting for the model to answer..."));
    } else if (t.status === "done") {
      const r = t.result;
      if (r.ok) {
        const lines = h("div", "st-result-body");
        lines.appendChild(h("strong", "", "It works."));
        lines.appendChild(h("span", "", `${backendLabel(s.view, r.backend)}, model ${r.model || "unknown"}, answered in ${formatSeconds(r.ms)}.`));
        out.appendChild(lines);
      } else {
        const lines = h("div", "st-result-body");
        lines.appendChild(h("strong", "", "The test failed."));
        lines.appendChild(h("span", "", r.error || "No details came back."));
        if (r.backend) lines.appendChild(h("span", "st-result-meta", `${backendLabel(s.view, r.backend)}${r.model ? `, model ${r.model}` : ""}, after ${formatSeconds(r.ms)}.`));
        out.appendChild(lines);
      }
    } else if (t.status === "error") {
      const lines = h("div", "st-result-body");
      lines.append(h("strong", "", "The test did not run."), h("span", "", t.error));
      out.appendChild(lines);
    }
    out.hidden = t.status === "idle";
    sec.appendChild(out);
    return sec;
  }

  function skeleton() {
    const g = h("div", "st-skel");
    g.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) g.appendChild(h("div", "st-skel-card"));
    return g;
  }

  let lastLive = "";
  function paint(s) {
    const focusKey = document.activeElement?.closest?.(".st-radio")?.dataset.k;
    const focusGroup = document.activeElement?.closest?.(".st-radios")?.getAttribute("aria-label");
    const keep = [keyInput, ...Object.values(customInputs)].includes(document.activeElement) ? document.activeElement : null;
    body.setAttribute("aria-busy", String(s.phase === "loading"));
    const showErr = s.error && (s.phase === "error" || s.phase === "ready");
    banner.hidden = !showErr;
    banner.replaceChildren();
    if (showErr) {
      banner.appendChild(h("span", "st-banner-text", s.error));
      const r = h("button", "btn st-retry", "Retry");
      r.type = "button";
      r.addEventListener("click", () => ctl.load());
      banner.appendChild(r);
    }
    if (s.phase === "loading") return body.replaceChildren(skeleton());
    if (s.phase === "error") return body.replaceChildren();
    body.replaceChildren(backendSection(s), modelSection(s), keySection(s), planSection(s), testSection(s), (() => {
      const f = h("p", "st-foot", "Keys are never shown again after saving and never sent anywhere except to Anthropic when AURA QA asks a question.");
      return f;
    })());
    const n = s.notice;
    live.className = "st-live" + (n ? ` st-live-${n.kind}` : "");
    const text = n ? n.text : s.test.status === "done" ? (s.test.result.ok ? "The connection works." : "The test failed.") : "";
    if (text !== lastLive) {
      live.textContent = text;
      lastLive = text;
    }
    if (keep) keep.focus();
    else if (focusKey) {
      for (const g of body.querySelectorAll(".st-radios")) {
        if (g.getAttribute("aria-label") !== focusGroup) continue;
        g.querySelector(`.st-radio[data-k="${CSS.escape(focusKey)}"]`)?.focus();
      }
    }
  }

  back.addEventListener("click", () => onBack());
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (armed) {
      disarm();
      paint(ctl.state);
      return;
    }
    onBack();
  });

  paint(ctl.state);
  return {
    ctl,
    show() {
      lastLive = "";
      ctl.load();
      scroll.focus({ preventScroll: true });
    },
    hide() {
      disarm();
      keyInput.value = ""; // never leave a half-typed key behind
      keyError = "";
    },
  };
}

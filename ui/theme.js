// Appearance preferences. A classic script in <head> so the look is applied before first paint.
// It is also importable in Node: it only touches `document` when one exists, and it publishes
// its helpers as globalThis.GuardPrefs. Storage can throw (private windows); every use is guarded.
(function () {
  var KEY = "guard.prefs.v1";
  var STYLES = ["dots", "pulse", "noir", "aurora"];
  var MODES = ["system", "light", "dark"];
  var MOTIONS = ["auto", "reduced"];
  var WORK = ["auto", "on", "off"];
  var DEFAULTS = { style: "noir", mode: "system", motion: "auto", showWork: "auto" };

  function pick(v, list, fallback) {
    return list.indexOf(v) >= 0 ? v : fallback;
  }

  /** Cleans any stored value into a valid preference object. */
  function normalize(raw) {
    var o = raw && typeof raw === "object" ? raw : {};
    return {
      style: pick(o.style, STYLES, DEFAULTS.style),
      mode: pick(o.mode, MODES, DEFAULTS.mode),
      motion: pick(o.motion, MOTIONS, DEFAULTS.motion),
      showWork: pick(o.showWork, WORK, DEFAULTS.showWork),
    };
  }

  function load(storage) {
    try {
      var text = storage && storage.getItem(KEY);
      return normalize(text ? JSON.parse(text) : null);
    } catch (e) {
      return normalize(null);
    }
  }

  /** Returns true when the value was saved. A throwing or missing storage returns false. */
  function save(storage, prefs) {
    try {
      storage.setItem(KEY, JSON.stringify(normalize(prefs)));
      return true;
    } catch (e) {
      return false;
    }
  }

  function apply(prefs, root) {
    var p = normalize(prefs);
    root.setAttribute("data-style", p.style);
    root.setAttribute("data-mode", p.mode);
    root.setAttribute("data-motion", p.motion);
    return p;
  }

  function safeStorage() {
    try {
      return globalThis.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  var api = { KEY: KEY, STYLES: STYLES, MODES: MODES, MOTIONS: MOTIONS, WORK: WORK, DEFAULTS: DEFAULTS, normalize: normalize, load: load, save: save, apply: apply, safeStorage: safeStorage };
  globalThis.GuardPrefs = api;
  if (typeof document !== "undefined" && document.documentElement) apply(load(safeStorage()), document.documentElement);
})();

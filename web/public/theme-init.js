(function () {
  var root = document.documentElement;

  // Choices for Settings > General. The app uses the same function (lib/appearance.ts),
  // so what is applied before the first paint matches what is applied later.
  var UI_FONTS = {
    system: "system-ui, sans-serif",
    segoe: "'Segoe UI', system-ui, sans-serif",
    arial: "Arial, Helvetica, sans-serif",
    georgia: "Georgia, serif",
  };
  var MONO_FONTS = {
    consolas: "Consolas, monospace",
    cascadia: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    courier: "'Courier New', Courier, monospace",
  };
  var CHAT_WIDTHS = { compact: "40rem", wide: "64rem", full: "100%" };

  function num(v, min, max, fallback) {
    return typeof v === "number" && v >= min && v <= max ? v : fallback;
  }
  // A default value removes the override, so the stylesheet alone decides how it looks.
  function prop(name, value) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  function flag(name, on) {
    if (on) root.setAttribute(name, "");
    else root.removeAttribute(name);
  }

  window.reoApplyAppearance = function (a) {
    a = a || {};
    var contrast = num(a.contrast, 50, 150, 100);
    prop("--contrast-more", contrast > 100 ? (contrast - 100) * 0.8 + "%" : "");
    prop("--contrast-less", contrast < 100 ? (100 - contrast) * 0.8 + "%" : "");
    var glass = num(a.glass, 50, 100, 100);
    flag("data-glass", glass < 100);
    prop("--glass", glass < 100 ? glass + "%" : "");
    prop("--chat-width", CHAT_WIDTHS[a.chatWidth] || "");
    flag("data-reduce-motion", a.reduceMotion === true);
    prop("--app-font-sans", UI_FONTS[a.uiFont] || "");
    var uiSize = num(a.uiSize, 13, 18, 16);
    prop("font-size", uiSize !== 16 ? uiSize + "px" : "");
    prop("--font-mono", MONO_FONTS[a.monoFont] || "");
    var monoSize = num(a.monoSize, 11, 16, 0);
    flag("data-mono-size", monoSize > 0);
    prop("--mono-size", monoSize ? monoSize + "px" : "");
    flag("data-wrap", a.wordWrap === true);
    var custom = a.custom || {};
    prop("--custom-hue", String(num(custom.hue, 0, 360, 150)));
    prop("--custom-chroma", String(num(custom.chroma, 0, 0.25, 0.17)));
  };

  try {
    var stored = localStorage.getItem("color-scheme");
    var scheme = stored === "light" || stored === "dark" ? stored : "light dark";
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", scheme);
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var isDark = scheme === "dark" || (scheme === "light dark" && prefersDark);
    root.classList.toggle("dark", isDark);
    var theme = localStorage.getItem("color-theme");
    if (theme && theme !== "green") root.setAttribute("data-theme", theme);
    var radius = localStorage.getItem("radius");
    if (radius && radius !== "default") root.setAttribute("data-radius", radius);
  } catch (e) {}
  try {
    window.reoApplyAppearance(JSON.parse(localStorage.getItem("appearance") || "{}"));
  } catch (e) {}
})();

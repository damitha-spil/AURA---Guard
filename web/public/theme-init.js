(function () {
  try {
    var stored = localStorage.getItem("color-scheme");
    var scheme = stored === "light" || stored === "dark" ? stored : "light dark";
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", scheme);
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var isDark = scheme === "dark" || (scheme === "light dark" && prefersDark);
    document.documentElement.classList.toggle("dark", isDark);
    var theme = localStorage.getItem("color-theme");
    if (theme && theme !== "green") document.documentElement.setAttribute("data-theme", theme);
    var radius = localStorage.getItem("radius");
    if (radius && radius !== "default") document.documentElement.setAttribute("data-radius", radius);
  } catch (e) {}
})();

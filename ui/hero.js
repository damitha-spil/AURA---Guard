// Faint drifting particles behind the landing hero. Canvas only, no assets. It reads its colour from the
// page's --particle token, draws nothing when reduced motion is on, and stops when the tab is hidden.
export function startParticles(canvas, opts = {}) {
  if (!canvas || typeof canvas.getContext !== "function") return () => {};
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const reduced = () => (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) || document.documentElement.getAttribute("data-motion") === "reduced";
  const count = opts.count ?? 54;
  let w = 0;
  let h = 0;
  let raf = 0;
  const dots = Array.from({ length: count }, (_, i) => ({ x: ((i * 97) % 100) / 100, y: ((i * 53) % 100) / 100, r: 0.6 + ((i * 31) % 10) / 10, v: 0.006 + ((i * 17) % 10) / 2500, a: 0.25 + ((i * 13) % 10) / 20 }));
  function size() {
    const box = canvas.getBoundingClientRect();
    const k = Math.min(2, globalThis.devicePixelRatio || 1);
    w = Math.max(1, Math.round(box.width));
    h = Math.max(1, Math.round(box.height));
    canvas.width = w * k;
    canvas.height = h * k;
    ctx.setTransform(k, 0, 0, k, 0, 0);
  }
  function draw(step) {
    ctx.clearRect(0, 0, w, h);
    const color = getComputedStyle(canvas).color || "rgb(160,180,255)";
    ctx.fillStyle = color;
    for (const d of dots) {
      if (step) {
        d.y -= d.v / 6;
        if (d.y < -0.02) d.y = 1.02;
      }
      ctx.globalAlpha = d.a;
      ctx.beginPath();
      ctx.arc(d.x * w, d.y * h, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function tick() {
    raf = 0;
    if (document.hidden || canvas.offsetParent === null) return;
    draw(!reduced());
    if (!reduced()) raf = requestAnimationFrame(tick);
  }
  const kick = () => {
    if (!raf) {
      size();
      raf = requestAnimationFrame(tick);
    }
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { size(); draw(false); kick(); }) : null;
  ro?.observe(canvas);
  document.addEventListener("visibilitychange", kick);
  kick();
  return () => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
    document.removeEventListener("visibilitychange", kick);
  };
}

// A rebuild renames the page files under /assets, so a window opened before it asks for files that
// are gone. Reload once to pick up the new names.
const KEY = "reo-stale-reload";
/** A second failure this soon is a broken build, not an old window: show the error, do not loop. */
const RETRY_AFTER_MS = 30_000;

export function reloadOnStaleBuild(): void {
  window.addEventListener("vite:preloadError", (event) => {
    try {
      if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < RETRY_AFTER_MS) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      return; // without storage a loop cannot be prevented
    }
    event.preventDefault();
    window.location.reload();
  });
}

// Keeps watching the local engine, so a stopped or restarted engine is shown instead of silent failures.
import * as React from "react";

export type EngineState = "checking" | "online" | "offline" | "unpaired";

/** Often enough to notice a stopped engine quickly; the route reads nothing. */
const CHECK_EVERY_MS = 15_000;
const CHECK_TIMEOUT_MS = 8_000;

export function useEngineStatus(): { state: EngineState; check: () => void } {
  const [state, setState] = React.useState<EngineState>("checking");

  const check = React.useCallback(() => {
    fetch("/api/ping", { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
      // An engine from before this route answers 404: it is running, so it counts as online.
      .then((r) => setState(r.status === 401 ? "unpaired" : r.ok || r.status === 404 ? "online" : "offline"))
      .catch(() => setState("offline"));
  }, []);

  React.useEffect(() => {
    check();
    const timer = window.setInterval(() => {
      if (!document.hidden) check();
    }, CHECK_EVERY_MS);
    const wake = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [check]);

  return { state, check };
}

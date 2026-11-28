// A computer notification when a chat reply finishes while the window is not in front.
// Off until the owner turns it on. The text is fixed: no chat content leaves the window.
import * as React from "react";

const KEY = "reo-notify-replies";

export const notifySupported = () => typeof window !== "undefined" && "Notification" in window;

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

let on = stored();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useNotifyReplies = () => React.useSyncExternalStore(subscribe, () => on);

export function setNotifyReplies(next: boolean) {
  on = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    // storage unavailable: the change still applies until the page closes
  }
  listeners.forEach((l) => l());
}

/** False when the window refused to show it. */
export function showNotification(body: string): boolean {
  if (!notifySupported() || Notification.permission !== "granted") return false;
  try {
    const n = new Notification("SPIL REO", { body, tag: "reo-reply" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

export function notifyReply(failed: boolean) {
  if (on && (document.hidden || !document.hasFocus())) showNotification(failed ? "A reply ended with a problem." : "A reply is ready.");
}

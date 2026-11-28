// Settings > Keyboard.
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SHORTCUTS, comboOf, keysFor, label, refusal, resetAllShortcuts, resetShortcut, setShortcut, useOverrides, type ShortcutId } from "@/lib/keybindings";

export function KeyboardSettings() {
  const overrides = useOverrides();
  const [recording, setRecording] = React.useState<ShortcutId | null>(null);
  const [problem, setProblem] = React.useState("");

  function record(id: ShortcutId, e: React.KeyboardEvent) {
    if (recording !== id || e.key === "Tab") return;
    e.preventDefault();
    // Keeps the app's own shortcuts from firing while a new one is typed.
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      setProblem("");
      return;
    }
    const combo = comboOf(e);
    if (!combo) return;
    const why = refusal(id, combo);
    if (why) {
      setProblem(why);
      return;
    }
    setShortcut(id, combo);
    setRecording(null);
    setProblem("");
  }

  function reset(id: ShortcutId, original: string) {
    const clash = SHORTCUTS.find((o) => o.id !== id && keysFor(o.id) === original);
    if (clash) return setProblem(`${label(original)} is now used for "${clash.label}". Change that one first.`);
    resetShortcut(id);
    setProblem("");
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>Keyboard shortcuts</CardTitle>
            <CardDescription>Choose Change, then press the new keys. Esc cancels. Kept in this window only.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={resetAllShortcuts} disabled={Object.keys(overrides).length === 0}>
            Reset all
          </Button>
        </div>
      </CardHeader>
      <CardContent className="divide-y text-sm">
        {SHORTCUTS.map((s) => {
          const keys = keysFor(s.id, overrides);
          return (
            <div key={s.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">{s.label}</span>
              <kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{recording === s.id ? "Press keys..." : label(keys)}</kbd>
              <Button
                variant={recording === s.id ? "secondary" : "outline"}
                size="sm"
                aria-label={`Change the shortcut for ${s.label}`}
                onClick={() => {
                  setRecording(s.id);
                  setProblem("");
                }}
                onKeyDown={(e) => record(s.id, e)}
                onBlur={() => setRecording((r) => (r === s.id ? null : r))}
              >
                Change
              </Button>
              <Button variant="ghost" size="sm" disabled={!keys} onClick={() => setShortcut(s.id, "")}>
                Turn off
              </Button>
              <Button variant="ghost" size="sm" disabled={overrides[s.id] === undefined} onClick={() => reset(s.id, s.keys)}>
                Reset
              </Button>
            </div>
          );
        })}
        <p role="status" className="text-destructive pt-2 text-xs empty:hidden">{problem}</p>
      </CardContent>
    </Card>
  );
}

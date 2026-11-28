// Find within the open chat. Matches are marked as React elements; the text is never read as HTML.
import * as React from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { splitMatches } from "@/lib/chat";

export function Marked({ text, query }: { text: string; query: string }) {
  if (!query) return text;
  return splitMatches(text, query).map((p, i) =>
    p.match ? (
      <mark key={i} data-find-match="" className="bg-accent text-accent-foreground data-current:outline-ring rounded-sm underline data-current:outline-2">
        {p.text}
      </mark>
    ) : (
      <React.Fragment key={i}>{p.text}</React.Fragment>
    ),
  );
}

export function FindBar({
  query,
  onQuery,
  onClose,
  scope,
  messages,
  focusRequest,
}: {
  query: string;
  onQuery: (q: string) => void;
  onClose: () => void;
  /** The element that holds the messages. */
  scope: React.RefObject<HTMLDivElement | null>;
  /** Changes when the conversation changes, so matches are counted again. */
  messages: unknown;
  focusRequest: number;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const [total, setTotal] = React.useState(0);
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  React.useEffect(() => setIndex(0), [query]);

  React.useEffect(() => {
    const marks = scope.current?.querySelectorAll<HTMLElement>("[data-find-match]") ?? [];
    setTotal(marks.length);
    const at = marks.length ? Math.min(index, marks.length - 1) : 0;
    marks.forEach((m, i) => m.toggleAttribute("data-current", i === at));
    marks[at]?.scrollIntoView({ block: "center" });
  }, [query, index, messages, scope]);

  const step = (by: number) => total && setIndex((i) => (Math.min(i, total - 1) + by + total) % total);

  return (
    <div role="search" data-glass-surface="popover" className="bg-popover flex items-center gap-1 rounded-2xl border p-1 shadow-md">
      <Input
        ref={input}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in this chat"
        aria-label="Find in this chat"
        className="h-8 w-40 border-0 shadow-none sm:w-56"
      />
      <span role="status" className="text-muted-foreground min-w-12 text-center text-xs tabular-nums">
        {query ? (total ? `${Math.min(index, total - 1) + 1} of ${total}` : "None") : ""}
      </span>
      <Button variant="ghost" size="icon" className="size-7" aria-label="Previous match" disabled={!total} onClick={() => step(-1)}>
        <ChevronUp />
      </Button>
      <Button variant="ghost" size="icon" className="size-7" aria-label="Next match" disabled={!total} onClick={() => step(1)}>
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon" className="size-7" aria-label="Close find" onClick={onClose}>
        <X />
      </Button>
    </div>
  );
}

import type * as React from "react";
import { cn } from "@/lib/utils";

export interface SettingsMenuGroup {
  heading: string;
  icon: React.ComponentType<{ className?: string }>;
  items: { key: string; label: string; active: boolean; open: () => void }[];
}

/** The menu shown beside every page that lives under Settings. A row along the top on narrow windows. */
export function SettingsMenu({ groups }: { groups: SettingsMenuGroup[] }) {
  return (
    <nav
      aria-label="Settings"
      className="flex shrink-0 gap-3 overflow-x-auto border-b p-2 md:w-60 md:flex-col md:gap-0 md:divide-y md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:px-3 md:py-1"
    >
      {groups.map((g) => (
        <div key={g.heading} role="group" aria-label={g.heading} className="flex shrink-0 items-center gap-1 md:flex-col md:items-stretch md:gap-1 md:py-3">
          <div className="hidden items-center gap-2.5 px-1 py-1 md:flex" aria-hidden="true">
            <span className="bg-primary/15 text-primary flex size-6 shrink-0 items-center justify-center rounded-md">
              <g.icon className="size-3.5" />
            </span>
            <span className="text-foreground text-sm font-semibold">{g.heading}</span>
          </div>
          {/* The indent and the line show that these belong to the heading above. */}
          <div className="flex gap-1 md:ml-4 md:flex-col md:gap-0.5 md:border-l md:pl-3">
            {g.items.map((i) => (
              <button
                key={i.key}
                type="button"
                onClick={i.open}
                aria-current={i.active ? "page" : undefined}
                className={cn(
                  "focus-visible:ring-ring/50 rounded-lg px-3 py-1.5 text-left text-[13px] whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:outline-none",
                  i.active ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {i.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

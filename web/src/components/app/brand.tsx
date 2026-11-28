import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** The SPIL REO app icon. Shows "SR" if the image cannot be loaded. */
export function BrandAvatar({ className }: { className?: string }) {
  return (
    <Avatar className={cn("size-8 shrink-0 rounded-lg after:hidden", className)}>
      <AvatarImage src="/logo.png" alt="" className="rounded-lg" />
      <AvatarFallback className="rounded-lg text-xs font-semibold">SR</AvatarFallback>
    </Avatar>
  );
}

/** Crisp transparent pixel-art Claude Code bot mascot for chat answer rows. */
export function AssistantAvatar({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", className)}
    >
      <svg viewBox="0 0 16 14" className="size-7" shapeRendering="crispEdges">
        {/* Main head/torso block */}
        <rect x="3" y="2" width="10" height="7" fill="#D97757" />
        {/* Left & right arms */}
        <rect x="1" y="4" width="2" height="3" fill="#D97757" />
        <rect x="13" y="4" width="2" height="3" fill="#D97757" />
        {/* Four pixel legs */}
        <rect x="3" y="9" width="1.5" height="3" fill="#D97757" />
        <rect x="5.5" y="9" width="1.5" height="3" fill="#D97757" />
        <rect x="9" y="9" width="1.5" height="3" fill="#D97757" />
        <rect x="11.5" y="9" width="1.5" height="3" fill="#D97757" />
        {/* Crisp black eyes */}
        <rect x="4.5" y="3.5" width="1.5" height="2" fill="#111111" />
        <rect x="10" y="3.5" width="1.5" height="2" fill="#111111" />
      </svg>
    </div>
  );
}

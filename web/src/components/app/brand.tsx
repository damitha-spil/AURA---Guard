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

/** Dark-mode chat bot icon (transparent background): orange bot face/antenna (#E8853D), dark eyes (#1C1C1E). */
export function AssistantAvatarDark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden="true">
      <line x1="16" y1="5" x2="16" y2="11" stroke="#E8853D" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="5" r="2.6" fill="#E8853D" />
      <rect x="4" y="10.5" width="24" height="17.5" rx="6.5" fill="#E8853D" />
      <circle cx="11.4" cy="19.2" r="2.9" fill="#1C1C1E" />
      <circle cx="20.6" cy="19.2" r="2.9" fill="#1C1C1E" />
    </svg>
  );
}

/** Light-mode chat bot icon (transparent background, swapped): dark bot face/antenna (#1C1C1E), orange eyes (#E8853D). */
export function AssistantAvatarLight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden="true">
      <line x1="16" y1="5" x2="16" y2="11" stroke="#1C1C1E" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="5" r="2.6" fill="#1C1C1E" />
      <rect x="4" y="10.5" width="24" height="17.5" rx="6.5" fill="#1C1C1E" />
      <circle cx="11.4" cy="19.2" r="2.9" fill="#E8853D" />
      <circle cx="20.6" cy="19.2" r="2.9" fill="#E8853D" />
    </svg>
  );
}

/** The chat bot avatar: automatically switches between light and dark mode icons. */
export function AssistantAvatar({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center", className)}>
      <AssistantAvatarLight className="block dark:hidden" />
      <AssistantAvatarDark className="hidden dark:block" />
    </div>
  );
}

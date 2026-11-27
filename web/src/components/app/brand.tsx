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

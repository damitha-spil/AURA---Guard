// File cards (composer and sent messages) and the viewer that opens when a card is clicked.
// Text is shown as plain React text. A picture is an <img> of the engine's same-origin file route. A PDF
// is NOT embedded: the page's CSP and X-Frame-Options forbid frames, and the web-safety test forbids
// iframes, so the viewer shows the text REO read from it plus an "Open file" action, which asks the
// engine to open the stored file with the computer's default program.
import * as React from "react";
import { ExternalLink, File as FileIcon, FileCode2, FileText, Image as ImageIcon, Loader2, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";
import { attachmentSummary, attachmentUrl, formatBytes } from "@/lib/chat";
import type { AttachmentInfo } from "@/lib/chat";

/** Mirrors the engine's list of files the OS may open (engine/src/chat/attachments.ts). */
const OPENABLE = /\.(pdf|png|jpe?g|gif|webp|bmp|txt|md|markdown|csv|tsv|log|json|ya?ml|docx|xlsx|pptx|rtf)$/i;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|rs|go|cs|css|scss|html?|sql|sh|ps1|bat|json|ya?ml|toml|xml|c|h|cpp|rb|php)$/i;

export interface CardFile {
  /** Engine id; absent while the file is only chosen, not uploaded yet. */
  id?: string;
  name: string;
  size: number;
  kind?: AttachmentInfo["kind"];
  status?: AttachmentInfo["status"];
  note?: string;
  chars?: number;
  /** Composer only. */
  uploading?: boolean;
  error?: string;
  /** Messages sent before files were kept: shown as a card that cannot be opened. */
  legacy?: boolean;
}

function KindIcon({ file, className }: { file: CardFile; className?: string }) {
  if (file.kind === "image") return <ImageIcon className={className} />;
  if (file.kind === "text" && CODE.test(file.name)) return <FileCode2 className={className} />;
  if (file.kind === "pdf" || file.kind === "docx" || file.kind === "text") return <FileText className={className} />;
  return <FileIcon className={className} />;
}

const tint = (file: CardFile): string =>
  file.error || file.status === "blocked"
    ? "bg-destructive/10 text-destructive"
    : file.kind === "pdf"
      ? "bg-red-500/10 text-red-600 dark:text-red-400"
      : file.kind === "docx"
        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
        : file.kind === "image"
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-muted text-muted-foreground";

export function FileCard({
  file,
  onOpen,
  onRemove,
  variant,
}: {
  file: CardFile;
  onOpen?: () => void;
  onRemove?: () => void;
  variant: "composer" | "sent";
}) {
  const line = file.error
    ? file.error
    : file.uploading
      ? "Uploading and reading..."
      : file.legacy
        ? "Sent in the message text; the file was not kept"
        : file.status
          ? attachmentSummary({ status: file.status, kind: file.kind ?? "other", ...(file.note ? { note: file.note } : {}), ...(file.chars ? { chars: file.chars } : {}) })
          : "Ready to send";
  const warn = !!file.error || file.status === "blocked" || (file.status === "unreadable" && file.kind !== "image");
  const clickable = !!onOpen && !file.uploading && !file.error && !file.legacy;
  const body = (
    <>
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", tint(file))}>
        {file.uploading ? <Loader2 className="size-5 animate-spin" /> : warn ? <TriangleAlert className="size-5" /> : <KindIcon file={file} className="size-5" />}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className={cn("block truncate text-xs", warn ? "text-destructive" : "text-muted-foreground")}>
          {formatBytes(file.size)} · {line}
        </span>
      </span>
    </>
  );
  const shell = cn(
    "bg-background/60 flex w-full min-w-0 max-w-72 items-center gap-2.5 rounded-xl border p-2 pr-3 text-foreground",
    warn && "border-destructive/40",
  );
  return (
    <div className={cn("relative", variant === "sent" ? "max-w-72" : "w-64 max-w-full")}>
      {clickable ? (
        <button
          type="button"
          onClick={onOpen}
          title={`Open ${file.name}`}
          aria-label={`Open ${file.name}`}
          className={cn(shell, "hover:bg-muted focus-visible:ring-ring/50 transition-colors focus-visible:ring-[3px] focus-visible:outline-none")}
        >
          {body}
        </button>
      ) : (
        <div className={shell} title={file.legacy ? "This message was sent before REO kept files." : undefined}>
          {body}
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          title="Remove"
          className="bg-background text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border shadow-xs focus-visible:ring-[3px] focus-visible:outline-none"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

export function AttachmentViewer({ chatId, file, onClose }: { chatId: string | null; file: CardFile | null; onClose: () => void }) {
  const [text, setText] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const imageUrl = chatId && file?.id && file.kind === "image" ? attachmentUrl(chatId, file.id) : null;
  React.useEffect(() => {
    setText(null);
    setFailed(false);
    if (!chatId || !file?.id || file.kind === "image") return;
    const url = attachmentUrl(chatId, file.id, "text");
    if (!url) return;
    let live = true;
    void apiGet<{ text: string }>(url).then((r) => {
      if (!live) return;
      if (r.ok) setText(r.data.text ?? "");
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [chatId, file?.id, file?.kind]);

  async function openFile() {
    const url = chatId && file?.id ? attachmentUrl(chatId, file.id, "open") : null;
    if (!url) return;
    const r = await apiPost(url);
    toast(r.ok ? "Opened with your default program" : r.error || "Could not open the file");
  }

  const canOpen = !!file?.id && OPENABLE.test(file.name);
  return (
    <Dialog open={file !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-6 break-words">{file?.name}</DialogTitle>
          <DialogDescription>
            {file ? `${formatBytes(file.size)} · ${file.status ? attachmentSummary({ status: file.status, kind: file.kind ?? "other", ...(file.note ? { note: file.note } : {}), ...(file.chars ? { chars: file.chars } : {}) }) : ""}` : ""}
          </DialogDescription>
        </DialogHeader>
        {file?.kind === "pdf" || file?.kind === "docx" ? (
          <p className="text-muted-foreground text-xs">
            This is the text REO read from the file, not the page layout. Use Open file to see the original.
          </p>
        ) : null}
        <ScrollArea className="bg-muted/40 min-h-40 flex-1 rounded-lg border">
          {imageUrl ? (
            <div className="flex justify-center p-3">
              <img src={imageUrl} alt={file?.name ?? "Attached picture"} className="max-h-[60vh] max-w-full rounded-md object-contain" />
            </div>
          ) : failed ? (
            <p className="text-destructive p-4 text-sm">Could not load the file text.</p>
          ) : text === null ? (
            <p className="text-muted-foreground p-4 text-sm">Loading...</p>
          ) : text ? (
            <pre className="max-h-[60vh] overflow-auto p-4 font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>
          ) : (
            <p className="text-muted-foreground p-4 text-sm">{file?.note ? `No text to show: ${file.note}.` : "No text to show."}</p>
          )}
        </ScrollArea>
        <div className="flex justify-end gap-2">
          {canOpen && (
            <Button type="button" variant="outline" onClick={() => void openFile()}>
              <ExternalLink />
              Open file
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

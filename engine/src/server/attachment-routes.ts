// /api/chats/:id/attachments: upload, download, extracted text, open with the OS, delete. The server has
// already checked the cookie, Host and Origin. Ids are made by AttachmentStore; no client path is used.

import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { AttachmentError, canOpen, MAX_UPLOAD_BYTES } from "../chat/attachments.ts";
import type { AttachmentStore } from "../chat/attachments.ts";
import type { ChatStore } from "../chat/store.ts";
import { HttpError, sendJson } from "./http.ts";

const RE = /^\/api\/chats\/([a-f0-9]{16})\/attachments(?:\/([a-f0-9]{16})(?:\/(text|open))?)?$/;
/** Pictures may be shown by the page; everything else is a download, never rendered. */
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

export interface AttachmentRouteDeps {
  chats: ChatStore;
  files: AttachmentStore;
  launch: (command: string, args: string[]) => Promise<void>;
}

/** The program that opens a stored file with its default app. A program and an argument list, never a shell. */
export function fileOpenCommand(path: string, platform: string = process.platform, env: Record<string, string | undefined> = process.env): { command: string; args: string[] } {
  if (platform === "win32") return { command: join(env.SystemRoot ?? "C:\Windows", "explorer.exe"), args: [path] };
  return { command: platform === "darwin" ? "open" : "xdg-open", args: [path] };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  // A page on another site cannot send this type without a preflight, which this server never answers.
  if (type !== "application/octet-stream") throw new HttpError(415, "Send the file as application/octet-stream.");
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > MAX_UPLOAD_BYTES) throw new HttpError(413, `That file is too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, `That file is too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createAttachmentRoutes(deps: AttachmentRouteDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
    const m = RE.exec(path);
    if (!m) return false;
    const chatId = m[1] as string;
    const attId = m[2];
    const action = m[3];
    if (!deps.chats.get(chatId)) throw new HttpError(404, "No such chat.");
    try {
      if (!attId) {
        if (method !== "POST") throw new HttpError(405, "Use POST to upload a file.");
        const url = new URL(req.url ?? "/", "http://x");
        const name = url.searchParams.get("name") ?? "";
        if (!name || name.length > 300) throw new HttpError(400, "Send the file name as ?name=.");
        const body = await readBody(req);
        const meta = await deps.files.save(chatId, name, String(req.headers["x-file-type"] ?? "").slice(0, 100), body);
        sendJson(res, 201, { attachment: meta });
        return true;
      }
      const file = deps.files.file(chatId, attId);
      if (!file) throw new HttpError(404, "No such file.");
      if (!action && method === "GET") {
        const inline = INLINE_IMAGES.has(file.meta.type);
        res.writeHead(200, {
          "Content-Type": inline ? file.meta.type : "application/octet-stream",
          "Content-Disposition": inline ? "inline" : "attachment",
          "Content-Length": file.meta.size,
        });
        const { readFileSync } = await import("node:fs");
        res.end(readFileSync(file.path));
        return true;
      }
      if (action === "text" && method === "GET") {
        sendJson(res, 200, { attachment: file.meta, text: deps.files.text(chatId, attId) });
        return true;
      }
      if (action === "open" && method === "POST") {
        if (!canOpen(file.ext)) throw new HttpError(400, "REO does not open this kind of file for you. It could run code.");
        const cmd = fileOpenCommand(file.path);
        try { await deps.launch(cmd.command, cmd.args); } catch { throw new HttpError(500, "Could not open the file with another program."); }
        sendJson(res, 200, { opened: true });
        return true;
      }
      if (!action && method === "DELETE") {
        const used = deps.chats.get(chatId)?.messages.some((x) => x.attachments?.some((a) => a.id === attId));
        if (used) throw new HttpError(409, "That file was already sent in this chat.");
        deps.files.remove(chatId, attId);
        sendJson(res, 200, { deleted: true });
        return true;
      }
      throw new HttpError(405, "Not allowed.");
    } catch (e) {
      if (e instanceof AttachmentError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
}

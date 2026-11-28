// Files attached to a chat. They live in data/attachments/<chatId>/ (git-ignored, inside this app's own
// data folder, never in another repo). Each file has: the original bytes, extracted text, and a small
// metadata file. Ids are generated here; a client never chooses a path. The stored original and its text
// are NOT masked (the person must be able to open the file again); text is masked at the moment it would
// be sent to a model (see prompt.ts) and chat messages only keep the metadata.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { maskForStorage, WITHHELD, isChatId } from "./store.ts";
import { maskOutgoing } from "../mask/mask.ts";

/** One file. Large enough for a long PDF, small enough that parsing it cannot stall the engine. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Per message, and per chat in total (count and bytes), so a chat cannot fill the disk. */
export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_FILES_PER_CHAT = 30;
export const MAX_BYTES_PER_CHAT = 50 * 1024 * 1024;
/** Extracted text kept per file; more is cut and the card says so. */
export const MAX_EXTRACTED_CHARS = 200_000;
/** PDF pages read; a longer document is read from the start and the card says so. */
export const MAX_PDF_PAGES = 150;
/** A PDF that takes longer than this to read is given up on. */
export const PDF_TIMEOUT_MS = 20_000;
/** DOCX: the unzipped document text is capped, so a zip bomb cannot fill memory. */
const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024;

export type AttachmentKind = "text" | "pdf" | "docx" | "image" | "other";
export type AttachmentStatus = "read" | "cut" | "unreadable" | "blocked";

/** What chat messages and the app see. No paths. */
export interface AttachmentMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /** A plain sentence about what was or was not read. */
  note?: string;
  /** Characters of text extracted (before any cut for a model). */
  chars?: number;
}
interface StoredMeta extends AttachmentMeta { ext: string; uploaded: string }

const ID_RE = /^[a-f0-9]{16}$/;
export const isAttachmentId = (s: string): boolean => ID_RE.test(s);


const IMAGE_EXT = /^(png|jpe?g|gif|webp|bmp|ico)$/i;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon" };

/**
 * Files the OS may open with their default program. An allow-list, because a deny-list of executables
 * and scripts always misses one (.hta, .lnk, .url, .scr, macro Office files...). Web formats that run
 * script when opened (html, svg) and anything with macros are not on it.
 */
const OPENABLE_EXT = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "txt", "md", "markdown", "csv", "tsv", "log", "json", "yml", "yaml", "docx", "xlsx", "pptx", "rtf"]);

export function cleanFileName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return !cleaned || /^\.+$/.test(cleaned) ? "file" : cleaned;
}
const extOf = (name: string): string => {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
};
export const canOpen = (ext: string): boolean => OPENABLE_EXT.has(ext);

// ---- extraction ----

export interface Extracted { kind: AttachmentKind; status: AttachmentStatus; note?: string; text: string }

/** Decodes UTF-8 or UTF-16 (BOM). Null when it is not text (a NUL byte, or invalid UTF-8). */
export function decodeText(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    sw.swap16();
    return sw.toString("utf16le");
  }
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

const cutText = (text: string): { text: string; cut: boolean } =>
  text.length > MAX_EXTRACTED_CHARS ? { text: text.slice(0, MAX_EXTRACTED_CHARS), cut: true } : { text, cut: false };

/** Reads the central directory of a zip and returns one entry's bytes, inflated up to `limit`. */
export function readZipEntry(buf: Buffer, wanted: string, limit: number): Buffer | null {
  // End of central directory record: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      try {
        if (method === 0) return data.length <= limit ? data : null;
        if (method === 8) return inflateRawSync(data, { maxOutputLength: limit });
      } catch { return null; }
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** The visible text of a Word document.xml: paragraphs become lines, tabs and breaks are kept. */
export function docxText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
      if (e.startsWith("#")) {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return XML_ENT[e] ?? "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdf(buf: Buffer): Promise<Extracted> {
  if (!buf.subarray(0, 1024).includes("%PDF-")) return { kind: "pdf", status: "unreadable", note: "this is not a valid PDF file", text: "" };
  try {
    // unpdf bundles a serverless build of Mozilla's pdf.js: text only, no canvas, no worker, no scripts.
    const { getDocumentProxy } = await import("unpdf");
    const work = (async (): Promise<Extracted> => {
      const pdf = await getDocumentProxy(new Uint8Array(buf), { isEvalSupported: false, useSystemFonts: false, verbosity: 0 } as never);
      const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
      const parts: string[] = [];
      let empty = 0;
      let size = 0;
      for (let i = 1; i <= pages && size <= MAX_EXTRACTED_CHARS; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        let line = "";
        const out: string[] = [];
        for (const it of content.items as { str?: string; hasEOL?: boolean }[]) {
          if (typeof it.str !== "string") continue;
          line += it.str;
          if (it.hasEOL) { out.push(line); line = ""; }
        }
        if (line) out.push(line);
        const t = out.join("\n").trim();
        if (!t) empty++;
        else { parts.push(t); size += t.length; }
      }
      await (pdf as unknown as { cleanup?: () => Promise<void> }).cleanup?.().catch(() => {});
      const all = parts.join("\n\n");
      const { text, cut } = cutText(all);
      if (!text.trim()) {
        return { kind: "pdf", status: "unreadable", text: "", note: "no text was found in this PDF (it is probably scanned pages or pictures; REO does not read images)" };
      }
      const notes: string[] = [];
      if (pdf.numPages > pages) notes.push(`only the first ${pages} of ${pdf.numPages} pages were read`);
      if (empty > 0) notes.push(`${empty} page${empty === 1 ? "" : "s"} had no text (scanned or pictures)`);
      if (cut) notes.push(`text was cut at ${MAX_EXTRACTED_CHARS.toLocaleString("en-US")} characters`);
      return { kind: "pdf", status: notes.length ? "cut" : "read", text, ...(notes.length ? { note: notes.join("; ") } : {}) };
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Extracted>((res) => {
      timer = setTimeout(() => res({ kind: "pdf", status: "unreadable", text: "", note: "reading this PDF took too long and was stopped" }), PDF_TIMEOUT_MS);
    });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); work.catch(() => {}); }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const why = /password/i.test(msg) ? "this PDF is password protected" : "this PDF could not be read (it may be damaged)";
    return { kind: "pdf", status: "unreadable", note: why, text: "" };
  }
}

export async function extractText(name: string, buf: Buffer): Promise<Extracted> {
  const ext = extOf(name);
  if (ext === "pdf") return extractPdf(buf);
  if (ext === "docx") {
    if (buf.readUInt32LE(0) !== 0x04034b50) return { kind: "docx", status: "unreadable", text: "", note: "this is not a valid Word file" };
    const xml = readZipEntry(buf, "word/document.xml", MAX_DOCX_XML_BYTES);
    if (!xml) return { kind: "docx", status: "unreadable", text: "", note: "the text of this Word file could not be read" };
    const t = docxText(xml.toString("utf8"));
    if (!t) return { kind: "docx", status: "unreadable", text: "", note: "no text was found in this Word file" };
    const { text, cut } = cutText(t);
    return { kind: "docx", status: cut ? "cut" : "read", text, ...(cut ? { note: `text was cut at ${MAX_EXTRACTED_CHARS.toLocaleString("en-US")} characters` } : {}) };
  }
  if (IMAGE_EXT.test(ext)) return { kind: "image", status: "unreadable", text: "", note: "pictures are shown here but not read by REO; the model gets only the file name" };
  // Known text extensions and unknown ones alike: it is text if it decodes as text.
  const asText = decodeText(buf);
  if (asText !== null) {
    const { text, cut } = cutText(asText);
    return { kind: "text", status: cut ? "cut" : "read", text, ...(cut ? { note: `text was cut at ${MAX_EXTRACTED_CHARS.toLocaleString("en-US")} characters` } : {}) };
  }
  return { kind: "other", status: "unreadable", text: "", note: "REO cannot read this kind of file" };
}

// ---- store ----

export class AttachmentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class AttachmentStore {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = join(dataDir, "attachments");
  }
  private dir(chatId: string): string {
    if (!isChatId(chatId)) throw new AttachmentError(404, "No such chat.");
    return join(this.root, chatId);
  }
  private metaFile(chatId: string, id: string): string {
    if (!isAttachmentId(id)) throw new AttachmentError(404, "No such file.");
    return join(this.dir(chatId), `${id}.json`);
  }

  private readMeta(chatId: string, id: string): StoredMeta | null {
    try {
      const f = this.metaFile(chatId, id);
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as StoredMeta) : null;
    } catch {
      return null;
    }
  }

  private all(chatId: string): StoredMeta[] {
    const d = this.dir(chatId);
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => this.readMeta(chatId, f.slice(0, -5))).filter((m): m is StoredMeta => m !== null);
  }

  async save(chatId: string, rawName: string, mime: string, buf: Buffer): Promise<AttachmentMeta> {
    if (buf.length === 0) throw new AttachmentError(400, "That file is empty.");
    if (buf.length > MAX_UPLOAD_BYTES) throw new AttachmentError(413, `That file is too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);
    const existing = this.all(chatId);
    if (existing.length >= MAX_FILES_PER_CHAT) throw new AttachmentError(409, `This chat already holds ${MAX_FILES_PER_CHAT} files. Start a new chat for more.`);
    if (existing.reduce((n, m) => n + m.size, 0) + buf.length > MAX_BYTES_PER_CHAT) throw new AttachmentError(409, "This chat's files are over the size limit. Start a new chat for more.");
    const clean = cleanFileName(rawName);
    const ext = extOf(clean);
    const ex = await extractText(clean, buf);
    const shownName = (() => { const m = maskForStorage(clean); return m === WITHHELD ? "file" : m; })();
    let status = ex.status;
    let note = ex.note;
    if (ex.text && !maskOutgoing(ex.text).ok) {
      status = "blocked";
      note = "it looks like it holds a secret, so nothing from it will be sent to a model";
    }
    const id = randomBytes(8).toString("hex");
    const meta: StoredMeta = {
      id, name: shownName, size: buf.length, type: (IMAGE_TYPES[ext] ?? mime.slice(0, 100)) || "application/octet-stream",
      kind: ex.kind, status, ...(note ? { note } : {}), ...(ex.text ? { chars: ex.text.length } : {}),
      ext: ext || "bin", uploaded: new Date().toISOString(),
    };
    const d = this.dir(chatId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.${meta.ext}`), buf);
    if (ex.text) writeFileSync(join(d, `${id}.txt`), ex.text);
    const tmp = join(d, `${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(meta));
    renameSync(tmp, join(d, `${id}.json`));
    return this.pub(meta);
  }

  private pub(m: StoredMeta): AttachmentMeta {
    const { ext: _e, uploaded: _u, ...rest } = m;
    return rest;
  }

  meta(chatId: string, id: string): AttachmentMeta | null {
    const m = this.readMeta(chatId, id);
    return m ? this.pub(m) : null;
  }

  /** Extracted text, or "" when there is none. */
  text(chatId: string, id: string): string {
    if (!this.readMeta(chatId, id)) return "";
    try {
      return readFileSync(join(this.dir(chatId), `${id}.txt`), "utf8");
    } catch {
      return "";
    }
  }

  /** The stored original: its path, extension and type. Only for ids this store made. */
  file(chatId: string, id: string): { path: string; ext: string; meta: AttachmentMeta } | null {
    const m = this.readMeta(chatId, id);
    if (!m) return null;
    const path = join(this.dir(chatId), `${id}.${m.ext}`);
    return existsSync(path) && basename(path) === `${id}.${m.ext}` ? { path, ext: m.ext, meta: this.pub(m) } : null;
  }

  remove(chatId: string, id: string): boolean {
    const m = this.readMeta(chatId, id);
    if (!m) return false;
    const d = this.dir(chatId);
    for (const f of [`${id}.${m.ext}`, `${id}.txt`, `${id}.json`]) rmSync(join(d, f), { force: true });
    return true;
  }

  removeChat(chatId: string): void {
    if (isChatId(chatId)) rmSync(join(this.root, chatId), { recursive: true, force: true });
  }
}

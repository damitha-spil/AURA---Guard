// Chat attachments: upload, caps, text extraction, download, open with the OS (faked), and the ask path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateRawSync } from "node:zlib";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import { cleanFileName, decodeText, docxText, extractText, MAX_UPLOAD_BYTES, readZipEntry } from "../src/chat/attachments.ts";
import { fileOpenCommand } from "../src/server/attachment-routes.ts";
import type { CompleteRequest } from "../src/brain/client.ts";
import { fakeSecret, fixtureUiDir, seed, tmpCfg } from "./chat-helpers.ts";

const TOKEN = "a".repeat(48);
const usage = { input_tokens: 1, output_tokens: 1 };

async function start() {
  const cfg = tmpCfg();
  const db = seed();
  const calls: CompleteRequest[] = [];
  const launched: { command: string; args: string[] }[] = [];
  const server: Server = createGuardServer(cfg, {
    token: TOKEN,
    uiDir: fixtureUiDir(),
    complete: async (req) => { calls.push(req); return { text: "It is a file.", usage }; },
    openIndex: () => ({ db, release: () => {} }),
    backendInfo: async () => ({ wanted: "auto", picked: "claude-cli", label: "Claude plan (m)" }),
    openFile: async (command, args) => { launched.push({ command, args }); },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Cookie: `${COOKIE_NAME}=${TOKEN}` };
  const json = { ...headers, "Content-Type": "application/json" };
  const chat = ((await (await fetch(`${base}/api/chats`, { method: "POST", headers: json, body: "{}" })).json()) as { id: string }).id;
  const upload = (name: string, body: Uint8Array | string, type = "application/octet-stream", id = chat) =>
    fetch(`${base}/api/chats/${id}/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...headers, "Content-Type": type }, body: body as BodyInit });
  return {
    cfg, base, chat, headers, json, calls, launched, upload,
    ask: async (body: object) => (await fetch(`${base}/api/chats/${chat}/ask`, { method: "POST", headers: json, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; text: string; sources: unknown[] }>,
    stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

test("text upload: kept under the data folder, read, and used by the next question (not the 4,000 character limit)", async () => {
  const s = await start();
  try {
    const body = "line of notes\n".repeat(2000);
    const r = await s.upload("../../etc/notes.txt", body);
    assert.equal(r.status, 201);
    const { attachment: a } = (await r.json()) as { attachment: { id: string; name: string; kind: string; status: string } };
    assert.equal(a.name, "notes.txt", "no client path survives");
    assert.deepEqual([a.kind, a.status], ["text", "read"]);
    assert.ok(existsSync(join(s.cfg.dataDir, "attachments", s.chat)));
    const t = (await (await fetch(`${s.base}/api/chats/${s.chat}/attachments/${a.id}/text`, { headers: s.headers })).json()) as { text: string };
    assert.equal(t.text, body);
    const dl = await fetch(`${s.base}/api/chats/${s.chat}/attachments/${a.id}`, { headers: s.headers });
    assert.equal(dl.headers.get("content-type"), "application/octet-stream");
    assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
    const reply = await s.ask({ question: "what is this?", attachments: [a.id] });
    assert.equal(reply.ok, true);
    assert.ok(s.calls[0]!.user.includes("<<<attachment name=\"notes.txt\""));
    assert.ok(s.calls[0]!.user.indexOf("<<<attachment") < s.calls[0]!.user.indexOf("Question: what is this?"));
    // A follow-up with no new file still sees the earlier one.
    await s.ask({ question: "and how long is it?" });
    assert.ok(s.calls[1]!.user.includes("<<<attachment name=\"notes.txt\""));
    const stored = (await (await fetch(`${s.base}/api/chats/${s.chat}`, { headers: s.headers })).json()) as { messages: { text: string; attachments?: { id: string }[] }[] };
    assert.equal(stored.messages[0]!.attachments?.[0]?.id, a.id);
    assert.ok(!stored.messages[0]!.text.includes("Attached resource"));
    // A sent file cannot be deleted from under its message.
    assert.equal((await fetch(`${s.base}/api/chats/${s.chat}/attachments/${a.id}`, { method: "DELETE", headers: s.headers })).status, 409);
    // Deleting the chat deletes its files.
    assert.equal((await fetch(`${s.base}/api/chats/${s.chat}`, { method: "DELETE", headers: s.headers })).status, 200);
    assert.equal(existsSync(join(s.cfg.dataDir, "attachments", s.chat)), false);
  } finally {
    await s.stop();
  }
});

test("upload protection: token, content type, size, ids and chat id", async () => {
  const s = await start();
  try {
    const noAuth = await fetch(`${s.base}/api/chats/${s.chat}/attachments?name=a.txt`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "x" });
    assert.equal(noAuth.status, 401);
    assert.equal((await s.upload("a.txt", "x", "application/json")).status, 415);
    assert.equal((await s.upload("a.txt", "x", "application/octet-stream", "0123456789abcdef")).status, 404);
    assert.equal((await s.upload("a.txt", "")).status, 400);
    // The server answers before reading the body and closes the connection, so the client may see 413 or a reset.
    const huge = await s.upload("a.txt", new Uint8Array(MAX_UPLOAD_BYTES + 1)).then((r) => r.status, () => 413);
    assert.equal(huge, 413);
    assert.equal((await fetch(`${s.base}/api/chats/${s.chat}/attachments/..%2f..%2fx`, { headers: s.headers })).status, 404);
    assert.equal((await fetch(`${s.base}/api/chats/${s.chat}/attachments/0123456789abcdef`, { headers: s.headers })).status, 404);
    const wrongOrigin = await fetch(`${s.base}/api/chats/${s.chat}/attachments?name=a.txt`, { method: "POST", headers: { ...s.headers, "Content-Type": "application/octet-stream", Origin: "http://evil.example" }, body: "x" });
    assert.equal(wrongOrigin.status, 403);
    const bad = await fetch(`${s.base}/api/chats/${s.chat}/ask`, { method: "POST", headers: s.json, body: JSON.stringify({ question: "x", attachments: ["0123456789abcdef"] }) });
    assert.equal(bad.status, 400);
  } finally {
    await s.stop();
  }
});

test("a file with a secret is marked blocked and nothing of it reaches the model", async () => {
  const s = await start();
  try {
    const r = await s.upload("keys.txt", `deploy token ${fakeSecret()}`);
    const { attachment: a } = (await r.json()) as { attachment: { id: string; status: string } };
    assert.equal(a.status, "blocked");
    const reply = await s.ask({ question: "what is in it?", attachments: [a.id] });
    assert.ok(!JSON.stringify(s.calls).includes(fakeSecret()));
    assert.match(reply.text, /Not sent to the model: "keys\.txt"/);
  } finally {
    await s.stop();
  }
});

test("open: only stored ids, only safe types, a program and an argument list", async () => {
  const s = await start();
  try {
    const pdf = (await (await s.upload("doc.pdf", "not really a pdf")).json()) as { attachment: { id: string; status: string; note?: string } };
    assert.equal(pdf.attachment.status, "unreadable");
    assert.match(pdf.attachment.note ?? "", /not a valid PDF/);
    const opened = await fetch(`${s.base}/api/chats/${s.chat}/attachments/${pdf.attachment.id}/open`, { method: "POST", headers: s.headers });
    assert.equal(opened.status, 200);
    assert.equal(s.launched.length, 1);
    assert.ok(s.launched[0]!.args[0]!.includes(pdf.attachment.id));
    assert.equal(s.launched[0]!.args.length, 1);
    for (const name of ["run.exe", "a.hta", "x.lnk", "page.html", "pic.svg", "m.docm", "s.ps1", "b.bat", "noext"]) {
      const a = (await (await s.upload(name, "echo hi")).json()) as { attachment: { id: string } };
      const r = await fetch(`${s.base}/api/chats/${s.chat}/attachments/${a.attachment.id}/open`, { method: "POST", headers: s.headers });
      assert.equal(r.status, 400, name);
    }
    assert.equal(s.launched.length, 1, "nothing refused was launched");
    assert.equal(fileOpenCommand("C:\\d\\f.pdf", "win32", { SystemRoot: "C:\\Windows" }).args.length, 1);
  } finally {
    await s.stop();
  }
});

test("extraction: text decoding, file names, a Word file, and honest answers for pictures and binaries", async () => {
  assert.equal(cleanFileName("C:\\x\\..\\y/z<>.txt"), "z__.txt");
  assert.equal(cleanFileName(".."), "file");
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))?.trim(), "hi");
  assert.equal(decodeText(Buffer.from([1, 0, 2])), null);
  const img = await extractText("a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.deepEqual([img.kind, img.status], ["image", "unreadable"]);
  assert.equal((await extractText("a.bin", Buffer.from([0, 1, 2, 3]))).status, "unreadable");
  // A minimal stored-and-deflated zip with word/document.xml.
  const xml = Buffer.from('<w:document><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:document>');
  const name = Buffer.from("word/document.xml");
  const data = deflateRawSync(xml);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(local.length + name.length + data.length, 16);
  const zip = Buffer.concat([local, name, data, central, name, eocd]);
  assert.equal(readZipEntry(zip, "word/document.xml", 1_000_000)?.toString(), xml.toString());
  assert.equal(readZipEntry(zip, "word/document.xml", 10), null, "the output cap holds");
  assert.equal(docxText(xml.toString()), "Hello & welcome\nSecond");
  const word = await extractText("a.docx", zip);
  assert.equal(word.text, "Hello & welcome\nSecond");
});

test("a small PDF with text is read (pdf.js through unpdf)", async () => {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 18 Tf 10 50 Td (Hello PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const r = await extractText("t.pdf", Buffer.from(pdf));
  assert.equal(r.status, "read", r.note ?? "");
  assert.match(r.text, /Hello PDF/);
});

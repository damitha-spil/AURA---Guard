# Capture events: the contract between the editor extension and Guard

For developers of the VS Code extension. Guard reads what the extension writes
to a local folder (the spool), and the extension calls a few Guard commands.
Both sides build to this text. Do not change it without changing both.

## The spool

Spool folder (`<spoolDir>`): the environment variable `AURA_GUARD_SPOOL`, or
else `.aura-guard/spool` inside the user's home folder (`os.homedir()`).

```
<spoolDir>/consent.json
<spoolDir>/<repoKey>/events-YYYY-MM-DD.jsonl      (local date)
```

### consent.json

```json
{"version":1,"acceptedAt":"2026-11-20T08:59:00.000Z","developer":"alex","repos":{"orders-app-540daa":true}}
```

`developer` is the developer's first name in lower case (`[a-z0-9-]`, up to 40
characters). A workspace is captured only while its key is `true` in `repos`.
Guard refuses to show or summarise a workspace without it.

### repoKey

`repoKey` = sanitized folder name + `-` + first 6 hex characters of the sha256
of the normalized absolute path.

1. Normalize the absolute path of the workspace root: replace `\` with `/`,
   lower-case it, remove trailing `/` (a bare drive root such as `c:/` keeps its
   slash).
2. Folder name = last non-empty segment of the normalized path. Replace every
   run of characters outside `a-z0-9` with `-`, then trim `-` from both ends.
   If nothing is left, use `repo`.
3. Hash = sha256 of the normalized path (UTF-8), lower-case hex, first 6
   characters.
4. `repoKey = <folder name>-<hash>`.

Reference code (Guard's own, `engine/src/capture/spool.ts`):

```ts
function normalize(p: string): string {
  let s = p.replace(/\\/g, "/").toLowerCase();
  while (s.length > 1 && s.endsWith("/") && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}
function repoKeyFor(abs: string): string {
  const norm = normalize(abs);
  const base = norm.split("/").filter(Boolean).pop() ?? "";
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `${slug}-${sha256hex(norm).slice(0, 6)}`;
}
```

Test vectors (Guard's tests check these):

| Absolute path | repoKey |
|---|---|
| `D:\Work\Orders App` | `orders-app-540daa` |
| `D:\Work\Orders App\` | `orders-app-540daa` |
| `d:/work/orders app` | `orders-app-540daa` |
| `C:\Users\Dev\Projects\Order-Entry_App` | `order-entry-app-b6d0f2` |
| `/home/dev/my.repo` | `my-repo-dac41a` |
| `C:/` | `c-508e9f` |

## One event per line

```json
{"v":1,"id":"<16 hex>","ts":"<ISO>","kind":"commit","repo":"<repoKey>","branch":"<name>","dev":"<first name lower case>","data":{}}
```

`kind` and its `data`:

| kind | data |
|---|---|
| `commit` | `{sha, subject, body?, files:[{path, added, removed}]}` (at most 40 files) |
| `save` | `{path, language, count, windowStart, windowEnd}` |
| `task` | `{name, exitCode, ms}` |
| `terminal` | `{command, exitCode, ms}` (allowlisted programs only; arguments already masked) |
| `diagnostics` | `{errors, warnings, files}` |
| `idea`, `decision`, `correction` | `{text, context?:{path, line}}` |
| `chat` | `{participant:"guard", question, answer, sources:[ref]}` |

All text must already be masked by the extension and capped: text 1000
characters, chat answer 4000, commit body 600. Guard checks every line with a
schema, skips bad lines (it counts them), and cuts anything over the caps. A
line over 64 KB, a duplicate `id`, a kind that `roles/capture.json` switches
off, and a terminal command whose program is not on the allowlist are skipped
too. Guard reads at most 16 MB of one day file and at most `maxEventsPerDay`
events.

## Company settings: `roles/capture.json`

```json
{"retentionDays":30,"maxEventsPerDay":5000,
 "terminalAllowlist":["git","cargo","npm","npx","node","tsc","vitest","playwright","pytest","dotnet","yarn","pnpm"],
 "capture":{"commit":true,"save":true,"task":true,"terminal":true,"diagnostics":true,"chat":true}}
```

`capture status` and every `capture summarize` delete spool days older than
`retentionDays`.

## Commands the extension calls

With `--json`, stdout is exactly one JSON object. Errors are
`{"ok":false,"error":"<plain words>"}` and the exit code is 1.
`<abs>` is the absolute workspace path.

### `aura-guard capture status --json`

```json
{"ok":true,"spoolDir":"...","consent":{"accepted":true,"developer":"alex"},
 "repos":[{"repoKey":"orders-app-540daa","days":3,"events":120,"oldest":"2026-11-18","newest":"2026-11-20"}]}
```

`developer` is `null` when there is no valid consent file.

### `aura-guard capture show --repo <abs> [--date YYYY-MM-DD] --json`

```json
{"ok":true,"date":"2026-11-20","events":[ ...events as stored... ],"skipped":0}
```

`skipped` is the number of lines Guard could not use. Refused (error) when this
workspace has no consent.

### `aura-guard capture summarize --repo <abs> [--date YYYY-MM-DD] [--no-model] --json`

```json
{"ok":true,"date":"2026-11-20","file":"ai-log/2026/11/2026-11-20-alex.md",
 "draft":"<markdown to append>","entries":3,"commits":2,
 "ideas":["..."],"questions":["..."],
 "sources":{"events":14,"transcriptTurns":6},
 "backend":"claude-cli","notes":1}
```

- `backend` is `claude-cli`, `anthropic-api` or `none` (`--no-model`, nothing new
  to summarise, or the model was not available).
- `fallback` (only when present) says in plain words why the model was not used.
- `notes` is how many proposed notes were written to Guard's own vault on this
  machine (decisions and corrections). Never into the repo.
- Defaults to today (local date). `<name>` in the file name is
  `consent.developer`.

**What to do with the draft.** Guard never writes into the repository. Show the
draft to the developer. After the developer confirms, append `draft` to `file`
(relative to the workspace root), creating folders and the file if needed. If
the file did not exist, the draft already starts with `# <date> · <name>`.
Separate it from existing text with one blank line. Do not edit the entries: the
marker lines (below) must stay.

**Draft format.** Exactly Aura's `ai-log/README.md` entry format, newest at the
bottom:

```markdown
## 10:12 · VS Code · feature/x

- **What:** Add retry limit
- **Why:** Unbounded retries hid failures.
- **Files:** src/a.ts
- **Commit:** abcdef1
- **Checks:** `npm test` exit 1, then 0

<!-- guard-capture: 4f1c2a9b7d03 ids:0000000000000001,0000000000000002 -->
```

Lines that do not apply are left out. The tool in the header is `VS Code`,
`Claude Code` or `VS Code + Claude Code`, depending on what the entry is based
on. The marker is `<!-- guard-capture: <hash> ids:<comma list> -->`: `hash` is
the first 12 hex characters of the sha256 of the sorted ids joined by commas;
`ids` are the spool event ids and Claude Code turn ids (`t-` plus 8 hex) the
entry rests on. On the next run Guard reads the target file and skips any entry
whose hash is present, any event or turn id that is listed, and any commit whose
sha already appears in a `**Commit:**` line (a commit hook may have logged it).
Summarising the same day twice therefore adds nothing new.

### `aura-guard capture purge --repo <abs> [--before YYYY-MM-DD | --all] --json`

```json
{"ok":true,"removed":2}
```

Deletes this workspace's day files (`--before`: days before that date;
`--all`: every day). Consent is kept. `capture purge --all --yes` (no `--repo`)
removes every workspace's day files and `consent.json`. Without `--yes` it
refuses. `removed` counts files.

### `aura-guard answer "<question>" [--notes-only] --json`

```json
{"ok":true,"text":"...","sources":[{"ref":"rule-erp-create","kind":"note","title":"...","status":"active"}],"backend":"claude-cli"}
```

Errors add `kind`: `blocked` (the question looked like a secret, nothing was
sent), `no-key`, `no-backend`, `api`, `cli`, `no-index`.

# SPIL Quality Support Bot Companion (VS Code extension)

The companion records what you do in the editor into a folder on your own PC,
lets you log ideas, decisions and corrections, adds an `@guard` chat helper,
and asks your own copy of SPIL Quality Support Bot to turn the day into ai-log entries you
review before anything is added.

It is in `extension/`. It needs VS Code 1.93 or newer and Node 24 or newer on
the PC (for Guard itself).

## What it does

- Records a small set of editor events (listed below) after you say yes.
- Shows its state in the status bar, always: capturing, paused, off, or needs consent.
- Lets you log an idea, decision or correction with one command.
- Adds `@guard` to the VS Code chat. It answers from Guard's notes.
- Drafts your ai-log entries from the day. You see a diff and confirm before anything is written. It never commits.

## Install

1. Build the package (once): in `extension/` run `npm install`, then `npm run package`.
   This writes `.artifacts/extension/aura-guard-companion-0.1.0.vsix`.
2. Install it: `code --install-extension <path to the .vsix>`, or in VS Code open
   Extensions, the `...` menu, **Install from VSIX**.
3. Run **Guard: Set up**. Pick the folder of your own SPIL Quality Support Bot clone. It checks Node and runs `capture status`.

## First run and consent

Nothing is recorded until you accept. The extension only becomes active in a
workspace that has `ai-log/README.md` at its root, or whose path is in the
`auraGuard.workspaces` setting. In any other workspace it shows **Guard: off**
and does nothing.

In an opted-in workspace it shows one dialog. It lists what is captured, what
never is, where it is stored, and how to pause or delete. Accepting writes
`consent.json` in the spool folder for you and this workspace. If you decline,
it does not ask again; click the status bar item to reconsider.

## What is captured

Only in opted-in, consented workspaces, and only on your PC:

| Source | What is stored |
|---|---|
| Git commits | Message, up to 40 file names with lines added and removed. Merge commits are skipped. |
| Saves | File name, language and a count per 5 minutes. |
| Tasks | Task name, exit code, duration. |
| Terminal | Commands that start with git, cargo, npm, npx, node, tsc, vitest, playwright, pytest, dotnet, yarn or pnpm. Arguments are masked. Exit code and duration. |
| Diagnostics | Counts of errors and warnings when a commit is detected. |
| Ideas, decisions, corrections | The text you type (up to 1000 characters) and, if you choose, the file and line. |
| `@guard` chat | Your question and the answer, masked and capped. |

Every text is masked first. If masking finds a secret, the whole event is
thrown away and the "dropped" counter in the status bar goes up. At most 5000
events are kept per day. Guard removes old data on its retention schedule.

**Never captured:** file contents, keystrokes, the clipboard, the browser,
terminal output, anything outside opted-in workspaces. Details are in
[capture-privacy.md](capture-privacy.md) and the event format is in
[capture-events.md](capture-events.md).

Where it is stored: `<spool>/<repoKey>/events-YYYY-MM-DD.jsonl`, plus
`<spool>/consent.json`. The spool is the `auraGuard.spoolDir` setting, else the
`AURA_GUARD_SPOOL` environment variable, else `~/.aura-guard/spool`. It must be a
local folder; network paths are refused.

## Settings

| Setting | Meaning |
|---|---|
| `auraGuard.guardHome` | Folder of your Guard clone. Required. |
| `auraGuard.nodePath` | Node to run Guard with. Empty uses `node` from PATH. |
| `auraGuard.spoolDir` | Local spool folder. |
| `auraGuard.workspaces` | Extra workspace paths to capture, besides those with `ai-log/README.md`. |
| `auraGuard.developerName` | Your first name, lower case. Empty uses the first word of `git config user.name`. |
| `auraGuard.capture.commits`, `.saves`, `.tasks`, `.terminal`, `.diagnostics`, `.chat` | Switch one source on or off. |

## Commands

All start with "Guard:".

- **Log an idea / Log a decision / Log a correction**: type a line. You can attach the current file and line number. A text with a secret is refused.
- **Show today's captured events**: opens today's file read-only, so you can see exactly what is stored.
- **Summarize my day**: runs Guard, shows its questions, then a diff of the ai-log file with the draft added. Choose **Apply** (adds and saves, no commit), **Edit first** (adds without saving so you can edit), or **Cancel**.
- **Pause or resume capture**.
- **Delete my data**: asks to confirm, then removes this workspace's captured events (through Guard's `capture purge`; if Guard is not set up, directly from the spool).
- **Open Guard chat window**: starts Guard's own chat window.
- **Set up**: guided setup described above.
- **Show menu**: the same menu as clicking the status bar item. It also says if terminal capture is unavailable.

## Review, pause, delete, uninstall

- Review: **Show today's captured events**, or open the files in the spool folder.
- Pause: click the status bar item, then **Pause capture**. Nothing is recorded while paused.
- Delete: **Delete my data**.
- Uninstall: remove the extension in VS Code. Capture stops. Your spool folder stays until you delete it.

## Limits

- It cannot read other assistants' chat windows (Copilot Chat, Cursor and so on).
- Claude Code conversations are picked up by Guard from your own local Claude Code transcripts when you summarize; the extension does not read them.
- `@guard` and the manual log commands cover the rest.
- Terminal capture needs VS Code shell integration. Where it is missing, terminal capture is off and the menu says so.
- It watches the first folder of the window. Multi-root workspaces are not covered.
- Commit capture uses the built-in Git extension.

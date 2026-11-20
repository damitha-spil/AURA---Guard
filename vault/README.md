# SPIL Quality Support Bot vault

Open this folder in Obsidian. Each note is a Markdown file that starts with a
short block of settings between `---` lines. Guard reads these notes and
rebuilds its search index from them, so the notes are the truth.

## Settings at the top of a note

- `id`: lower-case words joined by dashes. It must be unique.
- `type`: `rule`, `adr` (a decision), `pattern`, `incident`, `domain`, `diary` or `choice`.
- `status`: see below.
- `audience`: who may see it: `internal_dev`, `qa_internal`, `customer_support`.
- `department`: for example `dev`.
- `source`: where it came from, for example `owner-answer`, `commit`, `import`.
- `code_anchors`: the code the note is about (`repo`, `path`, optional `symbol`). When that code changes, the note is flagged for a check.
- `created`: date as `YYYY-MM-DD`.

## Statuses

1. `proposed`: written down, not checked by the owner yet.
2. `shadow`: tried quietly, not enforced.
3. `active`: approved and used in reviews.
4. `stale`: the code it describes changed; needs a look.
5. `deprecated`: no longer true. Kept for history.

New notes are always `proposed`. Only the owner moves a note to `active`.
Never put passwords, addresses or personal details in notes.

## Opening the vault in Obsidian

1. In Obsidian, choose "Open folder as vault" and pick this `vault` folder.
2. Obsidian reads the shared settings in `.obsidian/`. Templates are in
   `_templates/`: use the Templates command to start a new note of each type.
3. New notes land in `inbox/`. Move them to their type folder when the owner
   has reviewed them.
4. The graph view and backlinks show how notes relate. Links are ordinary
   Markdown links, not wiki links.

Window layout and caches stay on your machine (git ignores them). Graph data
from graphify lives in the SQLite index only, not in this vault.

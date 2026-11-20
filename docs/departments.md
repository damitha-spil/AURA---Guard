# Departments

SPIL Quality Support Bot (SPIL QSB) serves several departments. Each department has its own
knowledge: its own vault, index and chats. One department never reads another department's data.

The command stays `aura-guard`. Old `AURA_GUARD_*` settings still work. New `QSB_*` names work too
and win when both are set (for example `QSB_DEPT`).

## The model

A department has modules, a module has sub-modules, and sources can sit at any of the three levels.

- Department: id, name, description, owner, template, color, helpers (roles), modules, sources.
- Module: id, name, description, sub-modules, sources.
- Sub-module: id, name, description, sources.
- Source: `git` (a repository, read with read-only git commands) or `docs` (a plain folder of
  `.md`, `.mdx`, `.txt`, `.rst` files, no git needed). A source path must be a full local path
  (`D:\folder` or `/home/me/folder`). Network paths (`\\host`), web addresses, relative paths and
  `..` are refused.

Ids are lower-case words joined by dashes (2 to 40 characters). They are made from the name when
left out, and are unique inside their parent. Source ids are unique in the department.

The registry is `data/departments/registry.json`. It is local and never committed (`data/` is
ignored). It is written in one step (temp file, then rename), the previous version is kept as
`registry.json.bak`, and every change carries an `etag` (a hash of the file). A change made with an
old etag is refused with a conflict.

`departments.example.json` shows the shape with made-up folders.

## Where the knowledge lives

| Storage | Vault | Index | Chats and reports |
|---|---|---|---|
| `department` (default for new ones) | `data/departments/<id>/vault/` | `data/departments/<id>/guard.db` | `data/departments/<id>/` |
| `legacy` (one department only) | `vault/` | `data/guard.db` | `data/` |

`legacy` keeps today's folders, so nothing existing is moved. With no registry file, Guard derives
one legacy department (`default`) from `guard.config.local.json` and behaves as before.

A new department gets the vault folders (`rules adr patterns domain diary choices incidents
journeys support inbox`) plus a copy of `vault/README.md` and `vault/_templates`.

## How isolation is kept

- `resolveDepartment(registry, id)` is the only way to get a department's config and paths. The
  server, the CLI and the MCP server all use it.
- A department's config points at its own vault, index and data folder. Reports, chats, the inbox,
  search and `/api/doc` read from that config only.
- The server builds one context per department on first use (config, index handle, chat store) and
  closes them when it stops.
- Tests cover this with two departments that hold different notes and documents
  (`engine/test/departments.test.ts`).

## Templates

`roles/department-templates/*.json` (editable by the company): `engineering`, `knowledge`,
`support`, `analysis`, `custom`. Each has a name, a plain description, default helpers and a hint
for the setup screen.

## Command line

```
aura-guard --dept <id> <command>      # or QSB_DEPT / AURA_GUARD_DEPT; default = registry default
aura-guard dept list
aura-guard dept show <id>
aura-guard dept add <id> --name ".." [--template engineering] [--description ".."]
aura-guard dept source add <dept> --path <folder> [--kind git|docs] [--module m] [--sub s] [--label l]
aura-guard dept module add <dept> <name> [--description ".."]
aura-guard dept sub add <dept> <module> <name>
aura-guard dept archive <id>
aura-guard dept purge <id> --yes        # deletes only that department's folder; never the legacy one
aura-guard dept seed                    # creates the starting set from data/departments/seed.json, only if the registry is empty
aura-guard index --all                  # every department, one after the other
aura-guard daily --all
```

`dept source add` checks that the folder exists, is a folder, and (for `git`) is a git repository.
Without `--kind` it picks `git` for a repository and `docs` otherwise.

## The starting set (`dept seed`)

`dept seed` creates a first set of departments from a LOCAL seed file,
`data/departments/seed.json`. That file is git-ignored: department names, modules and folder paths
are company facts and never go into code or git. To use it:

1. Copy `departments.seed.example.json` to `data/departments/seed.json`.
2. Edit it: each department has an id, name, template, colour, and optional modules, sub-modules
   and sources (full local folder paths).
3. Run `aura-guard dept seed`.

A source is created only when its folder exists on this computer; the rest is created empty and shown
as "needs sources". If the registry already has departments, `dept seed` changes nothing. Without a
seed file it says where to put one. You can also skip the seed and add departments in the app.

## API

All endpoints keep the token cookie, the Host and Origin checks, the size cap and the CSP.

- `GET /api/departments` returns product name, default department, each department with counts and
  health, the templates, and the `etag`.
- `POST /api/departments` creates one (201). 400 for bad input, 409 for a duplicate id.
- `GET /api/departments/:id` returns the department, its etag, health, and each source with a
  read-only status check.
- `PUT /api/departments/:id` with `{department, etag}` replaces the whole department. 409 if the
  etag is old.
- `DELETE /api/departments/:id` with `{confirm:"<id>", purge?}` archives, or with `purge` deletes the
  department's folder and removes it from the list. Purging the legacy department is refused (400).
- `POST /api/departments/:id/sources/check` with `{path, kind}` checks a folder. It never returns
  file contents.

Every other endpoint takes `dept` (query on GET, JSON field on POST). An unknown department is 404. A
write to an archived department is 410. Commands started from the chat get `--dept <id>`.

MCP: `QSB_DEPT` or `AURA_GUARD_DEPT` picks the department for the stdio server.

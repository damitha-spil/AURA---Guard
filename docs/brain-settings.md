# Model and API key settings

Guard can choose its model and keep an Anthropic API key without hand-editing files.

## Where each value comes from

For every value, the first of these that is set wins:

1. Environment: `QSB_<NAME>`, then `AURA_GUARD_<NAME>` (`BRAIN`, `MODEL` for the API model, `CLI_MODEL` for the plan model). The key is `ANTHROPIC_API_KEY`.
2. `data/settings.json` (this machine, written by the screen or `brain backend` / `brain model`).
3. `guard.config.local.json`, the `brain` section.
4. Built-in default: backend `auto`, model `claude-sonnet-5-5` (API) or `sonnet` (plan).

`data/settings.json` holds only `{ "version": 1, "brain": { "backend", "models" } }`. It never holds the key. The previous file is kept as `settings.json.bak`. Settings are per machine.

## The model list

`roles/models.json` lists the models the picker offers (id, label, plain note, which backend). Model ids change, so edit that file when they do. A custom id is allowed if it uses only letters, digits and `. _ : -`, is at most 80 characters and starts with a letter or digit.

## The API key

The key is stored encrypted, never in a plain file.

- **Windows:** DPAPI (`CurrentUser` scope) through PowerShell. The key goes to PowerShell on stdin; the encrypted text is saved in `data/secrets/anthropic.key.dpapi`. It is decrypted for each request and not kept.
- **macOS / Linux:** `security` or `secret-tool`, only if installed, with the key on stdin. Otherwise Guard says to use the `ANTHROPIC_API_KEY` environment variable. (Written to the tools' documented behaviour; not run on those systems.)
- An environment key always wins over a stored one.

What this protects: other users of the computer, and someone who copies the disk. What it does not protect: a program running as the same signed-in user, which can ask Windows to decrypt the key the same way Guard does. Keep the account locked down and use a key with a spending limit.

A key must have no spaces or line breaks, 20 to 300 plain printable characters. No prefix is required. It is never returned by the API, printed, logged or put in an error.

## API (behind the token cookie and the Host/Origin checks)

All replies carry `Cache-Control: no-store`. Request bodies are limited to 4 KB.

- `GET /api/brain` returns `wanted`, `wantedSource`, `picked`, `reason`, `backends[]`, `models {current, sources, catalogue}`, `apiKey {source, storage, canStore}`, `planCli {found, version?, path?}`.
- `PUT /api/brain` with `{backend?, models?}`. `models` values of `null` clear a choice. Returns the same shape as GET.
- `PUT /api/brain/key` with `{key}`. Returns `{ok, source, stored}`; `source` is `env` (with a `message`) when the environment key is set and wins.
- `DELETE /api/brain/key` removes the stored key.
- `POST /api/brain/test` runs one tiny masked call. Returns `{ok, backend, model, ms, error?}`.

## Command line

```
brain models
brain backend <auto|anthropic-api|claude-cli>
brain model <anthropic-api|claude-cli> <model name>
brain key set        (reads stdin or a hidden prompt; never an argument)
brain key status
brain key remove
```

# Developer activity capture: privacy and control

For developers and managers. **This is activity monitoring.** It records what a
developer does in their editor so that the engineering diary writes itself. It
should be introduced with the team's agreement, and the team must be told before
it is rolled out. It is off until each developer switches it on, for each
workspace.

## What is captured

Only inside workspaces the developer has opted in, and only these things:

- commits: the id, subject, message body (short) and the changed file names with line counts
- file saves: which file, how many saves, and when (not what was in it)
- tasks and allowed terminal commands: the name, exit code and how long it took
- the number of editor errors and warnings
- ideas, decisions and corrections the developer types in on purpose
- questions the developer asks Guard in the editor, and Guard's answers

Text is masked in the editor before it is written (secrets, addresses, names)
and cut to a short length.

## What is never captured

- file contents or diffs
- keystrokes
- the clipboard
- the browser or any other program
- anything outside the workspaces the developer opted in
- raw terminal output (only the command, exit code and time, and only for an
  allowlisted list of programs such as git, npm and cargo)

## Where it is stored

On the developer's own computer only, in a local folder (the spool), as masked
text files. Guard's setting `roles/capture.json` controls how many days are kept
(30 by default) and which kinds are recorded. Older days are deleted
automatically.

## What leaves the machine

Nothing, unless the developer reviews a draft and commits it.

- Guard turns the day into a **draft** of the team's AI activity log. The draft is
  shown to the developer. Nothing is written to the repository until the developer
  confirms, and it is only shared if the developer commits and pushes it.
- To write the draft, Guard sends masked text (the day's events and the
  developer's own Claude Code prompts and final answers) to the developer's own
  Claude plan or API key. A value that looks like a secret stops the call. Every
  call is logged by hash and count only.
- `capture summarize --no-model` builds a plainer draft without sending anything.
- Decisions and corrections also become proposed notes in Guard's own folder on
  that machine. They are never put in the repository.

## See it, pause it, delete it

- **See it:** `aura-guard capture show --repo <workspace folder>` prints the
  stored events for a day. `aura-guard capture status` lists what is stored.
- **Pause it:** switch capture off for the workspace in the editor. Nothing new
  is recorded.
- **Delete it:** `aura-guard capture purge --repo <workspace folder> --all`, or
  `--before <date>`. `aura-guard capture purge --all --yes` removes everything,
  including the consent.

## Rules of the road

- Opt-in per developer and per workspace. Nobody can switch it on for someone else.
- The log is for the developer's own diary and for Guard to learn how the product
  is built. It is not a performance measure and must not be used as one.
- Managers see only what developers choose to commit to the team's log.
- Tell the team before rollout, explain this page, and agree it together.

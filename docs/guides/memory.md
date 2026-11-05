# Memory

nax keeps short Markdown notes that later sessions can read: facts about the project,
feedback on how to work, references. `nax chat` and `nax run` sessions see an index of the
notes in their prompt and read, search, save and forget notes through the `nax-memory__*`
tools. You manage the same notes from the terminal with `nax memory`.

---

## Where notes live

| Place | What it holds | Who writes it |
|:------|:--------------|:--------------|
| `~/.nax/memory/projects/<name>-<hash8>/` | The project mirror: `notes/<slug>.md`, the generated `MEMORY.md` index, the outbox of undelivered writes, `sync.json` | Agents (`nax-memory__save`) and `nax memory save` |
| `~/.nax/memory/user/` | User notes shared by every project on this machine | Agents and `nax memory save --scope user` |
| `<repo>/.nax/memory/<slug>.md` | Team notes committed to the repository, read-only to nax | You, by hand, through git |

`<name>` is the `name` in the project's `.nax/config.json`. `nax memory status` prints the
resolved directories.

With `memory.provider: "mcp"`, the notes also live on an MCP memory server (for example
OpenMemory); the mirror is the local copy and the outbox holds writes made while the server
was unreachable, which the next sync delivers.

---

## Configuration

```json
{
  "memory": {
    "enabled": true,
    "provider": "local",
    "writeMode": "direct",
    "indexBytes": 24576,
    "askOnSave": true,
    "inRun": true
  }
}
```

| Key | Default | Meaning |
|:----|:--------|:--------|
| `enabled` | `true` | Master switch: `false` means no memory tools, no index and no sync |
| `provider` | `"local"` | `"local"` keeps notes in the mirror; `"mcp"` keeps them on the server named by `memory.mcp.server` (which must be defined in `mcp.servers`) |
| `writeMode` | `"direct"` | `"direct"`: a save or forget takes effect at once. `"proposal"`: it waits until `nax memory approve <slug>` |
| `indexBytes` | `24576` | Byte cap of the index injected into the prompt (512 to 262144); notes past it are omitted and counted |
| `askOnSave` | `true` | In a guarded native `nax chat`, ask before `nax-memory__save` and `nax-memory__forget` run |
| `inRun` | `true` | Give `nax run` sessions the index and the memory tools; `false` leaves runs without memory |

`nax config` shows every `memory.mcp.*` key with its description.

---

## Commands

```bash
nax memory status                  # provider, write mode, directories, last sync, outbox, counts
nax memory list [--type T] [--scope S]
nax memory show <slug> [--scope S]
nax memory save --slug <slug> --type <type> --description <text> (--body <text> | --body-file <path>) [--scope S]
nax memory forget <slug> --reason <text> [--scope S]
nax memory approve <slug> [--scope S]
nax memory sync
nax memory requeue (<slug> [--scope S] | --all)
```

With the koda provider, koda decides the write mode per agent, so `nax memory status` prints `write mode: decided by koda` and `--json` reports `"writeMode": "koda"`.

Every command takes `-d, --dir <path>` (the project directory) and `--json`. Types are
`user`, `feedback`, `project` and `reference`; scopes are `project` (the default) and `user`.
A slug is 1-64 lower-case letters, digits or `-`.

### Rejected writes

A write the provider refuses is kept in the outbox as `rejected`, with the reason. A sync
also parks a write as `rejected` when the provider keeps answering it with a response it
cannot use (3 times), but only after the next queued write for a different note goes through,
which shows the fault is that write's and not the provider's. A provider that answers every
write badly (a version mismatch, for example) parks nothing: the queue waits.

`nax memory status` lists each rejected write and why, and `nax memory sync` names any it
parked. A rejected write is never retried on its own, and `nax memory link --force` and
`nax memory reset` refuse while one is held. `nax memory requeue` puts it back in the queue
for the next sync. A parked forget leaves the note active on the provider until it is delivered.

### Proposal mode

Under `memory.writeMode: "proposal"`, an agent's save lands as `pending` and an agent's
forget is held as `(forget pending)`; both show in `nax memory list` and in the index the
next session reads. `nax memory approve <slug>` carries out what is waiting:

- a pending save becomes `active` (`approved project/<slug>`);
- a pending forget retires the note (`forgot project/<slug> (forget approved)`);
- a note with nothing waiting is left alone (`project/<slug> is already active; nothing to approve`).

Saving the slug again clears a pending forget.

---

## Repository notes

A note committed under `.nax/memory/` is shared with everyone who clones the repository.
It needs only `slug` (equal to the file name without `.md`), `type` and `description`,
then one blank line and the body:

```markdown
---
slug: staging-db
type: project
description: the staging database is shared; never reset it
---

Ask in #infra before running migrations against staging.
```

nax fills in the rest: `id` is the slug, `scope` is `project`, `status` is `active`,
`source` is `repo`, and `updatedAt` is the file's modification time. A repository note is
read-only to nax: `forget` and `approve` refuse it and point at the file.

A file that breaks a rule is skipped, and `nax memory` prints the file and the reason, for
example:

```
[memory] repo note skipped: path=/repo/.nax/memory/staging-db.md reason=invalid note: memory note invalid: type: Invalid option
```

Notes are refused when they contain a secret (an API key, a token); the reason names only
the kind of secret.

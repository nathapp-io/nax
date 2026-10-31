# nax chat: `@` file mentions

Status: DESIGN DRAFT, 2026-10-31. Brainstormed with the user the same day;
builder check done and folded (no question needed the user).
**APPROVED by the user 2026-10-31, not yet specced.** The next
step is spec-writing (nax-spec-kit), then `nax plan` / `nax run` under the
standing approval rule.

## 0. How to read this document

This document is meant to stand alone. A fresh session with no memory should
be able to spec from it. Every decision is tagged **user** (said by the user,
do not re-litigate), **Claude** (a default proposed in this draft that the
user may change) or **builder** (open).

Process rules that bind anyone working this document (standing user rulings):

- Nothing gets built, scaffolded or installed until the user approves this
  document.
- `nax plan` and `nax run` are billed. Never launch either without explicit
  approval at the launch moment. That includes a re-plan or a re-run.
- Before any push, run the full `bun run check:all` from the repo root. Never
  run a bare `bun test` or `bun run nax`.
- nax never merges a PR and never releases. The user merges, and the user
  starts releases.
- Pipeline mode is FROZEN. Nothing here touches it.

## 1. Intent

In `nax chat` the user points the agent at a file by typing `@` and picking
it, the way Claude Code does. The file's contents travel with the message, so
the agent answers about the file without first spending a turn reading it.

This is the first half of a chat-input item on the coding-agent roadmap
("`@` file mention / image paste"). The recon on 2026-10-31 split it: images
need content-part plumbing through nax-ai, nax-agent, the session store, history
replay and the ACP brains (a message is a plain string end to end today, and
the nax ACP server advertises `image: false`), so images are a later, separate
feature (**user**, 2026-10-31: "@ mentions first").

## 2. Goals

- G1. Typing `@` in the chat input opens a file picker; picking a row inserts
  the path. (**user**)
- G2. On send, each mentioned file's **contents** go with the message, like
  Claude Code. (**user**, 2026-10-31: "send the contents, like claude code")
- G3. It works the same for every chat brain: native models and the ACP brains
  (Claude Code, Codex, Cursor). (**Claude**)
- G4. The transcript stays readable: the user's message shows as typed, with
  a short note per attached file, not a wall of file text. (**Claude**,
  user confirmed the picture 2026-10-31)
- G5. Resume and brain switching keep the attached contents, because they are
  part of the stored message. (**Claude**)

## 3. Non-goals

- Images and screenshots (separate feature, see §1).
- Line ranges (`@file#L10-40`). A later addition; the token grammar in §4.3
  must leave room for it, nothing more.
- Mentions of anything that is not a repo path: URLs, symbols, MCP resources,
  agents, sessions.
- Mentions inside slash commands (`/skill foo @x`, `/plan ...`). Only a plain
  chat message expands mentions in v1. (**Claude**)
- `nax run` / `nax plan` / bot prompts. Chat only.
- Re-reading a file later in the conversation. The contents are a snapshot at
  send time; a changed file needs a new mention.
- Any change to the nax ACP server (`packages/nax-agent-acp/src/server/`) or
  to koda.

## 4. Behaviour

### 4.1 The picker

- Typing `@` at the start of the input or after whitespace opens a list under
  the input, styled and keyed like the slash menu (`SlashMenu.tsx`,
  `slash-menu.ts`, `use-slash-menu-keys.ts`): up/down move, Tab or Enter
  inserts the selected path followed by a space, Esc closes the list and
  leaves the typed text alone. (**Claude**, user confirmed)
- The text after `@` filters the list as the user types (fuzzy match on the
  repo-relative path). (**Claude**)
- Rows: repo files, tracked plus untracked-but-not-ignored, and their parent
  folders (shown with a trailing `/`). Source of truth is
  `git ls-files --cached --others --exclude-standard` in the chat's repo root.
  (**Claude**) Gitignored files never appear.
- The list is built once per chat session start and refreshed when the picker
  opens if it is older than a short interval. (**builder** picks the interval
  and whether to refresh in the background.)
- Outside a git repo the picker shows no rows (one dim line saying so); a typed
  path still expands on send. (**Claude**)
- Enter while the picker is open inserts the row, it does not submit. Enter
  with the picker closed submits as today.
- Inserting replaces only the `@query` token under the cursor, wherever the
  cursor is in the line; the rest of the text is untouched. A path with spaces
  is inserted in the `@"..."` form (§4.3). (**Claude**)
- Folders drill down: Tab on a folder row inserts `@dir/` and keeps the
  picker open, now filtering inside that folder; Enter on a folder row inserts
  `@dir/ ` and closes it (the folder itself is the mention). Tab and Enter on
  a file row both insert and close. (**Claude**)

### 4.2 What gets sent

When a plain message is submitted, nax finds the mention tokens (§4.3),
resolves each, and builds the message the brain receives:

```
<the user's text, verbatim, mentions included>

<attached file 1>
<attached file 2>
...
```

- Each attachment is an envelope headed by the repo-relative path, holding the
  file text. (**Claude**) The exact envelope is the builder's, with one hard
  rule: it must round-trip. A `parse` must recover the user's text and every
  attachment's path, kind and note exactly, for **any** file contents,
  including contents that contain the envelope's own closing marker. The
  reverse must also hold: text the user typed or pasted (including a copy of
  an earlier expanded message) must never parse as attachments nax did not
  make. The builder picks the mechanism (for example a header manifest with
  per-attachment byte lengths that must match exactly). Precedent
  for the pattern: `chat/skill-invocation.ts` (`parseSkillInvocation`, the
  inverse of the skill envelope, used by `tui/chat/history-replay.ts`).
- Expansion happens once, on the TUI side, through the existing async
  `prepare` step of `sendTurn` (`tui/chat/ChatApp.tsx`, the path a skill
  invocation already takes: `prepare` returns `{ message }` or `{ notice }`,
  the transcript entry is built by parsing the prepared message, and the typed
  text is passed to `host.send` as the `title`). The expanded string is what
  `host.send` receives, so it is what every brain gets and what the session
  store saves. `chat/chat-host.ts` and the `ChatHost` interface do not change
  (that file has 14 lines of headroom under the cap). The expander itself is a
  pure module with injected file reads, wired into the TUI. No brain,
  session-store or ACP protocol change. (**Claude**, chosen after the builder
  check found the live transcript is built before `host.send`.)
- The session title stays the text the user typed, never the expanded
  message (the existing `title` argument). (**Claude**)
- For the ACP brains this means the file
  travels inside the one text block `nax-agent-acp/src/client/turn.ts` already
  sends, not as an ACP `resource` block. (**Claude**: one path for all brains;
  sending ACP resource blocks is a possible later refinement.)
- Files are read at send time, once per message. The same path mentioned twice
  attaches once. (**Claude**)
- Order of attachments = order of first mention. (**Claude**)

### 4.3 Which tokens are mentions

- A mention is `@` at the start of the message or after whitespace, followed
  by a path up to the next whitespace. (**Claude**)
- Paths are relative to the chat's working directory (`cwd`), like Claude
  Code; the picker lists and inserts cwd-relative paths, and a typed token
  resolves against `cwd`. The safety boundary is the repo root (`repoRoot`):
  a path whose real path leaves `repoRoot` is refused (§4.4). In the common
  case `cwd === repoRoot`. The envelope header records the path as typed.
  (**Claude**)
- "Inside the repo" means the real path is under `repoRoot`. A submodule's
  files are inside by that rule and attach if typed; the picker does not list
  them (`git ls-files` does not). (**Claude**)
- A path containing spaces is written `@"path with spaces"`; the picker inserts
  that form for such a path. (**Claude**)
- Trailing sentence punctuation (`.,;:!?)`) right after a path is not part of
  the path when the path without it resolves and the path with it does not.
  (**Claude**)
- A token that does not resolve to an existing file or folder inside the repo
  is plain text, left untouched and silent. This keeps `@nathapp/nax-agent`,
  emails and `@someone` harmless. (**Claude**)
- The grammar must not prevent a later `#L10-40` suffix (§3).

### 4.4 Limits and refusals

All per attachment unless stated. Sizes are **Claude** defaults; the builder
puts them in one place (config or constants, builder's call).

| Case | What is sent | Note shown |
|---|---|---|
| Path resolves outside the repo root (`..`, absolute path, or a symlink whose real path leaves the repo) | nothing; the token stays plain text | `@x not attached: outside the repo` |
| Gitignored file or folder (an ignored folder is refused outright) | same as outside: not attached | `@x not attached: ignored by git` |
| Binary file (builder picks the test, e.g. NUL byte in the first 8 KB) | path only | `@x attached as path only: binary` |
| File larger than ~100 KB | the first ~100 KB, cut on a line boundary, plus a marker that it was cut | `@x attached · first N of M lines` |
| All attachments together over ~400 KB | files after the cap attach as path only | `@x attached as path only: message too large` |
| Folder | a listing of the folder's direct entries (files and subfolders, gitignored excluded), not their contents | `@dir/ attached · N entries` |
| Unreadable file (permissions, vanished since picking) | nothing | `@x not attached: <reason>` |

Every resolved-or-refused mention gets a record in the expanded message,
refused and path-only ones included: kind (attached, cut, path-only, folder,
refused), path and note. Only tokens that do not resolve to anything at all
(§4.3) get no record. So the model also sees that the user meant a file it
did not get, and replay can rebuild every note (§4.5). (**Claude**) Notes
appear in the transcript under the user's message. Nothing here blocks the
send: a message with every mention refused is still sent.

### 4.5 Transcript

- The user's message renders as typed. Each attached `@path` is highlighted
  (theme accent, builder picks). (**Claude**)
- Under it, one dim line per mention with its note from §4.4, for example
  `attached chat-host.ts · 586 lines`. (**Claude**)
- The attached contents are hidden by default; clicking a note line expands
  that file's contents inline, clicking again collapses it, like a tool card
  (`tui/chat/transcript-click.ts`, `tool-card.ts`). (**Claude**, marked as a
  guess in the brainstorm and not objected to)
- This needs a new transcript entry kind (or an extension of `user`) that
  carries the typed text, the per-mention records and per-file expand state:
  no current kind does. Layout (`layout*.ts`) and click handling change with
  it; `tui/chat/transcript-click.ts` toggles only `thinking`, `tool` and
  `skill` today and gains this kind. (**Claude**)
- Live and replay build the entry the same way: by parsing the expanded
  message with the §4.2 `parse`. Live does it in `sendTurn` where it parses
  for skills today; replay in `tui/chat/history-replay.ts` `replayUser`. So a
  resumed session looks the same as the live one, refusal notes included. A
  stored message that does not parse renders as plain user text, as today.
- The input history (up arrow) recalls what the user typed, not the expanded
  message.

### 4.6 Context accounting

The expanded message is what the model sees, so the status line's context
usage counts it. Nothing extra to build; the builder only confirms the
existing accounting runs on the expanded string. (**Claude**)

## 5. Constraints

- The repo's 600-line source cap
  (`packages/repo-tooling/scripts/check-file-sizes.ts`, `SRC_LIMIT`) checks
  `.ts` files only. `chat/chat-host.ts` is 586 lines, so it is a hard limit
  there (and §4.2 keeps it unchanged). `tui/chat/ChatInput.tsx` (627 lines)
  and `ChatApp.tsx` are `.tsx`, not gate-checked, but already large. New
  logic goes in new small modules
  (picker model, mention parser/expander, file lister), not into those files.
- Mention parsing, expansion and the envelope `parse` are pure functions with
  injectable file reads, so they unit-test without a real repo.
- Path safety (§4.4 first rows) is checked on the real path after symlink
  resolution, not on the typed string.
- No new runtime dependency for fuzzy matching unless the repo already has
  one; check first.

## 6. Left to the builder

- The envelope format, within the round-trip rule (§4.2).
- File-list refresh interval and background refresh (§4.1).
- The fuzzy-match ranking.
- The binary-file test.
- How the slash menu and the mention picker share code (a shared list
  component is welcome, not required).
- Where the size limits live (config vs constants).
- Story split. Rough guess (**Claude**): mention grammar + expander +
  envelope parse; file lister + picker model; picker UI in the input;
  transcript note lines + expand/collapse + replay.

## 7. Glossary

- **Mention**: an `@path` token in a chat message that resolves to a repo file
  or folder.
- **Attachment**: the contents (or path-only stand-in) a mention adds to the
  sent message.
- **Brain**: the model or ACP agent driving the chat turn (native, Claude
  Code, Codex, Cursor).
- **Envelope**: the delimited block that carries one attachment inside the
  message string.

# SPEC: `@` file mentions in nax chat

## Summary

In `nax chat` the user types `@` to pick a repo file or folder, and on send each mentioned file's contents travel with the message, the way Claude Code does it. Typing `@` in a plain message opens a picker under the input (rows from `git ls-files`, fuzzy-filtered, folders drill down). On submit, the TUI expands every `@path` token that resolves to a file or folder: the message the brain receives is the typed text followed by a `<nax-mentions>` block holding one record per mention (the file text, a cut prefix, a folder listing, or a path-only/refused record with a note). The expansion runs once in the TUI's `sendTurn` `prepare` step, so every brain (native, Claude Code, Codex, Cursor) gets the same string and the session store saves it; `chat/chat-host.ts` does not change. The transcript shows the typed text with each mention highlighted, then one collapsible line per mention; history replay rebuilds the same entries by parsing the stored message.

Source design (approved 2026-10-31): `docs/superpowers/specs/2026-10-31-nax-chat-file-mentions-design.md`.

## Motivation

- The coding-agent roadmap lists "`@` file mention / image paste" as an open chat-input item. The user chose `@` mentions first (2026-10-31); images need content-part plumbing through every layer and are a separate later feature.
- Today the user must name a file in prose and wait for the agent to spend a turn reading it. The user ruled (2026-10-31) that a mention sends the contents, like Claude Code.
- Every chat message is a plain string end to end (`ChatHost.send(message: string, ...)`, the ACP client sends one `{ type: "text" }` block in `nax-agent-acp/src/client/turn.ts`), so expanding mentions into that string reaches every brain with no brain, store or protocol change.

## Design

### Integration

Read-only symbols (verified 2026-10-31):

- `packages/nax/src/tui/chat/ChatApp.tsx`
  - `submit(message)`: a non-slash message calls `noteUserTurn()` then `sendTurn(message)`.
  - `sendTurn(message, prepare?, title = message)`: awaits `prepare()` when given (`{ message } | { notice }`; a notice is appended and nothing is sent), appends `parseSkillInvocation(prepared.message)` as a `skill` entry or else `{ kind: "user", text: prepared.message }`, then calls `host.send(prepared.message, onEvent)` when `prepared.message === title`, else `host.send(prepared.message, onEvent, { title })`.
  - `ChatAppProps.cwd` (defaults to `host.repoRoot`); `ChatHost.repoRoot`.
  - `_chatAppDeps = { tmux }` — the existing environment seam (`test/ui/chat/background-keys.test.tsx` spies it).
  - Slash menu wiring: `slashMenuQueryState`, `useSlashMenuKeys`, `menuOwnsKeys()`, `bottomBlocked(ask, picker.model)`, `dismissedQuery`, `<SlashMenu ... />`, `ChatInput` prop `yieldNavigation`.
- `packages/nax/src/cli/chat.ts` `screenProps(host, deps, cwd)` passes the process `cwd` to `ChatAppProps.cwd`; `composeChat` sets `repoRoot = dirname(findProjectDir(cwd))` or `cwd`.
- `packages/nax/src/chat/skill-invocation.ts` `parseSkillInvocation` — the envelope-inverse precedent.
- `packages/nax/src/tui/chat/line-editor.ts` `EditorState { text: string; cursor: number }`.
- `packages/nax/src/tui/chat/slash-menu.ts` `SLASH_MENU_MAX_ROWS = 8`, `slashMenuRows`.
- `packages/nax/src/utils/git.ts` re-exports `gitWithTimeout(args, cwd, timeoutMs)` and `GIT_TIMEOUT_MS`; `src/advisor/audit.ts` `_auditDeps.git` is the wrapper pattern to mirror (`{ stdout, exitCode }`).
- `packages/nax/src/tui/chat/history-replay.ts` `replayHistory(history)`; its private `replayUser(content)` returns `[{ kind: "skill", ... }]` or `[{ kind: "user", text }]` (or a compaction notice).

Symbols this feature changes. The baseline only locates the code; implement the target.

- `TranscriptEntry` (`tui/chat/transcript-model.ts`)
  - Baseline: `| { kind: "user"; text: string }`, no attachment kind.
  - Target: `| { kind: "user"; text: string; mentions?: readonly string[] }` and a new member `| { kind: "attachment"; path: string; status: MentionStatus; note: string; body: string; open?: boolean }`.
- `layoutEntry` (`tui/chat/layout.ts`): Target adds `case "attachment"` delegating to `attachmentLines` in a new `tui/chat/layout-attachment.ts`; `cachedLines` treats `attachment` as collapsible (`open ?? expanded`) like `thinking`, `tool`, `skill`; `userLines` styles each mention token.
- `toggleTranscriptLine` (`tui/chat/transcript-click.ts`)
  - Baseline: toggles only `thinking`, `tool`, `skill`.
  - Target: also toggles an `attachment` entry whose `status` is `attached`, `cut` or `folder`, on its first line.
- `replayUser` (`tui/chat/history-replay.ts`): Target tries `parseMentionMessage(content)` after the compaction and skill checks; a parse returns `[...mentionTranscriptEntries(parsed)]`.
- `ChatApp` `submit` / `sendTurn`: Target as §Send path.
- `ChatInputHandle` (`tui/chat/ChatInput.tsx`)
  - Baseline: `{ complete(text: string): void; submit(text: string): void }`.
  - Target: adds `edit(state: EditorState): void` — write `state.text` into the prompt with the cursor at `state.cursor`, through the same draft ref and clear-arm bookkeeping `complete` uses.
- `_chatAppDeps` (`tui/chat/ChatApp.tsx`)
  - Baseline: `{ tmux }`.
  - Target: `{ tmux, expandMentions: expandChatMentions, mentionFileIndex: createMentionFileIndex }`.
- `packages/nax/src/chat/index.ts`: Target re-exports the `chat/mentions` barrel (§New modules).

### New modules

`packages/nax/src/chat/mentions/` (barrel `index.ts`, types in `types.ts`):

```ts
export type MentionStatus = "attached" | "cut" | "folder" | "path-only" | "refused";

export interface MentionRecord {
  readonly path: string;    // as typed, without "@" or quotes
  readonly status: MentionStatus;
  readonly note: string;    // see §Notes
  readonly body: string;    // file text, cut prefix, or folder listing; "" for path-only and refused
}

export interface MentionToken {
  readonly start: number;   // index of "@"
  readonly end: number;     // index after the token
  readonly path: string;    // without "@" and quotes
  readonly quoted: boolean;
}

export interface ParsedMentionMessage {
  readonly text: string;    // what the user typed
  readonly records: readonly MentionRecord[];
}

export interface ExpandedMentions {
  readonly message: string; // what host.send receives
  readonly records: readonly MentionRecord[];
}

export interface MentionFileRow { readonly path: string; readonly folder: boolean } // folder paths end with "/"
export interface MentionFileList { readonly git: boolean; readonly rows: readonly MentionFileRow[] }
export interface MentionFileIndex { get(): Promise<MentionFileList> }

// mention-tokens.ts
export function findMentionTokens(text: string): readonly MentionToken[];
export function formatMentionToken(path: string): string; // "@" + path, or '@"' + path + '"' when path has whitespace

// mention-envelope.ts
export function formatMentionMessage(text: string, records: readonly MentionRecord[]): string;
export function parseMentionMessage(message: string): ParsedMentionMessage | undefined;

// mention-expand.ts
export const _mentionExpandDeps: {
  realpath(path: string): Promise<string>;                 // rejects when the path does not exist
  stat(path: string): Promise<{ isDirectory: boolean; size: number }>;
  readBytes(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<readonly { name: string; isDirectory: boolean }[]>;
  git(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number; timedOut: boolean }>; // timedOut from gitWithTimeout
};
export function expandChatMentions(text: string, where: { cwd: string; repoRoot: string }): Promise<ExpandedMentions>;

// mention-files.ts
export const _mentionFilesDeps: {
  git(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }>;
  now(): number;
};
export function listMentionFiles(cwd: string): Promise<MentionFileList>;
export function createMentionFileIndex(cwd: string): MentionFileIndex;
```

`packages/nax/src/tui/chat/`:

```ts
// mention-entries.ts
export function mentionTranscriptEntries(parsed: ParsedMentionMessage): readonly TranscriptEntry[];

// mention-menu.ts
export interface MentionQuery { readonly start: number; readonly end: number; readonly query: string; readonly quoted: boolean }
export function mentionQueryAt(editor: EditorState): MentionQuery | null;
export function filterMentionRows(rows: readonly MentionFileRow[], query: string): readonly MentionFileRow[];
export function applyMentionRow(editor: EditorState, at: MentionQuery, row: MentionFileRow, key: "tab" | "return"): EditorState;

// layout-attachment.ts
export function attachmentLabel(entry: { path: string; status: MentionStatus; note: string }): string;

// MentionMenu.tsx, use-mention-menu.ts — the picker view and its state/keys hook (shapes are the builder's)
```

Constants (in `chat/mentions/types.ts` or a `constants.ts` beside it, builder's choice of file): `MENTION_FILE_MAX_CHARS = 100_000`, `MENTION_TOTAL_MAX_CHARS = 400_000`, `MENTION_READ_MAX_BYTES = 8 * 1024 * 1024`, `MENTION_BINARY_PROBE_BYTES = 8_000`, `MENTION_FILE_INDEX_MAX_AGE_MS = 5_000`. These limits are fixed by design (user-confirmed defaults in the source design), not config; they bound content size and cache age, not a timeout.

### Mention grammar

- A mention starts with `@` at index 0 or right after a whitespace character.
- Unquoted: the path runs from after `@` to the next whitespace or the end of the text. An empty path (a bare `@`, or `@""`) is not a token.
- Quoted: `@"` starts a quoted path that runs to the next `"`; the token ends after that `"`. An unclosed quote is not a token. Quoted paths have no escape sequences.
- `findMentionTokens` is purely textual; whether a token resolves is decided by `expandChatMentions`.

### Envelope format

`formatMentionMessage(text, records)`:

- With `records` empty and `text` not containing `</nax-mentions`, it returns `text` unchanged.
- Otherwise it returns `text + "\n\n" + block + trailer`, where:
  - `block` = `"<nax-mentions>\n"` followed, per record in order, by `<mention path="P" status="S" note="N" length="L">` + `"\n"` + body + `"\n</mention>\n"`. `P` and `N` are attribute-escaped (`&` → `&amp;`, `"` → `&quot;`, `<` → `&lt;`, `>` → `&gt;`, newline → `&#10;`). `L` is the body's JavaScript string length.
  - `trailer` = `</nax-mentions length="T">`, where `T` is the string length of `block`.
- The trailer is always the last line, and nothing follows it.

Worked example (`text` = `why @src/a.ts`, one attached record with body `x\n`):

```
why @src/a.ts

<nax-mentions>
<mention path="src/a.ts" status="attached" note="1 lines" length="2">
x

</mention>
</nax-mentions length="99">
```

`parseMentionMessage(message)`:

- Reads the last line. If it is not `</nax-mentions length="T">` with `T` a decimal integer, returns `undefined`.
- The block is the `T` characters before the trailer; it must start with `<nax-mentions>\n` and be preceded by `\n\n`, else `undefined`.
- Records are read in order using each header's `length`; any header that does not match, a body that does not end where its `length` says, or leftover characters return `undefined`.
- Returns `{ text: message.slice(0, blockStart - 2), records }` with attributes unescaped.
- Because the trailer is located from the end and bodies are read by length, file contents never affect parsing. Because `formatMentionMessage` appends an (empty) block whenever the typed text contains `</nax-mentions`, typed or pasted text can never parse as records nax did not make.

### Resolution and expansion

`expandChatMentions(text, { cwd, repoRoot })` walks `findMentionTokens(text)` in order and builds one record per token that resolves. The ordered pipeline per token:

1. **Locate.** `candidate = resolve(cwd, path)`. If `realpath(candidate)` rejects and the token is unquoted, retry once with trailing `.,;:!?)` characters stripped from the path; if that also rejects (or nothing was stripped), the token gets no record and stays plain text. A stripped path is the record's `path`.
2. **Dedup.** A token whose real path was already recorded in this message gets no second record.
3. **Boundary.** If the real path is neither equal to `realpath(repoRoot)` nor starts with `realpath(repoRoot)` followed by the path separator, record `refused` with note `not attached: outside the repo`. A real path whose part below the repo root has a segment equal to `.git` (compared case-insensitively) records `refused` with note `not attached: inside .git`.
4. **Ignored.** `git --literal-pathspecs check-ignore -q -- <path>` run in `cwd`, where `<path>` is the record's `path` (the candidate as typed, relative to `cwd`, never the real path). A timed-out call records `refused` with note `not attached: git timed out`. Otherwise exit code 0 records `refused` with note `not attached: ignored by git`, exit code 1 means "not ignored", and any other exit code records `refused` with note `not attached: git check-ignore failed (exit <code>)`.
5. **Folder.** If `stat` says directory, record `folder` with a listing body (§Folder listing) and note `<N> entries`.
6. **Too large to read.** If `size > MENTION_READ_MAX_BYTES`, record `path-only` with note `path only: file too large`.
7. **Binary.** Read the bytes; a NUL byte within the first `MENTION_BINARY_PROBE_BYTES` records `path-only` with note `path only: binary`.
8. **Cut.** Decode as UTF-8. Let `M` be the line count (newline count, plus 1 if the text is non-empty and does not end with a newline; an empty file has 0 lines). If the text length is at most `MENTION_FILE_MAX_CHARS`, the body is the whole text with status `attached` and note `<M> lines`. Otherwise the body is the longest prefix made of whole lines (each including its newline) whose length is at most `MENTION_FILE_MAX_CHARS`, with status `cut` and note `first <n> of <M> lines`, where `n` is the number of lines in that prefix. If even the first line is longer than the cap, the body is the first `MENTION_FILE_MAX_CHARS` characters and `n` is 1.
9. **Total cap.** If the sum of earlier records' body lengths plus this body's length exceeds `MENTION_TOTAL_MAX_CHARS`, record `path-only` with note `path only: message too large` and an empty body instead. A `folder` record is subject to the same cap: an over-cap listing becomes a `path-only` record with note `path only: message too large`.

Any rejection from `stat`, `readBytes`, `readdir` or `git` while handling a token records `refused` with note `not attached: <error message>`; `expandChatMentions` itself never rejects. The result is `{ message: formatMentionMessage(text, records), records }`.

### Folder listing

The folder's direct entries, one per line, sorted ascending by code unit, subfolders with a trailing `/`. The folder is first normalised to its cwd-relative path with exactly one trailing `/` (`src`, `./src` and `src/` all become `src/`). For the cwd itself the pathspec is `.`, and each listed path's first segment is an entry. In a git checkout the source is `git --literal-pathspecs ls-files -z --cached --others --exclude-standard -- <folder>` run in `cwd`: each listed path's first segment below the normalised folder is an entry (a segment followed by more path is a subfolder). When that command exits non-zero, the source is `readdir(folder)`. `N` is the number of entries.

### Notes

The `note` per status is fixed by §Resolution step: `attached` → `<M> lines`; `cut` → `first <n> of <M> lines`; `folder` → `<N> entries`; `path-only` → `path only: binary` | `path only: file too large` | `path only: message too large`; `refused` → `not attached: outside the repo` | `not attached: ignored by git` | `not attached: <error message>`.

`attachmentLabel(entry)` composes the transcript line: `attached`, `cut`, `folder` → `attached @<path> · <note>`; `path-only` → `attached @<path> as <note>`; `refused` → `@<path> <note>`.

### Send path

In `ChatApp` `submit`, for a non-slash message whose text contains `@` or `</nax-mentions`, call `sendTurn(message, prepare)` where `prepare` resolves `{ message: (await _chatAppDeps.expandMentions(message, { cwd, repoRoot: host.repoRoot })).message }`. A message containing neither keeps today's exact call (`sendTurn(message)`), so the existing `host.send("hello", fn)` two-argument expectations hold. `sendTurn`'s default `title = message` keeps the typed text as the title.

In `sendTurn`, after the skill check, `parseMentionMessage(prepared.message)` that succeeds appends `mentionTranscriptEntries(parsed)` instead of a plain `user` entry.

`mentionTranscriptEntries(parsed)` returns `[{ kind: "user", text: parsed.text, mentions }, ...one attachment entry per record]`, where `mentions` lists the paths of the records whose status is not `refused`, and each attachment entry copies `path`, `status`, `note`, `body` with no `open`.

### Transcript layout

- `userLines` draws each `@<path>` / `@"<path>"` occurrence of a listed mention that sits wholly inside one wrapped line as its own span with colour `accent` (keeping the user band). An occurrence split by wrapping stays unstyled, every whole occurrence is styled, and an occurrence followed directly by a non-whitespace character (`@a.ts` inside `@a.tsx`) is not an occurrence, except that a run of `.,;:!?)` characters followed by whitespace or the end of the text does not disqualify it (`(@a.ts).` highlights `@a.ts`).
- `attachmentLines` draws one muted card row with `attachmentLabel(entry)` behind the result prefix, followed, for `attached`, `cut` and `folder`, by the existing `(ctrl+o to show)` / `(ctrl+o to hide)` hint. When expanded (`open ?? expanded`), the body follows as indented muted rows, the way `skillLines` draws a skill body. `path-only` and `refused` entries draw the label row only and never expand.

### Picker

- `mentionQueryAt(editor)` returns `null` when `editor.text` starts with `/`. Otherwise it finds the `@` strictly before `editor.cursor` (index less than the cursor) that starts a mention per §Mention grammar with no whitespace between it and the cursor (or, for a quoted token, no closing `"` between them). `query` is the text between `@` (or `@"`) and the cursor; `end` is the token's end (next whitespace after the cursor, or after the closing quote, or the text end).
- `filterMentionRows(rows, query)`: `prefix` = `query` up to and including its last `/` (or `""`), `rest` = the remainder. Candidates are rows whose `path` starts with `prefix` and differs from it. With `rest` empty, only the direct children of `prefix` are kept (no further `/` after `prefix`, except a folder's own trailing one). With `rest` non-empty, a candidate is kept when `rest` is a case-insensitive subsequence of its path after `prefix`. Ranking (a row's basename is its last path segment, with a folder's trailing `/` removed first): basename starts with `rest` (case-insensitive), then path-after-prefix starts with `rest`, then other matches; ties by shorter path, then code-unit order.
- `applyMentionRow(editor, at, row, key)` replaces `editor.text.slice(at.start, at.end)` with `formatMentionToken(row.path)`. For a folder row with `key` `"tab"`, the inserted text is the token without a trailing space, and for a path with whitespace without the closing `"` (so the picker stays open inside the folder). Otherwise a single space follows the token, unless the character at `at.end` is already whitespace, in which case no space is inserted and the cursor moves past that existing whitespace character. Text after `at.end` is kept; otherwise the cursor sits right after the inserted text.
- The view: under the input, styled like the slash menu, at most `SLASH_MENU_MAX_ROWS` rows (capped by the bottom-region budget the slash menu uses), the selected row highlighted. Up/down move; tab and return apply the selected row through `ChatInputHandle.edit`; escape closes it until the prompt text next changes. Return while the picker is open never submits. Ownership is read at key time, not from the last render (the `use-slash-menu-keys.ts` pattern), so once rows are loaded, a batch of keys in one terminal write that types a query and then presses tab and return is handled by the picker. A batch arriving before the rows load follows the pending rule below (return submits).
- The picker opens when `mentionQueryAt` returns a query, no other surface owns the bottom region (`bottomBlocked`), and the slash menu is not shown. It is shown, and owns up, down, tab, return and escape, only while `filterMentionRows` returns at least one row and its row budget is above zero (the slash menu's `matches.length > 0` and `menuRows > 0` rule). With zero rows, or while a `get()` is pending, nothing is drawn and every key behaves as if no picker existed, so return submits. It reads rows from one `_chatAppDeps.mentionFileIndex(cwd)` created once when the screen mounts, calling `get()` whenever `mentionQueryAt` turns from `null` to a query. While a `get()` is pending it shows no rows.
- The picker's shown-state and rows join the slash menu's at every `ChatApp` site that reads `menuShown()` or `menuRows`: the screen-level escape handler (escape while the picker is shown closes the picker and never cancels a running turn), the jobs opener's `blocked` input, and the bottom-region row budget (`inputBudget`, the bottom rows).
- When the list's `git` is `false` (not a repo, or `git ls-files` failed or timed out), the picker draws one dim line `no file list from git` and owns no keys.
- `createMentionFileIndex(cwd).get()` reuses its last list while it is younger than `MENTION_FILE_INDEX_MAX_AGE_MS` (by `_mentionFilesDeps.now()`), otherwise re-lists; concurrent calls share one in-flight listing.
- `listMentionFiles(cwd)` runs `git ls-files -z --cached --others --exclude-standard` in `cwd`. A zero exit returns `git: true` and one file row per listed path plus one folder row per distinct ancestor folder (`a/`, `a/b/`), all sorted ascending by `path` in code-unit order. A non-zero exit returns `{ git: false, rows: [] }`.

### Failure Handling

| Case | Behaviour | Owning story |
|---|---|---|
| Mentioned path does not exist | no record, token stays plain text, send continues | US-002 |
| Path outside the repo | `refused` record, `not attached: outside the repo` | US-002 |
| Gitignored path | `refused` record, `not attached: ignored by git` | US-002 |
| git error or timeout for one token | `refused` record with the error or timeout note; other tokens unaffected; `expandChatMentions` resolves | US-002 |
| File read error for one token | `refused` record with the error message; other tokens unaffected | US-003 |
| Binary, too large to read, over total cap | `path-only` record with its note | US-003 |
| Stored message that does not parse | rendered as a plain `user` entry, as today | US-005 |
| `git ls-files` fails (not a repo, error, timeout) | `{ git: false, rows: [] }`; picker shows the `no file list from git` line | US-006, US-007 |

## Out of Scope

- Images, screenshots and any non-text prompt content in chat; a later, separate feature.
- Line-range mentions such as `@file#L10-40`.
- Mentions of anything that is not a repo path: URLs, symbols, MCP resources, agents, sessions.
- Expanding mentions inside slash commands (`/skill foo @x`, `/plan ...`) or in job-delivered messages; only a plain typed chat message expands.
- Mentions in `nax run`, `nax plan` or bot prompts.
- Re-reading a mentioned file later in the conversation; contents are a snapshot at send time.
- Sending attachments to ACP brains as ACP `resource` content blocks; every brain receives the expanded text.
- Any change to `packages/nax/src/chat/chat-host.ts`, the `ChatHost` interface, the session store, `nax-agent`, `nax-agent-acp` or koda.
- Listing submodule contents in the picker; a typed submodule path still resolves under the repo-root boundary.
- Escaping or re-quoting paths that contain a `"` character; such a path can only be mentioned unquoted if it has no whitespace.

## Stories

**US-001: Mention grammar and message envelope.** No dependencies. Workdir: `packages/nax`. Add `src/chat/mentions/` with `types.ts`, `mention-tokens.ts` (`findMentionTokens`, `formatMentionToken`), `mention-envelope.ts` (`formatMentionMessage`, `parseMentionMessage`) and a barrel, and re-export the barrel from `src/chat/index.ts`. Pure string code, no I/O.

**US-002: Resolve mentions to records.** Depends on US-001. Workdir: `packages/nax`. Add `src/chat/mentions/mention-expand.ts` with `_mentionExpandDeps` and `expandChatMentions`, implementing §Resolution steps 1 to 4 (locate, dedup, boundary, `.git`, ignored) and the whole-file case of step 8 (a text file at or under `MENTION_FILE_MAX_CHARS` becomes an `attached` record). Export `expandChatMentions` and `_mentionExpandDeps` from the mentions barrel `src/chat/mentions/index.ts` that US-001 created.

**US-003: Folder listings and content limits.** Depends on US-002. Workdir: `packages/nax`. Extend `expandChatMentions` in `src/chat/mentions/mention-expand.ts` (created by US-002) with §Resolution steps 5 to 9 (folder, too large to read, binary, cut, total cap), §Folder listing, and the read-error `refused` record.

**US-004: Attachment entries in the transcript.** Depends on US-001. Workdir: `packages/nax`. Add the `attachment` entry kind and `user.mentions`, `tui/chat/mention-entries.ts` (`mentionTranscriptEntries`), `tui/chat/layout-attachment.ts` (`attachmentLabel`, `attachmentLines`), the `layoutEntry` / `cachedLines` / `userLines` changes and the `toggleTranscriptLine` change.

**US-005: Send expanded messages and replay them.** Depends on US-002, US-004. Workdir: `packages/nax`. Add `_chatAppDeps.expandMentions`, the `submit` branch and the `sendTurn` mention parse in `ChatApp.tsx`, and the `replayUser` parse in `history-replay.ts`.

**US-006: File list and picker model.** Depends on US-001. Workdir: `packages/nax`. Add `src/chat/mentions/mention-files.ts` (`_mentionFilesDeps`, `listMentionFiles`, `createMentionFileIndex`) and `src/tui/chat/mention-menu.ts` (`mentionQueryAt`, `filterMentionRows`, `applyMentionRow`). Export `listMentionFiles`, `createMentionFileIndex` and `_mentionFilesDeps` from the mentions barrel `src/chat/mentions/index.ts` that US-001 created.

**US-007: The `@` picker in the chat input.** Depends on US-005, US-006. Workdir: `packages/nax`. Add `ChatInputHandle.edit`, `tui/chat/MentionMenu.tsx`, `tui/chat/use-mention-menu.ts`, `_chatAppDeps.mentionFileIndex`, and the `ChatApp` wiring: key ownership read at key time, escape dismissal, the escape handler, jobs-opener and row-budget sites, and the `no file list from git` line.

### Context Files

**US-001**
- `packages/nax/src/chat/skill-invocation.ts` — the envelope and inverse-parse precedent.
- `packages/nax/src/chat/index.ts` — the chat barrel the mentions barrel joins.

**US-002**
- `packages/nax/src/chat/mentions/mention-envelope.ts` — created by US-001, `formatMentionMessage` builds the result here.
- `packages/nax/src/chat/mentions/mention-tokens.ts` — created by US-001, `findMentionTokens`.
- `packages/nax/src/advisor/audit.ts` — `_auditDeps.git` over `gitWithTimeout`, the git wrapper pattern to mirror (this feature's wrapper also passes `timedOut` through).
- `packages/nax/src/utils/git.ts` — `gitWithTimeout`, `GIT_TIMEOUT_MS`.

**US-003**
- `packages/nax/src/chat/mentions/mention-expand.ts` — created by US-002, the expander this story extends.
- `packages/nax/src/chat/mentions/types.ts` — created by US-001, the limit constants.

**US-004**
- `packages/nax/src/tui/chat/transcript-model.ts` — `TranscriptEntry`.
- `packages/nax/src/tui/chat/layout.ts` — `layoutEntry`, `cachedLines`, `userLines`, `skillLines`.
- `packages/nax/src/tui/chat/transcript-click.ts` — `toggleTranscriptLine`.
- `packages/nax/test/ui/chat/chat-transcript-click.test.tsx` — click-test style to mirror.

**US-005**
- `packages/nax/src/tui/chat/ChatApp.tsx` — `submit`, `sendTurn`, `_chatAppDeps`.
- `packages/nax/src/tui/chat/history-replay.ts` — `replayUser`, `replayHistory`.
- `packages/nax/src/tui/chat/mention-entries.ts` — created by US-004, `mentionTranscriptEntries`.
- `packages/nax/test/ui/chat/chat-app.test.tsx` — `fakeHost` and the send assertions to mirror.

**US-006**
- `packages/nax/src/chat/mentions/mention-tokens.ts` — created by US-001, `formatMentionToken`.
- `packages/nax/src/tui/chat/line-editor.ts` — `EditorState`.
- `packages/nax/src/tui/chat/slash-menu.ts` — query-state and filtering style to mirror.
- `packages/nax/src/context/greenfield.ts` — an existing `git ls-files` listing.

**US-007**
- `packages/nax/src/tui/chat/ChatApp.tsx` — slash menu wiring and every `menuShown()` / `menuRows` site to extend.
- `packages/nax/src/tui/chat/ChatInput.tsx` — `ChatInputHandle`, `yieldNavigation`.
- `packages/nax/src/tui/chat/SlashMenu.tsx` — the menu view to mirror.
- `packages/nax/src/tui/chat/use-slash-menu-keys.ts` — the key-time ownership hook to mirror.
- `packages/nax/src/tui/chat/mention-menu.ts` — created by US-006, the picker model.

### Creates

**US-001**
- `packages/nax/src/chat/mentions/types.ts`
- `packages/nax/src/chat/mentions/mention-tokens.ts`
- `packages/nax/src/chat/mentions/mention-envelope.ts`
- `packages/nax/src/chat/mentions/index.ts`
- `packages/nax/test/unit/chat/mentions/mention-tokens.test.ts`
- `packages/nax/test/unit/chat/mentions/mention-envelope.test.ts`

**US-002**
- `packages/nax/src/chat/mentions/mention-expand.ts`
- `packages/nax/test/unit/chat/mentions/mention-expand.test.ts`

**US-003**
- `packages/nax/test/unit/chat/mentions/mention-expand-limits.test.ts`

**US-004**
- `packages/nax/src/tui/chat/mention-entries.ts`
- `packages/nax/src/tui/chat/layout-attachment.ts`
- `packages/nax/test/unit/tui/chat/mention-entries.test.ts`
- `packages/nax/test/unit/tui/chat/layout-attachment.test.ts`

**US-005**
- `packages/nax/test/ui/chat/chat-app-mentions.test.tsx`

**US-006**
- `packages/nax/src/chat/mentions/mention-files.ts`
- `packages/nax/src/tui/chat/mention-menu.ts`
- `packages/nax/test/unit/chat/mentions/mention-files.test.ts`
- `packages/nax/test/unit/tui/chat/mention-menu.test.ts`

**US-007**
- `packages/nax/src/tui/chat/MentionMenu.tsx`
- `packages/nax/src/tui/chat/use-mention-menu.ts`
- `packages/nax/test/ui/chat/chat-mention-picker.test.tsx`

### Modifies

**US-001**
- `packages/nax/src/chat/index.ts` — re-export the new mentions barrel. No other change.

**US-004**
- `packages/nax/src/tui/chat/transcript-model.ts` — `TranscriptEntry` gains `mentions?` on `user` and the `attachment` member. No reducer change.
- `packages/nax/src/tui/chat/layout.ts` — `layoutEntry` gains `case "attachment"`, `cachedLines` treats `attachment` as collapsible, `userLines` styles mention tokens.
- `packages/nax/src/tui/chat/transcript-click.ts` — `toggleTranscriptLine` also toggles expandable `attachment` entries.
- `packages/nax/test/unit/tui/chat/layout.test.ts` — gains the `userLines` mention-span cases; existing assertions unchanged.
- `packages/nax/test/ui/chat/chat-transcript-click.test.tsx` — gains the attachment toggle cases; existing assertions unchanged.

**US-005**
- `packages/nax/src/tui/chat/ChatApp.tsx` — `_chatAppDeps.expandMentions`, the `submit` branch and the `sendTurn` mention parse.
- `packages/nax/src/tui/chat/history-replay.ts` — `replayUser` parses mention messages.
- `packages/nax/test/unit/tui/chat/history-replay.test.ts` — gains the mention replay cases; existing assertions unchanged.

**US-007**
- `packages/nax/src/tui/chat/ChatInput.tsx` — `ChatInputHandle` gains `edit(state)`; the published handle implements it.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `_chatAppDeps.mentionFileIndex`, the picker under the input, `yieldNavigation`, the escape handler, the jobs opener `blocked` input and the row budget include the picker.
- `packages/nax/test/ui/chat/chat-input.test.tsx` — gains the `edit` handle case; existing assertions unchanged.

### Seams

- US-001 -> US-002: `expandChatMentions` builds its `message` with `formatMentionMessage`, and that message parses back with `parseMentionMessage` to the same records (US-002, the round-trip AC).
- US-002 -> `ChatApp` submit (US-005): typing a message with `@` and pressing return calls `_chatAppDeps.expandMentions` with the typed text and `{ cwd, repoRoot }`, and `host.send` receives its `message` with the typed text as `title`; one AC runs the real default expander.
- US-004 -> `ChatApp` and `replayHistory` (US-005): a sent or stored expanded message renders as `mentionTranscriptEntries` of its parse.
- US-006 -> `ChatApp` (US-007): the screen creates one `_chatAppDeps.mentionFileIndex(cwd)` at mount and calls its `get()` when a mention query appears; one AC runs the real default index.

## Acceptance Criteria

### US-001

1. [unit] `findMentionTokens("see @src/a.ts now")` returns `[{ start: 4, end: 13, path: "src/a.ts", quoted: false }]`.
2. [unit] `findMentionTokens("@a.ts")` returns one token whose `start` is 0.
3. [unit] `findMentionTokens("mail a@b.com")` returns an empty array, because the `@` is not at the start or after whitespace.
4. [unit] `findMentionTokens("a @ b")` returns an empty array, because a bare `@` has an empty path.
5. [unit] `findMentionTokens('see @"" now')` returns an empty array.
6. [unit] `findMentionTokens('open @"my dir/x.ts" please')` returns `[{ start: 5, end: 19, path: "my dir/x.ts", quoted: true }]`.
7. [unit] `findMentionTokens('open @"my dir/x.ts')` returns an empty array, because the quote is unclosed.
8. [unit] `findMentionTokens("@a.ts and\n@b.ts")` returns tokens whose paths in order are `["a.ts", "b.ts"]`.
9. [unit] `formatMentionToken("src/a.ts")` returns `"@src/a.ts"`.
10. [unit] `formatMentionToken("my dir/x.ts")` returns `'@"my dir/x.ts"'`.
11. [unit] `formatMentionMessage("hello", [])` returns `"hello"`.
12. [unit] `formatMentionMessage("why @src/a.ts", [{ path: "src/a.ts", status: "attached", note: "1 lines", body: "x\n" }])` returns exactly the worked example string of §Envelope format.
13. [unit] `parseMentionMessage` on the worked example string returns `{ text: "why @src/a.ts", records: [{ path: "src/a.ts", status: "attached", note: "1 lines", body: "x\n" }] }`.
14. [unit] For records whose bodies contain the strings `</mention>` and `</nax-mentions length="5">` and end with a newline, `parseMentionMessage(formatMentionMessage(text, records))` returns `{ text, records }`.
15. [unit] For a record whose `path` and `note` contain `"`, `<`, `>`, `&` and a newline, `parseMentionMessage(formatMentionMessage("t", [record]))` returns `{ text: "t", records: [record] }`.
16. [unit] `parseMentionMessage("just text")` returns `undefined`.
17. [unit] `parseMentionMessage` on the worked example with its trailer's length value increased by one returns `undefined`.
18. [unit] `parseMentionMessage` on the worked example with its record's `length` attribute decreased by one returns `undefined`.
19. [unit] `formatMentionMessage(t, [])`, where `t` is the worked example string itself (a user pasting an expanded message), returns a string different from `t`.
20. [unit] `parseMentionMessage(formatMentionMessage(t, []))` for that same `t` returns `{ text: t, records: [] }`.
21. [unit] `findMentionTokens`, `formatMentionMessage` and `parseMentionMessage` are importable from `@/chat` and callable.

### US-002

Each AC drives `expandChatMentions(text, { cwd: "/repo", repoRoot: "/repo" })` with `_mentionExpandDeps` replaced by fakes whose `git` answers `check-ignore` with exit code 1 and `timedOut` false, unless the AC says otherwise.

1. [unit] With `src/a.ts` holding `"x\ny\n"`, expanding `"see @src/a.ts"` returns `records` equal to `[{ path: "src/a.ts", status: "attached", note: "2 lines", body: "x\ny\n" }]`.
2. [unit] In that case the returned `message` equals `formatMentionMessage("see @src/a.ts", records)`.
3. [unit] In that case `parseMentionMessage(result.message)` returns `{ text: "see @src/a.ts", records: result.records }`.
4. [unit] Expanding `"see @missing.ts"`, where `realpath` rejects for that path, returns `{ message: "see @missing.ts", records: [] }`.
5. [unit] Expanding `"look at @src/a.ts."`, where only `src/a.ts` exists, returns records whose paths are `["src/a.ts"]`.
6. [unit] Expanding `"@src/a.ts and @./src/a.ts"`, both resolving to the same real path, returns exactly one record.
7. [unit] Expanding `"@../outside.ts"`, whose real path is `/outside.ts`, returns `records` equal to `[{ path: "../outside.ts", status: "refused", note: "not attached: outside the repo", body: "" }]`.
8. [unit] Expanding `"@link.ts"`, a symlink whose real path is `/etc/hosts`, returns `records` equal to `[{ path: "link.ts", status: "refused", note: "not attached: outside the repo", body: "" }]`.
9. [unit] Expanding `"@../repo-other/x.ts"`, whose real path is `/repo-other/x.ts`, returns records whose notes are `["not attached: outside the repo"]`.
10. [unit] Expanding `"@.git/config"`, whose real path is `/repo/.git/config`, returns `records` equal to `[{ path: ".git/config", status: "refused", note: "not attached: inside .git", body: "" }]`.
11. [unit] Expanding `"@.GIT/config"`, whose real path is `/repo/.GIT/config`, returns records whose notes are `["not attached: inside .git"]`.
12. [unit] Expanding `"@dist/out.js"`, where the fake `git` answers that path's `check-ignore` with exit code 0, returns `records` equal to `[{ path: "dist/out.js", status: "refused", note: "not attached: ignored by git", body: "" }]`.
13. [unit] In that case the fake `git` was called with args `["--literal-pathspecs", "check-ignore", "-q", "--", "dist/out.js"]` and cwd `"/repo"`.
14. [unit] Expanding `"@a.ts"`, where the fake `git` answers `check-ignore` with `timedOut` true and exit code 1, returns records whose notes are `["not attached: git timed out"]`.
15. [unit] Expanding `"@a.ts"`, where the fake `git` answers `check-ignore` with exit code 128, returns records whose notes are `["not attached: git check-ignore failed (exit 128)"]`.
16. [unit] Expanding `"@a.ts @b.ts"`, where the fake `git` rejects for `a.ts` with `Error("spawn failed")` and `b.ts` holds `"y\n"`, returns records whose `[status, note]` pairs in order are `[["refused", "not attached: spawn failed"], ["attached", "1 lines"]]`.

### US-003

Each AC drives `expandChatMentions(text, { cwd: "/repo", repoRoot: "/repo" })` with `_mentionExpandDeps` replaced by fakes whose `git` answers `check-ignore` with exit code 1 and `timedOut` false, unless the AC says otherwise.

1. [unit] Expanding `"@src/"`, a directory whose fake `git` answers the `ls-files` call for `src/` with `src/a.ts`, `src/b/c.ts` and `src/b/d.ts`, returns `records` equal to `[{ path: "src/", status: "folder", note: "2 entries", body: "a.ts\nb/" }]`.
2. [unit] In that case the `ls-files` call's args are `["--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src/"]`.
3. [unit] Expanding `"@src"` (no trailing slash) for that same directory and listing returns records whose bodies are `["a.ts\nb/"]`.
4. [unit] Expanding `"@src/"` when that `ls-files` call exits non-zero lists the folder through `readdir`, so a `readdir` returning `b` (directory) and `a.ts` (file) yields records whose bodies are `["a.ts\nb/"]`.
5. [unit] Expanding `"@big.bin"` whose `stat` size is `MENTION_READ_MAX_BYTES + 1` returns `records` equal to `[{ path: "big.bin", status: "path-only", note: "path only: file too large", body: "" }]`.
6. [unit] In that case `readBytes` is not called.
7. [unit] Expanding `"@img.png"` whose bytes contain a NUL within the first `MENTION_BINARY_PROBE_BYTES` returns `records` equal to `[{ path: "img.png", status: "path-only", note: "path only: binary", body: "" }]`.
8. [unit] Expanding `"@long.txt"`, a file of 30 000 lines of 9 characters plus a newline (300 000 characters), returns records whose notes are `["first 10000 of 30000 lines"]`.
9. [unit] In that case the record's body is exactly the file's first 100 000 characters.
10. [unit] Expanding `"@wide.txt"`, a file of one line of `MENTION_FILE_MAX_CHARS + 50` characters with no newline, returns records whose notes are `["first 1 of 1 lines"]`.
11. [unit] In that case the record's body is exactly the file's first `MENTION_FILE_MAX_CHARS` characters.
12. [unit] Expanding `"@empty.ts"`, an empty file, returns `records` equal to `[{ path: "empty.ts", status: "attached", note: "0 lines", body: "" }]`.
13. [unit] Expanding `"@a.txt @b.txt @c.txt @d.txt @e.txt"`, each a 90 000-character text file, returns records whose statuses in order are `["attached", "attached", "attached", "attached", "path-only"]`.
14. [unit] In that case the last record's note is `path only: message too large`.
15. [unit] Expanding `"@a.txt @b.txt @c.txt @d.txt @src/"`, four 90 000-character files and then a folder whose listing body is 50 000 characters, returns records whose statuses in order are `["attached", "attached", "attached", "attached", "path-only"]`.
16. [unit] Expanding `"@a.ts @b.ts"`, where `readBytes` rejects for `a.ts` with `Error("EACCES: permission denied")` and `b.ts` holds `"y\n"`, returns records whose `[status, note]` pairs in order are `[["refused", "not attached: EACCES: permission denied"], ["attached", "1 lines"]]`.

### US-004

1. [unit] `mentionTranscriptEntries({ text: "see @a.ts @b.png", records: [attachedA, pathOnlyB] })` returns, in order, a `user` entry `{ kind: "user", text: "see @a.ts @b.png", mentions: ["a.ts", "b.png"] }` and attachment entries for `a.ts` and `b.png`.
2. [unit] `mentionTranscriptEntries` of a parse holding one `refused` record for `../x` returns a `user` entry whose `mentions` is `[]` and one `attachment` entry whose `status` is `refused`.
3. [unit] `attachmentLabel({ path: "a.ts", status: "attached", note: "2 lines" })` returns `"attached @a.ts · 2 lines"`.
4. [unit] `attachmentLabel({ path: "big.ts", status: "cut", note: "first 10 of 99 lines" })` returns `"attached @big.ts · first 10 of 99 lines"`.
5. [unit] `attachmentLabel({ path: "src/", status: "folder", note: "2 entries" })` returns `"attached @src/ · 2 entries"`.
6. [unit] `attachmentLabel({ path: "b.png", status: "path-only", note: "path only: binary" })` returns `"attached @b.png as path only: binary"`.
7. [unit] `attachmentLabel({ path: "../x", status: "refused", note: "not attached: outside the repo" })` returns `"@../x not attached: outside the repo"`.
8. [unit] `layoutTranscript` of an `attached` attachment entry with body `"one\ntwo\n"` and `expanded` false draws exactly one row, which ends with `(ctrl+o to show)`.
9. [unit] `layoutTranscript` of that entry with `expanded` true draws three rows, the last two ending with `one` and `two`.
10. [unit] `layoutTranscript` of a `path-only` attachment entry with `expanded` true draws exactly one row.
11. [unit] `layoutTranscript` of a `user` entry `{ text: "see @a.ts now", mentions: ["a.ts"] }` draws a span whose text is `@a.ts` and whose colour is `accent`.
12. [unit] `layoutTranscript` of a `user` entry `{ text: "see (@a.ts).", mentions: ["a.ts"] }` draws a span whose text is `@a.ts` and whose colour is `accent`.
13. [unit] `layoutTranscript` of a `user` entry `{ text: "see @a.tsx", mentions: ["a.ts"] }` draws no `accent` span other than the user marker.
14. [unit] `layoutTranscript` of a `user` entry `{ text: "see @a.ts now" }` with no `mentions` draws no `accent` span other than the user marker.
15. [integration] In a rendered transcript holding a collapsed `attached` attachment entry, clicking its label row shows its body rows.
16. [integration] Clicking that label row a second time hides the body rows again.
17. [integration] Clicking the label row of a `refused` attachment entry leaves the transcript unchanged.

### US-005

1. [integration] Rendering `ChatApp` with `cwd` prop `/repo/pkg`, a fake host whose `repoRoot` is `/repo`, and `_chatAppDeps.expandMentions` spied to return `{ message: "EXPANDED", records: [] }`, then typing `see @a.ts` and pressing return, calls the spy once with `("see @a.ts", { cwd: "/repo/pkg", repoRoot: "/repo" })`.
2. [integration] In that case `host.send` is called with `"EXPANDED"`, a function, and `{ title: "see @a.ts" }`.
3. [integration] Typing `hello` (no `@`) and pressing return calls `host.send` with `("hello", <function>)` and two arguments only.
4. [integration] In that case `_chatAppDeps.expandMentions` is not called.
5. [integration] Typing `/help @a.ts` and pressing return does not call `_chatAppDeps.expandMentions`.
6. [integration] Typing `x </nax-mentions y` (no `@`) and pressing return calls `_chatAppDeps.expandMentions` once with that text.
7. [integration] When `expandMentions` returns a message built by `formatMentionMessage("see @a.ts", [{ path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" }])`, the transcript shows a row ending with `see @a.ts`.
8. [integration] In that case the next transcript row contains `attached @a.ts · 2 lines`.
9. [integration] After sending `see @a.ts`, pressing up in the empty input recalls `see @a.ts`, not the expanded message.
10. [integration] With `_chatAppDeps.expandMentions` left at its default, `cwd` prop and host `repoRoot` both `/repo`, and `_mentionExpandDeps` faked so `/repo/a.ts` holds `"x\n"` and `git` answers `check-ignore` with exit code 1, typing `see @a.ts` and pressing return calls `host.send` with a message that `parseMentionMessage` parses to `{ text: "see @a.ts", records: [{ path: "a.ts", status: "attached", note: "1 lines", body: "x\n" }] }`.
11. [unit] `replayHistory` of a history whose user message is `formatMentionMessage("see @a.ts", [attachedA])` returns entries equal to `mentionTranscriptEntries` of that message's parse.
12. [unit] `replayHistory` of a history whose user message is `"see @a.ts"` (not expanded) returns one entry equal to `{ kind: "user", text: "see @a.ts" }`.

### US-006

1. [unit] `listMentionFiles("/repo")`, with the fake `git` answering `ls-files -z --cached --others --exclude-standard` with exit 0 and `"src/b/c.ts\0a.ts\0"`, returns `git` true.
2. [unit] In that case the rows' paths in order are `["a.ts", "src/", "src/b/", "src/b/c.ts"]`.
3. [unit] In that case the rows whose `folder` is true are exactly `src/` and `src/b/`.
4. [unit] `listMentionFiles("/repo")` with the fake `git` exiting 128 returns `{ git: false, rows: [] }`.
5. [unit] `createMentionFileIndex("/repo").get()` called twice with `now()` advanced by `MENTION_FILE_INDEX_MAX_AGE_MS - 1` between the calls lists files once.
6. [unit] Called twice with `now()` advanced by `MENTION_FILE_INDEX_MAX_AGE_MS` between the calls, it lists files twice.
7. [unit] Two concurrent `get()` calls before the first listing settles list files once and resolve to the same list.
8. [unit] `mentionQueryAt({ text: "see @src/ch", cursor: 11 })` returns `{ start: 4, end: 11, query: "src/ch", quoted: false }`.
9. [unit] `mentionQueryAt({ text: "see @src/ch now", cursor: 8 })` returns `{ start: 4, end: 11, query: "src", quoted: false }`.
10. [unit] `mentionQueryAt({ text: "see @a.ts now", cursor: 13 })` returns `null`, because whitespace separates the `@` from the cursor.
11. [unit] `mentionQueryAt({ text: "see @a.ts", cursor: 4 })` returns `null`, because the cursor sits on the `@` itself.
12. [unit] `mentionQueryAt({ text: "/skill @a", cursor: 9 })` returns `null`.
13. [unit] `mentionQueryAt({ text: 'see @"my d', cursor: 10 })` returns `{ start: 4, end: 10, query: "my d", quoted: true }`.
14. [unit] `filterMentionRows(rows, "")` over rows `a.ts`, `src/`, `src/b.ts` returns rows whose paths are exactly `a.ts` and `src/`.
15. [unit] `filterMentionRows(rows, "src/")` over rows `a.ts`, `src/`, `src/b.ts`, `src/c/`, `src/c/d.ts` returns rows whose paths are exactly `src/b.ts` and `src/c/`.
16. [unit] `filterMentionRows(rows, "chh")` over rows `chat-host.ts`, `x/chat-host.ts`, `cheap.txt` returns rows whose paths in order are `["chat-host.ts", "x/chat-host.ts"]`.
17. [unit] `filterMentionRows(rows, "host")` over rows `ghost-x.ts` and `src/host.ts` returns `src/host.ts` first, because its basename starts with the query.
18. [unit] `filterMentionRows(rows, "src")` over rows `x/src.ts` and folder `src/` returns `src/` first, because a folder's basename is taken without its trailing `/`.
19. [unit] `filterMentionRows(rows, "CHAT")` over row `chat.ts` returns that row.
20. [unit] `applyMentionRow({ text: "see @ch now", cursor: 7 }, query, fileRow("chat.ts"), "return")` returns `{ text: "see @chat.ts now", cursor: 13 }`.
21. [unit] `applyMentionRow({ text: "@sr", cursor: 3 }, query, folderRow("src/"), "tab")` returns `{ text: "@src/", cursor: 5 }`.
22. [unit] `applyMentionRow({ text: "@sr", cursor: 3 }, query, folderRow("src/"), "return")` returns `{ text: "@src/ ", cursor: 6 }`.
23. [unit] `applyMentionRow({ text: "@my", cursor: 3 }, query, fileRow("my file.ts"), "return")` returns `{ text: '@"my file.ts" ', cursor: 14 }`.
24. [unit] `applyMentionRow({ text: "@my", cursor: 3 }, query, folderRow("my dir/"), "tab")` returns `{ text: '@"my dir/', cursor: 9 }`.

### US-007

Each ChatApp AC spies `_chatAppDeps.expandMentions` to return `{ message: <its input>, records: [] }`, unless the AC says otherwise.

1. [integration] Calling `edit({ text: "abc", cursor: 1 })` on the `ChatInputHandle` published by `ChatInput`, then typing `X`, makes the prompt read `aXbc`.
2. [integration] Rendering `ChatApp` with `_chatAppDeps.mentionFileIndex` spied to return an index whose `get()` resolves `{ git: true, rows: [file "chat-host.ts", file "cheap.txt"] }`, then typing `see @chh`, shows a picker row `chat-host.ts` under the input.
3. [integration] In that case `_chatAppDeps.mentionFileIndex` was called exactly once, with the screen's `cwd`.
4. [integration] In that case the index's `get()` was called at least once after the `@` was typed.
5. [integration] With that picker shown, pressing return makes the prompt read `see @chat-host.ts `.
6. [integration] In that case `host.send` is not called.
7. [integration] With that picker shown, pressing tab makes the prompt read `see @chat-host.ts `.
8. [integration] With rows `src/` (folder) and `src/a.ts`, typing `@sr` then pressing tab makes the prompt read `@src/` and shows the picker row `src/a.ts`.
9. [integration] With rows `a.ts` and `b.ts`, typing `@` then pressing down then return makes the prompt read `@b.ts `.
10. [integration] With the picker shown, pressing escape closes it and leaves the prompt text unchanged.
11. [integration] After that escape, typing one more character that still matches shows the picker again.
12. [integration] With a turn running (a `host.send` that has not settled) and the picker shown, pressing escape closes the picker and does not call `host.cancel`.
13. [integration] Typing `/he` shows the slash menu and no mention picker.
14. [integration] With an ask card pending on the host, typing `@` shows no mention picker.
15. [integration] With `get()` resolving `{ git: false, rows: [] }`, typing `@` shows the line `no file list from git`.
16. [integration] In that state, pressing return calls `host.send`.
17. [integration] With rows `a.ts` only, typing `thanks @bob` (no row matches) and pressing return calls `host.send`.
18. [integration] With `get()` never settling, typing `see @a` and pressing return calls `host.send`.
19. [integration] With rows `src/` (folder) and `src/a.ts` loaded (type `@`, wait for the row, then clear the prompt), writing `@sr`, tab and return in one input chunk leaves the prompt reading `@src/a.ts `.
20. [integration] In that case `host.send` is not called.
21. [integration] With `_chatAppDeps.mentionFileIndex` left at its default and `_mentionFilesDeps.git` faked to answer `ls-files` with exit 0 and `"chat-host.ts\0"`, typing `@chh` shows a picker row `chat-host.ts`.

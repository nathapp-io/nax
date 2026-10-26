# nax chat TUI: look and feel redesign

Status: DRAFT 2026-10-26, waiting for user approval. Nothing is built.

## 1. Intent

`nax chat` works (F1 to F5b, v0.91.7-canary.2), but the screen is plain text:
every transcript row is a bare `<Text>`, the prompt is `> value`, an approval
is three lines of text and `a | s | d`, and the status line is one
`|`-joined string. The user (2026-10-26): "is really pure text ... make it
look like Claude Code or Codex".

The goal is a chat screen that reads like Claude Code / Codex CLI: a
full-screen layout (header at the top, input pinned at the bottom), a styled
transcript with clear turn structure, tool calls shown as compact cards with
results and diffs, a bordered input box with a hint footer, a live working
indicator, and approvals and pickers you drive with arrow keys.

This is presentation only. `ChatHost`, the ask controller, modes, sessions,
skills, MCP and subagents keep their behaviour.

## 2. Goals, non-goals, anti-goals

Goals
- Each element of the transcript is recognisable at a glance: your message,
  nax's reply, a tool call, its result, a notice, an error.
- Markdown in replies renders (headings, bold, inline code, lists, fenced
  code with highlighting).
- Tool calls are one-line cards with a short result line; Edit/Write show a
  coloured diff; Bash shows the command and the first lines of output,
  collapsed beyond that.
- While a turn runs, one live line shows what is happening, elapsed time,
  tokens and how to interrupt.
- The input is a bordered, editable box (cursor movement, multi-line,
  history) with a footer showing mode, model, context use and cost.
- Approvals, `/model`, `/resume` and `/` commands are selectable lists.

Non-goals
- No panes or split views, no mouse capture (native terminal selection keeps
  working on what is on screen).
- No change to koda, the run TUI (`nax run`), or the ACP server.
- No new chat features (no `@` file search in phase 1 to 3, no image paste).

Anti-goals
- A redraw that flickers or slows down on long sessions (the current
  `Transcript` re-renders every row on every delta).
- Colour that breaks on a light terminal, under `NO_COLOR`, or in a 16-colour
  terminal.
- A copy of Claude Code's branding. The layout is borrowed; the name, accent
  colour and wording are nax's.

## 3. What exists (main `492527891`)

- `packages/nax/src/tui/chat/`: `ChatApp.tsx` (118 lines), `Transcript.tsx`
  (`TranscriptEntry` = message | text | thinking | tool; every row a plain
  `<Text>`), `InputBox.tsx` (append/backspace only, no cursor, `meta+return`
  newline), `AskPrompt.tsx` (letter keys a/s/d), `ChatStatusLine.tsx`,
  `useChatKeys.ts` (ctrl-c interrupt / double ctrl-c quit, shift-tab mode
  cycle), `slash-commands.ts` (13 built-ins + catalog commands and skills).
- Dependencies already present: `ink` 6, `react` 19, `ink-spinner`, `chalk`,
  `ink-testing-library`.
- Data the UI can use without host changes: `SessionEvent` carries
  `thinking_delta` text, `tool_call` name + input (Edit has
  `path/old_string/new_string`), `tool_result` `isError` + `preview`,
  `usage` per round (input/output/cache tokens, cost), `compaction`,
  `approval_requested` (tool, summary, command, reason, `unsandboxed`,
  `expiresAt`), `turn_end` status/usage/cost. `ChatHostState` has model,
  mode, sessionId, meta (cost), sandbox.
- Missing for the footer's context meter: the model's context window. The
  nax-ai catalog has `contextWindow`; the host must expose it (section 6).

## 4. The design

### 4.1 Screen anatomy

**Full screen, verified 2026-10-26.** Probed in tmux (120x40): Claude Code
v2.1.310 and Codex CLI 0.164.0 both switch to the alternate screen
(`#{alternate_on}` = 1); the shell line printed before launch is gone, the
header sits on row 1-4 and the input on the last 2-4 rows from the first
frame, with the empty space between. Claude Code frames the input with a
full-width horizontal rule above and below (no side borders) and puts the
mode line under it; Codex uses a `›` prompt with a two-line footer (model +
cwd, then key hints). nax chat follows the same model: alternate screen,
fixed header, scrolling transcript viewport, input and footer pinned at the
bottom.

```
 ✻ nax chat v0.91.7 · claude-sonnet-5-5 · guarded
   ~/workspace/.../repos/nax · sandbox on
 ─────────────────────────────────────────────────────────────────

 > add a --json flag to nax status

 ⏺ I'll look at how the status command builds its output first.

 ⏺ Read(packages/nax/src/cli/status.ts)
   ⎿  Read 182 lines

 ⏺ Grep("formatStatus", packages/nax/src)
   ⎿  Found 3 matches

 ⏺ Edit(packages/nax/src/cli/status.ts)
   ⎿  Updated packages/nax/src/cli/status.ts (+6 -1)
       41   export interface StatusOptions {
       42 -   verbose?: boolean;
       42 +   verbose?: boolean;
       43 +   json?: boolean;
       44   }

 ⏺ Bash(bun run test:unit -- status)
   ⎿  12 pass, 0 fail
      Ran 12 tests across 1 file. [1.04s]
      … +8 lines (ctrl+o to expand)

 ⏺ Added `--json` to **nax status**. It prints the same fields as the
   table as one JSON object; tests pass.

 ✻ Thinking… (14s · ↓ 2.1k tokens · esc to interrupt)

 ─────────────────────────────────────────────────────────────────
 > _
 ─────────────────────────────────────────────────────────────────
   ⏵ guarded · shift+tab to cycle       sonnet-5-5 · 18% ctx · $0.42
```

Regions, top to bottom, filling exactly `rows x columns`:

1. **Header** (3-4 rows): `✻ nax chat vX`, model and mode, cwd shortened.
   At session start the welcome card also lists skills/MCP/agents counts and
   tips in the transcript area; once the transcript fills the screen only
   the header stays.
2. **Transcript viewport** (all remaining rows). Shows the bottom of the
   transcript and follows new output while you are at the bottom. PgUp/PgDn
   (and shift+up/down) scroll it; scrolling up stops the follow and shows a
   `↓ new output (End)` marker; End or sending a message jumps back to the
   bottom. Only visible lines render (virtualised): items are measured into
   wrapped lines once, re-measured on resize, and finished items cache their
   lines so streaming never re-lays out the whole history.
3. **Working line** (1 row, only during a turn).
4. **Input**: between two full-width rules, grows up to 8 rows then scrolls
   inside.
5. **Footer** (1 row).

Lifecycle: enter the alternate screen on start and leave it on every exit
path (quit, double ctrl-c, uncaught error, SIGTERM/SIGHUP), restoring the
cursor. On exit print a short summary into the normal screen: session id,
`nax chat --resume <id>`, turns, cost. Like Codex, this is the only output
that survives in the shell's scrollback. `ctrl+o` opens a full-transcript
view (no collapsing, thinking shown) in the same viewport; esc returns.

### 4.2 Transcript items

| Item | Look |
|---|---|
| Welcome card | Rounded border, accent title `✻ nax chat` + version; cwd (home as `~`), model, mode, sandbox, counts of skills/MCP/agents, `/help` hint. Printed once at start and after `/clear` (`/resume` prints a short "resumed <id> · N turns" card). |
| User message | `> ` in accent, text in default colour on a subtle background band (dim grey bg; no bg under `NO_COLOR`). Slash commands show as typed. |
| Reply text | `⏺ ` bullet in default/white, then markdown rendered to ANSI, wrapped to width with a 2-column hanging indent. |
| Thinking | While streaming: the working line says `Thinking…`. Finished thinking is one dim italic line `✻ Thought for 6s (ctrl+o to show)`; ctrl+o expands it. |
| Tool card | `⏺ Name(arg)` with the bullet coloured by state: blinking dim while running, green on ok, red on error. The arg is the most telling input field (path for Read/Write/Edit/Delete, pattern + path for Grep/Glob, command for Bash, `server__tool` for MCP). Result on the next line after `⎿ `: a one-line summary built from the preview, dim. |
| Edit / Write result | Summary `Updated <path> (+a -r)` / `Wrote N lines to <path>`, then a coloured diff: removed lines red bg, added lines green bg, line numbers dim, at most 12 lines then `… +N lines`. Built from `old_string`/`new_string` on the call plus the line range in the result preview. |
| Bash result | First 3 lines of the preview, then `… +N lines (ctrl+o to expand)`. Error results in red. |
| Subagent (`nax-agents__run`) | `⏺ Agent(explorer: find where status is formatted)` with the child's tool calls indented beneath it, dim, showing only the last 3 while running and collapsing to `⎿ Done (9 tool uses · 14.2k tokens · 38s)` when it ends. |
| Notice | Dim, prefixed `※`, e.g. resource notices, mode switched, compaction (`※ conversation compacted`). |
| Warning | Yellow `⚠`, e.g. the sandbox-unavailable warning. |
| Error | Red `✗ <code>: <message>`, e.g. errored `turn_end`. |
| Interrupted | Dim `⎿ Interrupted by user` under the last item. |

### 4.3 Working line

One line in the live region whenever a turn runs:

```
 ✻ Running Bash… (12s · ↑ 8.4k ↓ 1.2k tokens · esc to interrupt)
```

- Spinner glyph animates (`· ✢ ✳ ✶ ✻ ✽` cycle, ASCII `-\|/` fallback).
- Verb from the current state: `Thinking…`, `Writing…` (text streaming),
  `Running <Tool>…`, `Waiting for approval…`, `Compacting…`, `Retrying…`
  (`stream_reset`).
- Elapsed seconds since `turn_start`; tokens summed from `usage` events.
- `esc to interrupt`: Esc cancels the turn (new key; ctrl-c keeps working).

### 4.4 Input box and footer

Input: between two full-width rules (Claude Code style), dim grey; accent
rules while focused.

- Real line editor: cursor left/right, home/end (ctrl-a/ctrl-e), word jump
  (alt-left/right), ctrl-u / ctrl-k / ctrl-w, delete at cursor, paste of
  multi-line text kept as is.
- Newline: shift+enter where the terminal reports it, `\` + enter
  everywhere, existing meta+enter kept.
- History: up/down on the first/last line walks previous prompts of this
  session (in memory; persisting is out of scope).
- Placeholder when empty and idle: `Try "explain this repo" · / for commands`.
- Busy: the box stays editable (type ahead); enter is held until the turn
  ends, except `/` commands which behave as today.
- Ask open: the box is replaced by the ask card (4.5).

Footer (one line under the box, dim):

```
 ⏵ guarded · shift+tab to cycle          sonnet-5-5 · 18% ctx · $0.42
 ⏵⏵ full · sandbox off                   sonnet-5-5 · 61% ctx · $3.10
```

- Left: mode with marker (`⏵` guarded, `⏵⏵` full in red/orange), then a
  contextual hint: `shift+tab to cycle` normally, `esc to interrupt` while
  busy, `esc again to clear` after one esc on a non-empty box, `press
  ctrl-c again to quit` after one ctrl-c.
- Right: short model name, context used (last round's input + cache tokens
  over the model's context window, yellow over 70%, red over 90%), session
  cost.
- Sandbox shown only when it is not `on`.

### 4.5 Approval and question cards

Approval replaces the input box:

```
 ╭─ Bash command ───────────────────────────────────────────────╮
 │                                                              │
 │   bun run test:integration -- chat                           │
 │   Run the chat integration tests                             │
 │                                                              │
 │   reason: network access outside the sandbox                 │
 │                                                              │
 │ Do you want to run this command?                             │
 │ ❯ 1. Yes                                                     │
 │   2. Yes, and don't ask again for this in this session       │
 │   3. No, tell nax what to do instead (esc)                   │
 │                                                     9:41 left │
 ╰──────────────────────────────────────────────────────────────╯
```

- Border yellow; red with title `Bash command · outside the sandbox` when
  `unsandboxed`.
- Title from the tool (`Bash command`, `Edit file`, `Write file`,
  `MCP tool <server>__<tool>`, `Agent`). Edit/Write asks show the diff
  preview from 4.2 inside the card.
- Up/down + enter, number keys, esc = option 3. Option 2 only when
  `canRemember`. Today's `a`/`s`/`d` keys keep working as aliases.
- Option 3 denies and puts the cursor in the input box with a dim hint
  `tell nax what to do instead`; the next message is sent as usual.
- A countdown from `expiresAt`, dim, turning yellow in the last minute.
- Subagent asks keep the `[agent X]` prefix as a dim tag in the title.
- Question card: same frame, title `nax asks`, the question text, then an
  inline input line inside the card.

### 4.6 Slash command menu and pickers

Typing `/` as the first character opens a menu under the input box:

```
 ╭──────────────────────────────────────────────────────────────╮
 │ > /re_                                                       │
 ╰──────────────────────────────────────────────────────────────╯
   /resume        Resume a saved session
 ❯ /review        (skill) Review the current diff
   /refactor      (command) Refactor with the cleaner agent
```

- Built-ins first, then catalog commands, then skills; fuzzy prefix filter;
  up/down to move, tab to complete, enter to run, esc to close. At most 8
  rows, scroll beyond.
- Every built-in gets a one-line description (today `/help` lists bare
  names).

Pickers (same list style, replace the input box while open):

- `/model` with no arg: list of `host.models`, current one marked.
- `/resume` with no arg: sessions with title, relative time
  (`2h ago`), and `in use` tag; enter resumes.
- `/mode` with no arg: guarded / full with a one-line explanation each.

Listings (`/help`, `/skills`, `/plugins`, `/mcp`, `/agents`, `/sessions`,
`/cost`) print as a titled block into the scrollback: bold title, aligned
two-column rows, status coloured (MCP `connected` green, `not locked`
yellow, `failed` red). The text producers in `@/chat` and `@/resources`
stay; the TUI gets structured rows (section 6) or parses nothing and keeps
plain text where a producer has no structure yet (builder's call per
listing).

### 4.7 Theme

- One token module `packages/nax/src/tui/chat/theme.ts`: `accent`, `muted`,
  `success`, `warning`, `danger`, `diffAdd`, `diffRemove`, `userBand`,
  `border`, `borderFocus`. Components read tokens, never literal colours.
- Accent: a nax colour (proposal: teal/cyan `#2bb5a3`, 16-colour fallback
  `cyan`). Claude Code's orange is not used.
- Truecolor / 256 / 16 detection via chalk level; `NO_COLOR` and
  `--no-color` drop all colour and backgrounds but keep glyphs and layout.
- Light terminal: background bands use a token that is lighter-than-default
  on dark and darker-than-default on light (`COLORFGBG` hint, else assume
  dark); diff backgrounds fall back to coloured foreground.
- Glyphs: `⏺ ⎿ ✻ ❯ ⏵ ※ ⚠ ✗` with an ASCII set (`* | * > > - ! x`) when
  the locale is not UTF-8 or `NAX_ASCII=1`.

### 4.8 Keys (summary)

| Key | Action |
|---|---|
| enter | send / choose |
| shift+enter, `\`+enter, meta+enter | newline |
| esc | interrupt a running turn; close a menu; on an ask = deny-and-tell; twice on idle = clear the box |
| ctrl-c | interrupt; twice within 2s = quit (unchanged) |
| shift+tab | cycle mode (unchanged) |
| ctrl+o | expand / collapse the last collapsed output (thinking, Bash output, subagent) |
| up/down | history in the box; move in menus and cards |
| PgUp/PgDn, shift+up/down | scroll the transcript viewport |
| Home / End | top of the transcript / latest output (follow again); the input uses ctrl-a / ctrl-e |
| tab | complete in the `/` menu |

## 5. Constraints

- ink 6 + React 19 only. ink has no alternate-screen switch: write
  `\x1b[?1049h` / `\x1b[?1049l` around `render()` and in every exit path
  (with a test). Root `<Box height={rows}>` from `useStdout()`, re-laid out
  on resize. `<Static>` is not used (it writes to scrollback, which the
  alternate screen does not keep).
- Markdown and highlighting: prefer a maintained package over hand-rolling
  (user rule), measured for bundle size and startup; candidates `marked` +
  a small ANSI renderer, `cli-highlight` for fenced code. Builder decides
  after measuring.
- File size: 800-line cap per file; one component per file; pure
  formatting functions (`toolCardModel(event)`, `diffLines()`, `footerModel()`)
  separate from components so they unit-test without ink.
- Immutability: transcript state stays an append/replace array as today.
- Performance: no full re-render per delta; a 500-turn session must not slow
  typing (viewport renders only visible lines).
- Tests: ink-testing-library frame snapshots per item and per card with
  colour stripped plus one colour-on snapshot; existing chat tests keep
  passing (behaviour unchanged).

## 6. Host and data changes needed

Small, additive, all in `packages/nax/src/chat` (no nax-agent change):

1. `ChatHostState.contextWindow?: number` from the nax-ai catalog entry of
   the current model (absent = footer hides the percentage).
2. `ChatHostState.lastInputTokens` or the TUI sums the last `usage` event
   itself (builder's call; the TUI already sees every event).
3. Subagent child events already reach the host (F5b forwards tool_call /
   tool_result); the TUI needs the parent `callId` on them to nest. If the
   forwarded events lack it, add `metadata.parentCallId` in the F5b host
   wiring.
4. Optional structured rows for listings (`listMcpRows()` etc.) beside the
   existing text formatters.
5. Welcome card counts: catalog skill/command/agent counts and MCP server
   count, read from what `ChatHost` already holds.

## 7. Suggested phases (one feature, or split if the AC cap forces it)

1. Shell: alternate screen + exit summary, theme tokens, header and welcome
   card, scrolling transcript viewport, user/reply/notice/warning/error
   styles, working line, ruled input with cursor editing, footer. Already removes most of the "pure text" feel.
2. Content: markdown rendering, tool cards with result summaries, Edit/Write
   diffs, Bash collapse + ctrl+o, thinking summary, subagent nesting.
3. Interaction: approval and question cards with selection and countdown,
   `/` menu, `/model` `/resume` `/mode` pickers, styled listings, esc keys,
   history.

## 8. Left to the builder

- Component split and file names under `tui/chat/`.
- Exact summary wording per tool result (from each tool's preview format).
- Markdown/highlight package choice after measuring.
- How the user-message background band degrades per terminal.
- Whether `/help` becomes a picker or stays a listing.

## 9. Decision log

| Decision | By | When |
|---|---|---|
| Redesign the chat TUI to look like Claude Code / Codex; design first | user | 2026-10-26 |
| User skipped the design questions ("just design it") | user | 2026-10-26 |
| Full screen (alternate screen) like Claude Code / Codex, verified by tmux probe; replaces the inline draft | user | 2026-10-26 |
| Input between full-width rules (Claude Code style), exit summary printed to the normal screen (Codex style) | Claude | 2026-10-26 |
| nax accent colour (teal), not Claude orange | Claude | 2026-10-26 |
| Esc interrupts in addition to ctrl-c; a/s/d kept as aliases | Claude | 2026-10-26 |
| Three phases: shell, content, interaction | Claude | 2026-10-26 |
| No `@` file mentions, no persisted history in this redesign | Claude | 2026-10-26 |
| One feature (not three), one PR | user | 2026-10-26 |
| Fenced code is syntax highlighted in this redesign | user | 2026-10-26 |
| Markdown parsed with the `marked` package; packages added by hand before the run | user / Claude | 2026-10-26 |
| ctrl+o toggles expanded mode for the whole transcript (no separate full-transcript view); ctrl-l dropped | Claude (spec) | 2026-10-26 |
| Spec: `.nax/features/chat-tui-redesign/spec.md`, 26 stories after AC-cap splits | Claude | 2026-10-26 |

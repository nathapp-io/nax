<!-- spec-writing: completed-through-phase-5 -->
# SPEC: chat-transcript-polish — collapsed skill blocks, click to expand, and a tidier screen

## Summary

Five fixes to how `nax chat` draws its transcript, from the 2026-10-28 TUI bug check:

1. **Skill invocations collapse.** A `/skill` turn currently draws the whole expanded SKILL.md as the
   user's message. It becomes one user row with the skill's qualified name and args
   (`> /superpowers:brainstorming plan it`) and one muted row under it, `⎿ skill superpowers:brainstorming · 42 lines (ctrl+o to show)`;
   the body is drawn only when expanded. Replayed sessions show the same.
2. **Click to expand one block.** ctrl+o keeps toggling every collapsible block at once (thinking,
   tool detail, and now skills). A left click on a collapsible block's header row (for a skill, its
   user row or its `⎿  skill` row) toggles just that block.
3. **A notice on every model or mode change**, so `/model`, `/effort`, the pickers and shift+tab
   leave a trace: `model: deepseek-v4.1-flash[high]`, `mode: full`.
4. **A live output-token estimate.** The working line read `↑ 0 ↓ 0 tokens` for a whole turn because
   it counts only `usage` events. It now shows `↓ ~<n> tokens` from the streamed text while no usage
   has arrived, and the `↑` part only once a usage event has.
5. **A tidier frame.** The welcome card no longer repeats the header's `✻ nax chat` title, the
   transcript starts right under the header (blank rows go below it, not above), and the slash menu
   aligns its descriptions in one column and says how many matches it is not showing.

It is the third of three chat-polish features. chat-resume-sessions (#2727) and chat-model-effort
(#2728) have both merged: this feature extends the former's `history-replay.ts`, and its model
notices read the `<model>[<level>]` string the latter produces.

## Motivation

Observed in a 120x36 tmux probe of `nax chat` v0.91.7-canary.6 (2026-10-28):

- `/superpowers:verification-before-completion check nothing` drew about 120 lines of skill body,
  ending in `</skill>` and then the user's two words, pushing the conversation off the screen.
- The user asked for collapsed blocks that expand "only if click or with key combination"; the
  ruling (2026-10-28) is ctrl+o plus a click.
- After `/model deepseek…` nothing in the transcript said the model had changed; only the header
  and footer did, and those were truncated.
- The working line stayed at `↑ 0 ↓ 0 tokens` throughout a turn that was streaming text.
- The header's first row is `✻ nax chat v… · model · mode`, and the welcome card starts with
  `✻ nax chat` again, 20 blank rows lower, because `TranscriptViewport` pads blank rows above a short
  transcript.
- The slash menu's descriptions start right after each name (`/help  Show…`, `/sessions  List…`), so
  they do not line up, and a list longer than the menu gives no sign that more matches exist.

## Design

### Approach

- **Skill entry.** A new `TranscriptEntry` kind `{ kind: "skill"; name: string; args: string; body:
  string; open?: boolean }`. A new parser `parseSkillInvocation(content)` in
  `packages/nax/src/chat/skill-invocation.ts` is the inverse of `buildSkillInvocationMessage`. It
  returns `undefined` unless the content matches `^<skill name="([^"]+)"\s` (a non-empty name whose
  closing quote is followed by whitespace, as `session-title.ts` already requires) and contains a
  `\n</skill>` line. Otherwise:
  - `name` is the `name` attribute.
  - The closing marker is chosen with the rule `replayHistory` already uses: when the content ends
    with `</skill>`, that final `\n</skill>` is the close and `args` is `""`; otherwise the close is
    the LAST `\n</skill>\n\n` and `args` is the text after it, trimmed. A body may itself contain
    `</skill>` lines either way.
  - `body` is the text between the envelope's second line (the `References are relative to …`
    line) and the chosen close, exactly as stored (not trimmed).
- **Live sends.** `sendTurn` in `ChatApp` runs `parseSkillInvocation` on the prepared message it is
  about to append: when it returns a value, `sendTurn` appends that skill entry instead of the user
  entry; otherwise it appends the user entry as today. This covers catalog skills (`catalogCommand`
  is the only builder of the envelope) without a new outcome discriminator; a `/feature` or command
  turn, whose message never starts with `<skill name="`, still draws a user entry. `host.send` still
  receives the full message.
- **Replay.** `replayHistory` (from chat-resume-sessions) emits the skill entry `parseSkillInvocation`
  returns for a stored user message, and a user entry with the raw content when it returns
  `undefined`. Its inline skill regex and `SKILL_ARGS_DELIMITER` logic are replaced by the parser;
  `session-title.ts` keeps its own title regex.
- **Skill layout.** `<n>` is the body's line count: the number of parts `body.split(SOURCE_LINE_BREAK)`
  yields (the layout's own `\r\n`/`\r`/`\n` splitter from `layout-lines.ts`) after removing at most
  one trailing line break, and 0 for an empty body; the unit is `line` when `<n>` is 1, else `lines`.
  - Collapsed: the user row text `/<name> <args>` (` <args>` omitted when empty) drawn by the
    existing `userLines`, so long or multi-line args wrap like any user message, then the muted row
    `resultPrefix(theme) + "skill <name> · <n> lines (ctrl+o to show)"`,
    e.g. `  ⎿  skill s · 3 lines (ctrl+o to show)` in the default theme and
    `  |  skill s · 3 lines (ctrl+o to show)` in the ASCII theme.
  - Expanded: the same rows with `(ctrl+o to hide)`, then each body line (split with
    `SOURCE_LINE_BREAK`), muted, behind `cardIndent(theme)` (spaces as wide as `resultPrefix(theme)`),
    wrapped to the layout width; a blank body line is drawn as a row holding only the indent.
- **Per-block open state.** Thinking, tool and skill entries gain an optional `open?: boolean`. A
  block is drawn expanded when `entry.open ?? expanded` is true, where `expanded` is the existing
  screen-wide ctrl+o flag; ctrl+o keeps flipping only that flag. A new
  `transcriptLineOwners(entries, options): readonly (number | undefined)[]` returns, for each line
  `layoutTranscript` produces with the same arguments, the index of the entry that drew it
  (`undefined` for separator lines). A click (defined below) on a toggle line of a thinking, tool or
  skill entry replaces that entry with `{ ...entry, open: !(entry.open ?? expanded) }`. The toggle
  lines are the entry's FIRST line for thinking and tool entries, and for a skill entry the first
  line of its user row and the `⎿  skill … (ctrl+o to …)` hint row. A click on any other line (a
  later line of a thinking or tool entry, including a wrapped header's continuation row; a skill
  body line; a separator; a blank padding row; a line of another entry kind) changes nothing;
  drag-select and copy are unchanged. After a toggle the viewport behaves exactly as after ctrl+o
  today.
- **Click wiring.** A click is a left press on a mapped transcript point followed by a release, with
  no drag event at a cell other than the press cell in between (mapped or not) and the release at
  the press cell. `useMouseSelection` gains `onClick?(point: TranscriptPoint)`, called with the
  press point for a click, on the path where `finishSelection` returns without copying (the click
  still copies nothing); it tracks a `moved` flag set by any drag event at another cell so a drag
  that strays onto an unmapped row and back is not a click. `TranscriptViewport` gains an `onClick?(line: number)` prop that it passes through
  as `onClick: (point) => onClick?.(point.line)`. `ChatApp` passes an `onClick` that looks the line
  up in `transcriptLineOwners` and applies the toggle. A press whose cell maps to no transcript
  point records no anchor today and so produces no click.
- **Switch notices.** `ChatApp` remembers the last `(sessionId, model, mode)` it drew, seeded at
  mount from the first `host.current()` (so mount appends nothing). When the session id is unchanged
  and the model string differs it appends `{ kind: "notice", text: "model: <model after the last
  slash>" }` (the string keeps any `[<level>]` suffix, e.g. `model: m[high]`); when the mode differs
  it appends `mode: <full|guarded>`; when both differ, the model notice comes first. A session id
  change appends neither (chat-resume-sessions rebuilds the transcript then). Every path that ends
  in `switchTo` (`/model`, `/effort`, the model and effort pickers' choose, shift+tab) is covered by
  this one comparison; the model picker's left/right effort cycling only stages a choice and appends
  nothing until choose.
- **Live token estimate.** `TurnStatus` gains `streamedChars: number`, the characters of
  `text_delta` and `thinking_delta` text since the last `usage` event of the turn; `turn_start` and
  every `usage` event reset it to 0, and so does `stream_reset` (a retry discards the streamed text).
  A turn "has usage" when `inputTokens + outputTokens > 0` (no
  new flag). The working line's tokens part is:
  - with usage: `↑ <in> ↓ <out> tokens`, plus ` (+~<estimate>)` after `<out>` while
    `streamedChars > 0`. Existing working-line cases with token counts (e.g. the `AGENT_STATUS`
    fixture, `↑ 8.4k ↓ 1.2k tokens`) keep their text.
  - without usage: `↓ ~<estimate> tokens` alone.
  `<estimate>` is `Math.ceil(streamedChars / 4)` formatted with the existing `formatTokens`.
- **Welcome and viewport.** `welcomeLines` drops its `✻ nax chat` title line and the empty line after
  it, keeping the counts line and the tips line. `TranscriptViewport` pads blank rows BELOW the
  visible lines when the transcript is shorter than the window; scrolling, follow and the unseen
  marker are unchanged. `transcriptPointAt` changes to match: with no top padding, window row `r`
  (0-based, under `top`) maps to visible line `start + r` while `r < count`, and the blank rows
  below map to `undefined`.
- **Slash menu.** Every drawn row pads `/name` to the widest drawn name plus the existing two-space
  gap, so descriptions start in one column. When there are more matches than `maxRows` and
  `maxRows >= 2`, `slashMenuLayout` asks `slashMenuWindow` for a window of `maxRows - 1` rows and
  appends the muted row `  <ellipsis> <k> more` (`<ellipsis>` = `theme.glyphs.ellipsis`, `…` or
  `...`; `k` = matches not drawn). When `maxRows` is 1, the pointer's row alone is drawn and no
  more-row. The menu's total row count, which `ChatApp` budgets, is unchanged. `slashMenuWindow`
  itself is unchanged.

### Integration (extends existing code)

Read only (verified 2026-10-28):

- `buildSkillInvocationMessage({ skill, args })` in `packages/nax/src/prompts/builders/skills-builder/index.ts`:
  `<skill name="<qualifiedName>" location="<path>">`, `References are relative to <baseDir>; …`,
  `<body>`, `</skill>`, then `\n\n<args>` when args are non-empty; `args` is `command.rest`, which
  starts with a space.
- `catalogCommand` in `packages/nax/src/tui/chat/slash-commands.ts` returns
  `{ kind: "send", message: buildSkillInvocationMessage(…) }` for a skill.
- `useMouseSelection` (`packages/nax/src/tui/chat/use-mouse-selection.ts`): a press records an
  anchor; `finishSelection` returns early for a press and release at the same point.
- `transcriptPointAt(geometry, x, y)` (`packages/nax/src/tui/chat/selection.ts`) maps a mouse cell to
  a transcript line index.
- `SHOW_HINT` / `HIDE_HINT`, `userLines`, `thinkingLines`, `layoutTranscript` in
  `packages/nax/src/tui/chat/layout.ts`; `resultPrefix(theme)` in `layout-lines.ts`.
- `slashMenuWindow(count, selected, maxRows)` in `packages/nax/src/tui/chat/slash-menu.ts`.

Changed — the **Baseline** only locates the code; implement the **Target**.

- `TranscriptEntry` (`transcript-model.ts`) — Target adds the `skill` kind and an optional
  `open?: boolean` on the `thinking`, `tool` and `skill` kinds.
- `layoutTranscript` — Baseline draws a thinking/tool entry expanded when `context.expanded`;
  Target uses `entry.open ?? context.expanded`. Its signature and return type are unchanged.
- `replayHistory` (`packages/nax/src/tui/chat/history-replay.ts`, created by chat-resume-sessions)
  - Baseline: a message matching `^<skill name="…"` replays as `{ kind: "user", text: "/<name> <args>" }`
    via the inline regex and `SKILL_ARGS_DELIMITER`.
  - Target: it replays as the `skill` entry `parseSkillInvocation` yields, or a user entry with the
    raw content when the parser returns `undefined`.
- `sendTurn` (`ChatApp.tsx`) — Baseline appends `{ kind: "user", text: prepared.message }`; Target
  appends the parsed skill entry when `parseSkillInvocation(prepared.message)` returns one.
- `useMouseSelection` (`use-mouse-selection.ts`) — Target accepts `onClick?(point)`, called from
  `finishSelection` when the release lands on the press point (the path that returns without
  copying).
- `TranscriptViewport` (`TranscriptViewport.tsx`) — Target pads below, and gains an
  `onClick?(line: number)` prop forwarded to `useMouseSelection`.
- `transcriptPointAt` (`selection.ts`) — Baseline subtracts the top padding (`index = row - padding`);
  Target maps row `r` to line `start + r` for `r < count` and `undefined` for the blank rows below.
- `TurnStatus` / `reduceTurnStatus` / `workingLine` (`chat-status.ts`) — Target adds
  `streamedChars` and the estimate rule above.
- `welcomeLines` (`layout-status.ts`) — Target drops the title line and its blank line.
- `slashMenuLayout` (`SlashMenu.tsx`) — Target aligns names and adds the more-matches row by
  requesting a `maxRows - 1` window from the unchanged `slashMenuWindow`.

New: `packages/nax/src/chat/skill-invocation.ts` (`parseSkillInvocation`), re-exported from the
chat barrel; `transcriptLineOwners` exported from `layout.ts`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| a user message starts with `<skill name="` but has no closing quote or no `\n</skill>` line | `parseSkillInvocation` returns `undefined`; live send appends a user entry with the message, replay a user entry with the raw content |
| a click lands on a separator line, a blank padding row, or outside the transcript | nothing changes |
| a click lands on a line of an entry that is not thinking, tool or skill, or on a non-first line of one that is | nothing changes |
| `streamedChars` is 0 and no usage arrived | the tokens part is `↓ ~0 tokens` |
| the slash menu has more matches than `maxRows` and `maxRows` is 1 | the pointer's row alone, no more-matches row |

## Out of Scope

- A per-block keyboard toggle (moving a cursor between blocks); ctrl+o stays screen-wide.
- Collapsing long tool output beyond what tool cards already collapse.
- Persisting a block's open state across a resume; replayed blocks start collapsed.
- Changing how a catalog command turn is shown; only skill invocations collapse.
- A notice when the sandbox state changes.
- Exact token counting from a tokenizer; the estimate is characters divided by four.
- Keeping a clicked block's header in view: after a click toggle the viewport scrolls, follows and counts unseen lines exactly as after ctrl+o today.

## Stories

### US-001 — parse skill invocations and draw a collapsed skill entry

Workdir: packages/nax. No dependencies.

New `parseSkillInvocation`, the `skill` transcript kind, and its collapsed and expanded layout
under the screen-wide ctrl+o flag.

### US-002 — use skill entries for live sends and replay

Workdir: packages/nax. Depends on US-001.

`ChatApp` appends a skill entry for a catalog-skill turn; `replayHistory` emits one for a stored
envelope.

### US-003 — click a block's first row to toggle it

Workdir: packages/nax. Depends on US-001 and US-006.

`open?` on thinking, tool and skill entries, `transcriptLineOwners`, `onClick` in
`useMouseSelection`, the `onClick` prop on `TranscriptViewport`, and the toggle in `ChatApp`. It
runs after US-006 so its click tests are written against the bottom-padded viewport and the new
`transcriptPointAt` mapping.

### US-004 — notices for model and mode changes

Workdir: packages/nax. No dependencies.

`ChatApp` compares each new `host.current()` model and mode with the last ones it drew on the same
session id and appends a `model: …` or `mode: …` notice on a change, covering `/model`, `/effort`,
the pickers and shift+tab through their shared `switchTo`.

### US-005 — live output-token estimate on the working line

Workdir: packages/nax. No dependencies.

`TurnStatus.streamedChars` counts streamed text since the last usage event, and `workingLine` shows
a `~` estimate from it while the turn has no usage, or as a `(+~n)` suffix after usage.

### US-006 — welcome card without the title, transcript anchored under the header

Workdir: packages/nax. No dependencies.

`welcomeLines` loses its title; `TranscriptViewport` pads blank rows below a short transcript, and
`transcriptPointAt` maps mouse rows to lines for that layout so selection still lands on the right
line.

### US-007 — aligned slash menu with a more-matches row

Workdir: packages/nax. No dependencies.

`slashMenuLayout` pads names to one description column and, when matches exceed the rows, draws a
`<ellipsis> <k> more` row in place of the last item row.

### Context Files

**US-001**
- `packages/nax/src/prompts/builders/skills-builder/index.ts`
- `packages/nax/src/tui/chat/transcript-model.ts`
- `packages/nax/src/tui/chat/layout.ts`
- `packages/nax/src/tui/chat/layout-lines.ts`

**US-002**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/tui/chat/history-replay.ts`
- `packages/nax/src/chat/skill-invocation.ts` — created by US-001, used here

**US-003**
- `packages/nax/src/tui/chat/transcript-model.ts`
- `packages/nax/src/tui/chat/use-mouse-selection.ts`
- `packages/nax/src/tui/chat/selection.ts`
- `packages/nax/src/tui/chat/TranscriptViewport.tsx`
- `packages/nax/src/tui/chat/layout.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`

**US-004**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/chat-status.ts`

**US-005**
- `packages/nax/src/tui/chat/chat-status.ts`

**US-006**
- `packages/nax/src/tui/chat/layout-status.ts`
- `packages/nax/src/tui/chat/TranscriptViewport.tsx`
- `packages/nax/src/tui/chat/selection.ts`

**US-007**
- `packages/nax/src/tui/chat/SlashMenu.tsx`
- `packages/nax/src/tui/chat/slash-menu.ts`

### Creates

**US-001**
- `packages/nax/src/chat/skill-invocation.ts`
- `packages/nax/test/unit/chat/skill-invocation.test.ts`

**US-003**
- `packages/nax/test/ui/chat/use-mouse-selection.test.tsx`

### Modifies

**US-001**
- `packages/nax/src/chat/index.ts` — export `parseSkillInvocation` from the chat barrel so the TUI imports it through it.

**US-002**
- `packages/nax/test/unit/tui/chat/history-replay.test.ts` — the skill-envelope cases (AC-4 to AC-8) now expect a skill entry (name, args, body) instead of a user entry with the slash line, keeping each case's args; a case whose envelope the parser rejects now expects the raw content.
- `packages/nax/src/tui/chat/history-replay.ts` — `replayUser` calls `parseSkillInvocation` in place of its inline skill regex and `SKILL_ARGS_DELIMITER`.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `sendTurn` appends the parsed skill entry for a skill envelope.

**US-003**

None. The open override is optional and absent by default, so every existing layout and mouse-selection assertion keeps its result; new cases go into new tests.

**US-004**
- `packages/nax/test/ui/chat/chat-app-session.test.tsx` — the same-id mode and model switch case that scrolls up and asserts the transcript is unchanged now sees the new `mode:`/`model:` notice (and the unseen marker it causes); it asserts the scrolled viewport is preserved apart from that notice.

**US-005**
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — typed `TurnStatus` fixtures (`TOOL_STATUS`, `AGENT_STATUS`, `runningStatus()`) gain `streamedChars: 0`; working-line assertions for a running turn with zero input and output tokens change from the up-and-down zero-token form to the estimate-only form (cases with non-zero tokens, such as `AGENT_STATUS`, keep their text); turn-status equality assertions gain the new streamed-characters field.

**US-006**
- `packages/nax/test/unit/tui/chat/layout-status.test.ts` — the welcome lines no longer start with the title line and its blank line; assertions on the welcome card's first lines change to the counts line.
- `packages/nax/test/unit/tui/chat/selection.test.ts` — `transcriptPointAt` cases on a short (padded) window, including the short-marker case, now map row `r` to line `r` and the blank rows below to `undefined`.
- `packages/nax/test/ui/chat/transcript-viewport.test.tsx` — a transcript shorter than the window is now drawn from the top row with blank rows below it; assertions on the padded window's row order change accordingly.
- `packages/nax/test/ui/chat/chat-app-layout.test.tsx` — frames of a short transcript now show the welcome counts right under the header and blank rows below; row-position assertions change accordingly.

**US-007**
- `packages/nax/test/ui/chat/slash-menu.test.tsx` — rows now pad each name to the widest drawn name, so assertions on a row's exact text gain the padding; a list longer than the window now draws one item row fewer (the window around the pointer shrinks by one) plus the more-matches row.

### Seams

- `parseSkillInvocation` (US-001) is consumed by `ChatApp` and `replayHistory` (US-002); US-002's ACs type a catalog skill in a mounted `ChatApp` and assert the frame shows the collapsed skill rows, and replay a stored envelope and assert a skill entry.
- `transcriptLineOwners`, `useMouseSelection`'s `onClick` and `TranscriptViewport`'s `onClick` prop (US-003) are consumed by `ChatApp`; US-003's ACs send a mouse press and release through the mounted screen's mouse stream on a thinking block's first row and assert the frame toggles that block.

## Acceptance Criteria

### US-001 — parse skill invocations and draw a collapsed skill entry

- [unit] `parseSkillInvocation(buildSkillInvocationMessage({ skill, args: " plan it" }))` for a skill named `superpowers:brainstorming` with body `"line one\nline two"` returns `{ name: "superpowers:brainstorming", args: "plan it", body: "line one\nline two" }`.
- [unit] with `args: ""` it returns `args: ""`.
- [unit] `parseSkillInvocation` of an envelope built with body `"body\n</skill>\nmore"` and `args: " go"` returns body `"body\n</skill>\nmore"` and `args: "go"`.
- [unit] `parseSkillInvocation` of an envelope built with body `"body\n</skill>\n\nmore"` and `args: ""` returns body `"body\n</skill>\n\nmore"` and `args: ""` (the content ends with `</skill>`, so the embedded delimiter is part of the body).
- [unit] `parseSkillInvocation("hello")` returns `undefined`.
- [unit] `parseSkillInvocation('<skill name="x" location="/p">\nbody')` (no closing `</skill>`) returns `undefined`.
- [unit] `parseSkillInvocation('<skill name="x location="/p">\nrefs\nbody\n</skill>')` (no closing quote on the name) returns `undefined`.
- [unit] `layoutTranscript` with a skill entry `{ name: "s", args: "go", body: "a\nb\nc" }`, the default theme and `expanded: false` draws exactly two lines whose text is `> /s go` and `  ⎿  skill s · 3 lines (ctrl+o to show)`.
- [unit] `layoutTranscript` with the same skill entry and the ASCII theme draws `  |  skill s · 3 lines (ctrl+o to show)` as its second line.
- [unit] `layoutTranscript` with the same skill entry and `args: ""` draws `> /s` as its first line.
- [unit] `layoutTranscript` with skill bodies `"a\n"`, `""` and `"a"` draws the counts `1 line`, `0 lines` and `1 line` in the second line.
- [unit] `layoutTranscript` with the `"a\nb\nc"` skill entry and `expanded: true` draws `> /s go`, `  ⎿  skill s · 3 lines (ctrl+o to hide)`, then `     a`, `     b` and `     c` (each behind five spaces, the width of `resultPrefix`).
- [unit] `layoutTranscript` with an expanded skill entry whose body is one 200-character word and a layout width of 40 draws that word as several lines, each no wider than 40 columns, whose text after the indent concatenated equals the word.
- [unit] `layoutTranscript` with an expanded skill entry whose body is `"a\n\nb"` draws `     a`, a row holding only the five-space indent, and `     b` after the hint row, and the hint row reads `3 lines`.
- [unit] `layoutTranscript` with a collapsed skill entry whose args are wider than the layout width draws the user row as several wrapped lines followed by one `⎿  skill` hint line.

### US-002 — use skill entries for live sends and replay

- [integration] typing `/superpowers:brainstorming plan it` for a catalog skill in a mounted `ChatApp` draws `> /superpowers:brainstorming plan it` and the `⎿ skill superpowers:brainstorming · <n> lines (ctrl+o to show)` row, and the frame does not show the skill body.
- [integration] after that send in the mounted `ChatApp`, ctrl+o draws the skill body under the `⎿  skill` row.
- [integration] the host's `send` still receives the full invocation message as its first argument.
- [integration] a `/feature` command turn in a mounted `ChatApp` still draws its message as a `>` user row and no `⎿  skill` row.
- [integration] a typed message `<skill name="x` (no closing quote) sent in a mounted `ChatApp` draws a `>` user row with that text and no `⎿  skill` row.
- [unit] `replayHistory` of a stored skill envelope returns `{ kind: "skill", name, args, body }` with the values `parseSkillInvocation` returns.
- [unit] `replayHistory` of a user message starting with `<skill name="` that `parseSkillInvocation` rejects returns a user entry with the raw content.
- [integration] a resumed session whose stored history holds a skill envelope draws `> /<name> <args>` and the `⎿  skill <name> · <n> lines (ctrl+o to show)` row after the resume, and not the body.

### US-003 — click a block's first row to toggle it

- [unit] `transcriptLineOwners` returns one value per line `layoutTranscript` returns for the same entries and options.
- [unit] for entries `[user, thinking]` it returns `0` for the user lines, `undefined` for the separator, and `1` for the thinking lines.
- [unit] `layoutTranscript` draws a thinking entry with `open: true` expanded while `expanded` is false.
- [unit] `layoutTranscript` draws a thinking entry with `open: false` collapsed while `expanded` is true.
- [unit] a tool entry and a skill entry follow the same `open ?? expanded` rule.
- [unit] `useMouseSelection` calls `onClick` with the transcript point for a left press and release at the same cell.
- [unit] a press, a drag to another cell and a release calls no `onClick` and still copies the selected text.
- [unit] `useMouseSelection` with a press on a mapped cell, a drag event on an unmapped row, and a release back on the press cell calls no `onClick`.
- [integration] in a mounted `ChatApp` with a finished thinking block, a left click on the block's first row draws the thought; a second click on that row collapses it.
- [integration] in a mounted `ChatApp` with two finished thinking blocks, a click on the first block's first row expands only that block; the other stays collapsed.
- [integration] in a mounted `ChatApp`, after a click opened a block, ctrl+o and ctrl+o again leave that block expanded and toggle the others.
- [integration] in a mounted `ChatApp` after a skill send, a left click on the `⎿  skill … (ctrl+o to show)` row draws the skill body, a click on the `>` user row hides it again, and a click on a body line changes nothing.
- [integration] in a mounted `ChatApp`, a left click on a `reply` entry's line leaves the frame unchanged.
- [integration] in a mounted `ChatApp`, a left click on the separator row between two entries, and on a blank padding row below a short transcript, leaves the frame unchanged.
- [integration] in a mounted `ChatApp` at a width where a tool card's header wraps, a left click on the header's continuation row leaves the card collapsed; a click on its first row expands it.

### US-004 — notices for model and mode changes

- [integration] `/model p/other` in a mounted `ChatApp` whose fake host then reports `model: "p/other"` on the same session id appends the notice `model: other`.
- [integration] shift+tab that switches the host from `guarded` to `full` on the same session id appends `mode: full`.
- [integration] a `switchTo` that changes both model and mode appends both notices, model first.
- [integration] a resume in a mounted `ChatApp` whose fake host then reports a different session id with a different model and mode appends no `model:` or `mode:` notice.
- [integration] a `/model` naming the current model appends no notice.
- [integration] `/effort high` in a mounted `ChatApp` whose fake host goes from `model: "p/m[low]"` to `model: "p/m[high]"` on the same session id appends the notice `model: m[high]`.
- [integration] choosing a different model in the `/model` picker appends one `model: …` notice for the chosen model, and cycling effort with left/right before choosing appends none.
- [integration] mounting a `ChatApp` appends no `model:` or `mode:` notice.

### US-005 — live output-token estimate on the working line

- [unit] after `turn_start` and a `text_delta` of 40 characters, `reduceTurnStatus` yields `streamedChars: 40`.
- [unit] a `thinking_delta` adds its text length to `streamedChars`.
- [unit] a `usage` event resets `streamedChars` to 0 and adds its tokens as today.
- [unit] `turn_start` resets `streamedChars` to 0.
- [unit] a `stream_reset` event after a 40-character `text_delta` makes `reduceTurnStatus` yield `streamedChars: 0`.
- [unit] a subagent-tagged `text_delta` leaves the status unchanged.
- [unit] `workingLine` for a running turn with no usage and `streamedChars: 40` shows `↓ ~10 tokens` and no `↑`.
- [unit] `workingLine` with no usage and `streamedChars: 0` shows `↓ ~0 tokens`.
- [unit] `workingLine` after one usage event with `inputTokens: 1200`, `outputTokens: 300` and `streamedChars: 0` shows `↑ 1.2k ↓ 300 tokens`.
- [unit] the same with `streamedChars: 400` shows `↑ 1.2k ↓ 300 (+~100) tokens`.
- [unit] `workingLine` with no usage and `streamedChars: 41` shows `↓ ~11 tokens` (rounded up).
- [unit] `workingLine` with no usage and `streamedChars: 8000` shows `↓ ~2.0k tokens` in the `formatTokens` form.

### US-006 — welcome card without the title, transcript anchored under the header

- [unit] `welcomeLines` draws the counts line first and the tips line second, with no `nax chat` title line.
- [integration] a mounted `ChatApp` at 120x36 with only the welcome entry draws the counts line on the row right after the header rule.
- [integration] `TranscriptViewport` with 3 lines in a 10-row window draws the 3 lines on rows 1-3 and blank rows on rows 4-10.
- [integration] `TranscriptViewport` with more lines than the window still follows the last line and shows the unseen marker as before.
- [unit] `transcriptPointAt` for 3 lines in a 10-row window maps window rows 0-2 to lines 0-2 and rows 3-9 to `undefined`.
- [integration] in a mounted `TranscriptViewport` with 3 lines in a 10-row window, a drag from row 0 to row 1 copies text from lines 0 and 1.

### US-007 — aligned slash menu with a more-matches row

- [unit] `slashMenuLayout` for `/help` and `/sessions` draws both descriptions starting at the same column.
- [unit] `slashMenuLayout` for `/help` and `/sessions` starts each description at column `"/sessions".length + 2` after the pointer gutter.
- [unit] `slashMenuLayout` with 12 matches, `maxRows: 5`, the default theme and the pointer on the first match draws 4 item rows and a fifth row whose text is `  … 8 more`, and `rows` is 5.
- [unit] `slashMenuLayout` with the same input and the ASCII theme draws the fifth row as `  ... 8 more`.
- [unit] `slashMenuLayout` with 5 matches and `maxRows: 5` draws 5 item rows and no more-matches row.
- [unit] `slashMenuLayout` with 12 matches, `maxRows: 5` and the pointer on the last match draws the pointer's row and a more-matches row reading `8 more`.
- [unit] `slashMenuLayout` with 12 matches and `maxRows: 2` draws the pointer's row and `  … 11 more`; with `maxRows: 1` it draws the pointer's row alone, and `rows` is 1.
- [integration] typing `/s` in a mounted `ChatApp` whose fake host offers 10 skills starting with `s`, at a terminal height that gives the menu fewer rows than the matches, shows a row ending in `more`.

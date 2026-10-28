<!-- spec-writing: completed-through-phase-5 -->
# SPEC: chat-transcript-polish — collapsed skill blocks, click to expand, and a tidier screen

## Summary

Five fixes to how `nax chat` draws its transcript, from the 2026-10-28 TUI bug check:

1. **Skill invocations collapse.** A `/skill` turn currently draws the whole expanded SKILL.md as the
   user's message. It becomes one user row with the typed line (`> /superpowers:brainstorming plan
   it`) and one muted row under it, `⎿ skill superpowers:brainstorming · 42 lines (ctrl+o to show)`;
   the body is drawn only when expanded. Replayed sessions show the same.
2. **Click to expand one block.** ctrl+o keeps toggling every collapsible block at once (thinking,
   tool detail, and now skills). A left click on a collapsible block's first row toggles just that
   block.
3. **A notice on every model or mode change**, so `/model`, `/effort`, the pickers and shift+tab
   leave a trace: `model: deepseek-v4.1-flash[high]`, `mode: full`.
4. **A live output-token estimate.** The working line read `↑ 0 ↓ 0 tokens` for a whole turn because
   it counts only `usage` events. It now shows `↓ ~<n> tokens` from the streamed text while no usage
   has arrived, and the `↑` part only once a usage event has.
5. **A tidier frame.** The welcome card no longer repeats the header's `✻ nax chat` title, the
   transcript starts right under the header (blank rows go below it, not above), and the slash menu
   aligns its descriptions in one column and says how many matches it is not showing.

It is the third of three chat-polish features. It depends on chat-resume-sessions having merged
(it extends that feature's `history-replay.ts`) and is independent of chat-model-effort apart from
reading the model string it produces.

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
  `packages/nax/src/chat/skill-invocation.ts` is the inverse of `buildSkillInvocationMessage`:
  `name` from the `<skill name="…"` attribute, `args` from the text after the LAST `</skill>\n\n`
  (trimmed), `body` from the envelope's inner text after its references line. `ChatApp` appends a
  skill entry instead of a user entry when the turn came from a catalog skill, and
  `replayHistory` (from chat-resume-sessions) emits one for a stored skill envelope instead of the
  `/name args` user line.
- **Skill layout.** Collapsed: the user row `> /<name> <args>` (args omitted when empty) in the user
  band, then a muted `⎿ skill <name> · <n> lines (ctrl+o to show)` row, where `<n>` is the body's
  line count. Expanded: the same two rows with `(ctrl+o to hide)`, then the body lines, muted,
  indented under the `⎿` row and wrapped to the layout width.
- **Per-block open state.** Thinking, tool and skill entries gain an optional `open?: boolean`. A
  block is drawn expanded when `entry.open ?? expanded` is true, where `expanded` is the existing
  screen-wide ctrl+o flag; ctrl+o keeps flipping only that flag. A new
  `transcriptLineOwners(entries, options): readonly (number | undefined)[]` returns, for each line
  `layoutTranscript` produces with the same arguments, the index of the entry that drew it
  (`undefined` for separator lines). A left-button press and release at the same cell (a click, not
  a drag) on the FIRST line of a thinking, tool or skill entry replaces that entry with
  `{ ...entry, open: !(entry.open ?? expanded) }`. A click elsewhere does nothing new; drag-select
  and copy are unchanged.
- **Switch notices.** `ChatApp` remembers the last `(sessionId, model, mode)` it drew. When the
  session id is unchanged and the model differs it appends `{ kind: "notice", text: "model: <model
  after the last slash>" }`; when the mode differs it appends `mode: <full|guarded>`. A session id
  change appends neither (chat-resume-sessions rebuilds the transcript then).
- **Live token estimate.** `TurnStatus` gains `streamedChars: number`, the characters of
  `text_delta` and `thinking_delta` text since the last `usage` event of the turn; `turn_start` and
  every `usage` event reset it to 0. The working line's tokens part is `↑ <in> ↓ <out> tokens` once
  any usage event arrived in the turn, plus ` (+~<estimate>)` after `<out>` while `streamedChars >
  0`; before the first usage event it is `↓ ~<estimate> tokens` alone. `<estimate>` is
  `ceil(streamedChars / 4)` formatted with the existing `formatTokens`.
- **Welcome and viewport.** `welcomeLines` drops its `✻ nax chat` title line and the empty line after
  it, keeping the counts line and the tips line. `TranscriptViewport` pads blank rows BELOW the
  visible lines when the transcript is shorter than the window; scrolling, follow and the unseen
  marker are unchanged.
- **Slash menu.** Every drawn row pads `/name` to the widest drawn name plus the existing two-space
  gap, so descriptions start in one column. When matches exist beyond the drawn window, the menu's
  last row becomes the muted row `  … <k> more` (`k` = matches not drawn) and one fewer item row is
  drawn; the menu's total row count, which `ChatApp` budgets, is unchanged.

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
  - Baseline: a stored skill envelope replays as `{ kind: "user", text: "/<name> <args>" }`.
  - Target: it replays as the `skill` entry `parseSkillInvocation` yields.
- `useMouseSelection` — Target accepts an `onClick?(point)` called on a press and release at the
  same point, after the existing no-copy return.
- `TurnStatus` / `reduceTurnStatus` / `workingLine` (`chat-status.ts`) — Target adds
  `streamedChars` and the estimate rule above.
- `welcomeLines` (`layout-status.ts`) — Target drops the title line and its blank line.
- `TranscriptViewport` — Target pads below.
- `slashMenuLayout` (`SlashMenu.tsx`) — Target aligns names and adds the `… <k> more` row.

New: `packages/nax/src/chat/skill-invocation.ts` (`parseSkillInvocation`), re-exported from the
chat barrel; `transcriptLineOwners` exported from `layout.ts`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| a user message starts with `<skill name="` but has no closing quote or no `</skill>` | `parseSkillInvocation` returns `undefined`; live send keeps the user entry, replay keeps the user entry with the raw text |
| a click lands on a separator line or outside the transcript | nothing changes |
| a click lands on a line of an entry that is not thinking, tool or skill | nothing changes |
| `streamedChars` is 0 and no usage arrived | the tokens part is `↓ ~0 tokens` |

## Out of Scope

- A per-block keyboard toggle (moving a cursor between blocks); ctrl+o stays screen-wide.
- Collapsing long tool output beyond what tool cards already collapse.
- Persisting a block's open state across a resume; replayed blocks start collapsed.
- Changing how a catalog command turn is shown; only skill invocations collapse.
- A notice when the sandbox state changes.
- Exact token counting from a tokenizer; the estimate is characters divided by four.

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

Workdir: packages/nax. Depends on US-001.

`open?` on thinking, tool and skill entries, `transcriptLineOwners`, `onClick` in
`useMouseSelection`, and the toggle in `ChatApp`.

### US-004 — notices for model and mode changes

Workdir: packages/nax. No dependencies.

### US-005 — live output-token estimate on the working line

Workdir: packages/nax. No dependencies.

### US-006 — welcome card without the title, transcript anchored under the header

Workdir: packages/nax. No dependencies.

### US-007 — aligned slash menu with a more-matches row

Workdir: packages/nax. No dependencies.

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

**US-007**
- `packages/nax/src/tui/chat/SlashMenu.tsx`
- `packages/nax/src/tui/chat/slash-menu.ts`

### Creates

**US-001**
- `packages/nax/src/chat/skill-invocation.ts`
- `packages/nax/test/unit/chat/skill-invocation.test.ts`

### Modifies

**US-001**
- `packages/nax/src/chat/index.ts` — export `parseSkillInvocation` from the chat barrel so the TUI imports it through it.

**US-002**
- `packages/nax/test/unit/tui/chat/history-replay.test.ts` — the skill-envelope cases now expect a skill entry (name, args, body) instead of a user entry with the slash line.
- `packages/nax/test/ui/chat/slash-resources.test.tsx` — a skill turn's transcript row is now the collapsed skill block; assertions that the frame shows the skill body after a skill send now expect the collapsed row and the body only after ctrl+o.

**US-003**

None. The open override is optional and absent by default, so every existing layout and mouse-selection assertion keeps its result; new cases go into new tests.

**US-005**
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — working-line assertions for a running turn with no usage yet change from the up-and-down zero-token form to the estimate-only form; turn-status equality assertions gain the new streamed-characters field.

**US-006**
- `packages/nax/test/unit/tui/chat/layout-status.test.ts` — the welcome lines no longer start with the title line and its blank line; assertions on the welcome card's first lines change to the counts line.
- `packages/nax/test/unit/tui/chat/layout.test.ts` — the welcome entry's drawn lines lose the title line and its blank line.
- `packages/nax/test/ui/chat/transcript-viewport.test.tsx` — a transcript shorter than the window is now drawn from the top row with blank rows below it; assertions on the padded window's row order change accordingly.
- `packages/nax/test/ui/chat/chat-app-layout.test.tsx` — frames of a short transcript now show the welcome counts right under the header and blank rows below; row-position assertions change accordingly.

**US-007**
- `packages/nax/test/ui/chat/slash-menu.test.tsx` — rows now pad each name to the widest drawn name, so assertions on a row's exact text gain the padding; a list longer than the window now draws the more-matches row in place of its last item row.
- `packages/nax/test/unit/tui/chat/slash-menu.test.ts` — window cases where the matches exceed the rows now draw one fewer item row plus the more-matches row.

### Seams

- `parseSkillInvocation` (US-001) is consumed by `ChatApp` and `replayHistory` (US-002); US-002's ACs type a catalog skill in a mounted `ChatApp` and assert the frame shows the collapsed skill rows, and replay a stored envelope and assert a skill entry.
- `transcriptLineOwners` and `onClick` (US-003) are consumed by `ChatApp`; US-003's ACs send a mouse press and release through the mounted screen's mouse stream on a thinking block's first row and assert the frame toggles that block.

## Acceptance Criteria

### US-001 — parse skill invocations and draw a collapsed skill entry

- [unit] `parseSkillInvocation(buildSkillInvocationMessage({ skill, args: " plan it" }))` for a skill named `superpowers:brainstorming` with body `"line one\nline two"` returns `{ name: "superpowers:brainstorming", args: "plan it", body: "line one\nline two" }`.
- [unit] with `args: ""` it returns `args: ""`.
- [unit] a body that itself contains the line `</skill>` is returned whole, and `args` is the text after the last `</skill>\n\n`.
- [unit] `parseSkillInvocation("hello")` returns `undefined`.
- [unit] `parseSkillInvocation('<skill name="x" location="/p">\nbody')` (no closing `</skill>`) returns `undefined`.
- [unit] `layoutTranscript` with a skill entry `{ name: "s", args: "go", body: "a\nb\nc" }` and `expanded: false` draws exactly two lines: `> /s go` and a line reading `⎿ skill s · 3 lines (ctrl+o to show)` after the result gutter.
- [unit] the same entry with `args: ""` draws `> /s` as its first line.
- [unit] with `expanded: true` it draws the two header lines with `(ctrl+o to hide)` followed by `a`, `b` and `c`, each indented under the result row.
- [unit] a skill body line wider than the layout width wraps rather than being cut.

### US-002 — use skill entries for live sends and replay

- [integration] typing `/superpowers:brainstorming plan it` for a catalog skill in a mounted `ChatApp` draws `> /superpowers:brainstorming plan it` and the `⎿ skill superpowers:brainstorming · <n> lines (ctrl+o to show)` row, and the frame does not show the skill body.
- [integration] after that send, ctrl+o draws the skill body under the row.
- [integration] the host's `send` still receives the full invocation message as its first argument.
- [unit] `replayHistory` of a stored skill envelope returns `{ kind: "skill", name, args, body }` with the values `parseSkillInvocation` returns.
- [unit] `replayHistory` of a user message starting with `<skill name="` that `parseSkillInvocation` rejects returns a user entry with the raw content.
- [integration] a resumed session whose history holds a skill envelope shows the collapsed skill rows after the resume.

### US-003 — click a block's first row to toggle it

- [unit] `transcriptLineOwners` returns one value per line `layoutTranscript` returns for the same entries and options.
- [unit] for entries `[user, thinking]` it returns `0` for the user lines, `undefined` for the separator, and `1` for the thinking lines.
- [unit] `layoutTranscript` draws a thinking entry with `open: true` expanded while `expanded` is false.
- [unit] `layoutTranscript` draws a thinking entry with `open: false` collapsed while `expanded` is true.
- [unit] a tool entry and a skill entry follow the same `open ?? expanded` rule.
- [unit] `useMouseSelection` calls `onClick` with the transcript point for a left press and release at the same cell.
- [unit] a press, a drag to another cell and a release calls no `onClick` and still copies the selected text.
- [integration] in a mounted `ChatApp` with a finished thinking block, a left click on the block's first row draws the thought; a second click on that row collapses it.
- [integration] a click on a thinking block's first row expands only that block; another thinking block stays collapsed.
- [integration] after a click opened a block, ctrl+o and ctrl+o again leave that block expanded and toggle the others.
- [integration] a click on a reply line changes no entry.

### US-004 — notices for model and mode changes

- [integration] `/model p/other` in a mounted `ChatApp` whose fake host then reports `model: "p/other"` on the same session id appends the notice `model: other`.
- [integration] shift+tab that switches the host from `guarded` to `full` on the same session id appends `mode: full`.
- [integration] a `switchTo` that changes both model and mode appends both notices, model first.
- [integration] a resume that changes the session id appends neither notice.
- [integration] a `/model` naming the current model appends no notice.

### US-005 — live output-token estimate on the working line

- [unit] after `turn_start` and a `text_delta` of 40 characters, `reduceTurnStatus` yields `streamedChars: 40`.
- [unit] a `thinking_delta` adds its text length to `streamedChars`.
- [unit] a `usage` event resets `streamedChars` to 0 and adds its tokens as today.
- [unit] `turn_start` resets `streamedChars` to 0.
- [unit] a subagent-tagged `text_delta` leaves the status unchanged.
- [unit] `workingLine` for a running turn with no usage and `streamedChars: 40` shows `↓ ~10 tokens` and no `↑`.
- [unit] `workingLine` with no usage and `streamedChars: 0` shows `↓ ~0 tokens`.
- [unit] `workingLine` after one usage event with `inputTokens: 1200`, `outputTokens: 300` and `streamedChars: 0` shows `↑ 1.2k ↓ 300 tokens`.
- [unit] the same with `streamedChars: 400` shows `↑ 1.2k ↓ 300 (+~100) tokens`.

### US-006 — welcome card without the title, transcript anchored under the header

- [unit] `welcomeLines` draws the counts line first and the tips line second, with no `nax chat` title line.
- [integration] a mounted `ChatApp` at 120x36 with only the welcome entry draws the counts line on the row right after the header rule.
- [integration] `TranscriptViewport` with 3 lines in a 10-row window draws the 3 lines on rows 1-3 and blank rows on rows 4-10.
- [integration] `TranscriptViewport` with more lines than the window still follows the last line and shows the unseen marker as before.

### US-007 — aligned slash menu with a more-matches row

- [unit] `slashMenuLayout` for `/help` and `/sessions` draws both descriptions starting at the same column.
- [unit] the description column is the widest drawn name plus two spaces.
- [unit] with 12 matches and `maxRows: 5` and the pointer on the first match, the layout draws 4 item rows and a fifth row reading `… 8 more`, and `rows` is 5.
- [unit] with 5 matches and `maxRows: 5`, it draws 5 item rows and no more-matches row.
- [unit] with 12 matches, `maxRows: 5` and the pointer on the last match, the pointer's row is drawn and the more-matches row counts only the matches not drawn.
- [integration] typing `/s` in a mounted `ChatApp` with more matching commands and skills than the menu's rows shows the more-matches row.

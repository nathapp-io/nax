# SPEC: chat-tui-redesign — a full-screen, Claude Code style `nax chat` screen

## Summary

`nax chat` (F1 to F5b) works, but its screen is plain text: every transcript row is a
bare ink `<Text>`, the prompt is `> value`, an approval is three text lines and
`a | s | d`, and the status line is one `|`-joined string. This feature replaces the
presentation with a full-screen layout like Claude Code and Codex CLI (both verified on
the terminal's alternate screen by a tmux probe on 2026-10-26): a fixed header at the
top, a scrolling transcript viewport, a live working line, an input between two
full-width rules, and a one-line footer, all inside the alternate screen, with a short
exit summary printed to the normal screen on quit. The transcript gets styled items
(your message, reply text rendered from markdown with syntax-highlighted code blocks,
tool cards with one-line results, Edit diffs, collapsed Bash output, nested subagent
calls, notices, warnings, errors). Approvals and questions become framed cards driven by
arrow keys; `/` opens a filtered command menu; `/model`, `/resume` and `/mode` with no
argument open pickers. Every colour comes from one theme module with light-terminal,
16-colour, `NO_COLOR` and ASCII fallbacks.

The behaviour of sessions, modes, approvals, skills, MCP and subagents does not change.
Two small host additions feed the screen: the current model's context window (for the
footer's context meter) and a tag on forwarded subagent tool events (for nesting).

Design source: `docs/superpowers/specs/2026-10-26-nax-chat-tui-ux-design.md`; mockups:
https://claude.ai/artifact/Uur8RzjmHLwww4S4CcfVpS.

## Motivation

The user (2026-10-26) on the current screen: "is really pure text ... make it look like
Claude Code or codex", and, after a probe proved both run full screen, "it should keep
full same to claude code and codex". The slice 1 acceptance test (brainstorm and
spec-review the slice 2 design inside `nax chat`) waits on this redesign.

What the code shows on `main` `492527891`:

- `packages/nax/src/tui/chat/Transcript.tsx` renders `TranscriptEntry` rows
  (`message | text | thinking | tool`) as one `<Text>` each, and re-renders every row on
  every streamed delta.
- `InputBox.tsx` appends and backspaces only: no cursor, no history, no paste handling.
- `AskPrompt.tsx` shows `a: allow once | s: allow for this session | d: deny`.
- `ChatStatusLine.tsx` prints `model | mode | id8 | $cost | sandbox x`.
- `renderChat` (`tui/chat/index.ts`) renders inline; nothing enters the alternate screen.

## Design

### Approach

All new presentation code lives under `packages/nax/src/tui/chat/` as pure model
functions (testable without ink) plus thin ink components that render their output.
New modules are added beside the old components; US-020 to US-027 switch `ChatApp` over;
US-028 deletes the old components.

1. **Theme and styled lines (US-001 theme, US-002 styled lines).** `theme.ts` resolves one `ChatTheme` from the
   environment and the chalk colour level. `styled-line.tsx` defines the one rendering
   primitive every model produces: a `StyledLine` is an array of `Span`s; `StyledLineView`
   renders one line with the theme's colours.

   ```ts
   export type ChatColorToken =
     | "accent" | "muted" | "success" | "warning" | "danger"
     | "diffAdd" | "diffRemove" | "userBand" | "border" | "borderFocus"
     | "syntaxKeyword" | "syntaxString" | "syntaxComment" | "syntaxNumber" | "syntaxTitle";
   export interface ChatGlyphs {
     readonly bullet: string; readonly result: string; readonly pointer: string;
     readonly modeGuarded: string; readonly modeFull: string; readonly notice: string;
     readonly warning: string; readonly error: string; readonly thinking: string;
     readonly ellipsis: string; readonly rule: string;
     readonly codeTop: string; readonly codeSide: string; readonly codeBottom: string;
     readonly spinner: readonly string[];
   }
   export interface ChatTheme {
     readonly color: boolean;
     readonly background: "dark" | "light";
     /** Ink colour strings; undefined = terminal default (and no background for bg tokens). */
     readonly colors: Readonly<Record<ChatColorToken, string | undefined>>;
     readonly glyphs: ChatGlyphs;
   }
   export function resolveChatTheme(input: {
     env: Readonly<Record<string, string | undefined>>;
     colorLevel: 0 | 1 | 2 | 3;
   }): ChatTheme;

   export interface Span {
     readonly text: string;
     readonly color?: ChatColorToken;
     readonly background?: ChatColorToken;
     readonly bold?: boolean;
     readonly italic?: boolean;
   }
   export type StyledLine = readonly Span[];
   export function plainText(line: StyledLine): string;
   /** Terminal display columns (Bun.stringWidth): CJK and emoji count 2. */
   export function displayWidth(text: string): number;
   /** Strips ANSI/OSC escape sequences, C0 controls except "\n", and DEL (0x7f); a tab becomes two spaces. */
   export function sanitizeText(text: string): string;
   export const MIN_LAYOUT_WIDTH = 10;
   ```

   Every width, wrap and truncation in the models below is measured with
   `displayWidth`, and a `width` below `MIN_LAYOUT_WIDTH` is treated as
   `MIN_LAYOUT_WIDTH`. Every text that comes from the session, a tool, an MCP server or
   the host (reply, thinking, preview, tool input, notices, listings) passes through
   `sanitizeText` before it becomes span text, so a tool preview containing
   `\x1b[?1049l` cannot leave the alternate screen.

   Colour table (levels 2 and 3 use the hex value; level 1 uses the named colour;
   level 0, `NO_COLOR` set to any non-empty value, or `TERM=dumb` gives every token
   `undefined` and `color: false`):

   | Token | Dark | Light | 16-colour |
   |---|---|---|---|
   | accent | `#2bb5a3` | `#0f7f71` | `cyan` |
   | muted | `#7d8f8c` | `#6b7b78` | `gray` |
   | success | `#4cc38a` | `#1f8a55` | `green` |
   | warning | `#e5b84a` | `#9a6b00` | `yellow` |
   | danger | `#f0625b` | `#c23a33` | `red` |
   | diffAdd | `#12352a` | `#d7f2e3` | undefined |
   | diffRemove | `#3d1a1c` | `#fadcdb` | undefined |
   | userBand | `#17221f` | `#eaf1ef` | undefined |
   | border | `#2a3a37` | `#c7d3d0` | `gray` |
   | borderFocus | `#2bb5a3` | `#0f7f71` | `cyan` |
   | syntaxKeyword | `#d19af2` | `#8a3fbf` | `magenta` |
   | syntaxString | `#9ccc8a` | `#2f7d32` | `green` |
   | syntaxComment | `#6f817e` | `#7a8a87` | `gray` |
   | syntaxNumber | `#e5a46c` | `#a65a14` | `yellow` |
   | syntaxTitle | `#7cc4f0` | `#1f6fae` | `blue` |

   `background` is `"light"` when `COLORFGBG` is set and its last `;`-separated field is
   `7` or `15`; otherwise `"dark"`. Glyphs are the Unicode set (`⏺ ⎿ ❯ ⏵ ⏵⏵ ※ ⚠ ✗ ✻ … ─ ┌ │ └`,
   spinner `· ✢ ✳ ✶ ✻ ✽`) unless `NAX_ASCII` is `"1"` or the first non-empty of
   `LC_ALL`, `LC_CTYPE`, `LANG` does not match `/utf-?8/i`; then the ASCII set
   (`* | > > >> - ! x * ... - + | +`, spinner `- \ | /`). With no locale variable set, the
   Unicode set is used.

2. **Host data (US-003).** `@/agents/catalog` gains `lookupContextWindow(provider, model)`
   beside `lookupPricing`, same fail-open contract (undefined on miss, load failure or
   throw). `ChatHostState` gains `contextWindow?: number`, resolved for the session model
   (`"<provider>/<model>"`, split at the first `/`; a model string without `/` gets no
   lookup and no `contextWindow`) when `start`, `resume` and `switchTo`
   complete, cached per model string; the host calls it through the exported
   `_chatHostDeps.lookupContextWindow` (default: the catalog function;
   `export const _chatHostDeps = { lookupContextWindow }` is a new object in
   `chat-host.ts`, distinct from the `ChatHostDeps` interface). Forwarded subagent `tool_call` / `tool_result`
   events (`subagent-runs.ts` `routeActivity`) gain
   `metadata.subagent = agent.qualifiedName` and `metadata.subagentTask = task`, merged
   over the event's own metadata.

3. **Transcript model (US-004).** `transcript-model.ts` holds the entry union and a pure
   reducer `reduceTranscript(entries, event)`. Entries are immutable; an update returns
   a new object for the changed entry only, so unchanged entries keep their identity
   (the layout cache in US-007 depends on this).

   ```ts
   export interface ToolChild {
     readonly callId: string; readonly name: string; readonly input: unknown;
     readonly status: "running" | "ok" | "error";
   }
   export type TranscriptEntry =
     | { kind: "welcome"; skills: number; commands: number; agents: number; mcpServers: number; mcpConnected: number }
     | { kind: "user"; text: string }
     | { kind: "reply"; turnId: string; text: string }
     | { kind: "thinking"; turnId: string; text: string; startedAt: string; endedAt?: string }
     | { kind: "tool"; turnId: string; callId: string; name: string; input: unknown;
         startedAt: string; status: "running" | "ok" | "error"; preview?: string;
         endedAt?: string; children: readonly ToolChild[] }
     | { kind: "notice"; text: string }
     | { kind: "warning"; text: string }
     | { kind: "error"; text: string }
     | { kind: "listing"; title: string; text: string }
     | { kind: "interrupted" };
   export function reduceTranscript(entries: readonly TranscriptEntry[], event: SessionEvent): readonly TranscriptEntry[];
   ```

   Reducer rules: `text_delta` appends to the last entry when it is a `reply` of the same
   turn, else adds a `reply`. `thinking_delta` appends to the open (no `endedAt`)
   `thinking` entry of its turn, else adds one with `startedAt = event.at`. Any
   `text_delta`, `tool_call` or `turn_end` of a turn sets `endedAt = event.at` on that
   turn's open thinking entry. A `tool_call` whose `metadata.subagentTask` is set becomes
   a `ToolChild` of the most recent running `nax-agents__run` entry whose
   `input.task` equals it; with no such parent it is added as a top-level tool entry.
   `tool_result` updates the matching entry (or child) by `turnId` + `callId` (child:
   by `callId` within the parent) to `ok`/`error`, and on a top-level entry also sets
   `preview` and `endedAt`. `turn_end` with status `errored` and an `error` adds an
   `error` entry `"<code>: <message>"`; with status `cancelled` it adds `interrupted`.
   `compaction` adds the notice `conversation compacted`. Every other event returns the
   input array unchanged (same reference).

4. **Tool cards (US-005 identity, US-006 results).** `tool-card.ts`, pure:

   ```ts
   export interface CardLine { readonly text: string; readonly tone: "plain" | "muted" | "danger" }
   export interface DiffLine { readonly sign: "-" | "+" | " "; readonly text: string }
   export interface ToolCardModel {
     readonly title: string;
     readonly arg?: string;
     readonly tone: "running" | "success" | "danger";
     readonly summary: readonly CardLine[];
     readonly diff: readonly DiffLine[];
     /** Lines withheld while collapsed; 0 when expanded or nothing is withheld. */
     readonly hiddenLines: number;
   }
   export const TOOL_ARG_LIMIT = 60;
   export const BASH_PREVIEW_LINES = 3;
   export const DIFF_PREVIEW_LINES = 12;
   export const CHILD_PREVIEW_LINES = 3;
   export function toolTitle(name: string): string;
   export function toolCardModel(entry: Extract<TranscriptEntry, { kind: "tool" }>, options: { expanded: boolean }): ToolCardModel;
   export function diffLines(oldText: string, newText: string): readonly DiffLine[];
   ```

   - `toolTitle`: `nax-agents__run` -> `Agent`, `nax-skills__load` -> `Skill`, any other
     name unchanged.
   - `arg`: Read/Write/Edit/Delete -> `input.path`; Bash -> first line of
     `input.command`; Grep -> `"<pattern>"` plus `, <path>` when `input.path` is a string;
     Glob -> `input.pattern`; Git -> `input.subcommand`; Agent -> `<agent>: <task>`;
     Skill -> `input.name`; any other tool, or a missing/non-string field -> undefined.
     Longer than `TOOL_ARG_LIMIT` characters -> the first `TOOL_ARG_LIMIT` characters
     plus the theme-independent `…`. Line breaks in the value become spaces.
   - `tone`: `running` while running, `success` on ok, `danger` on error.
   - `summary` while running: empty, except Agent, whose summary is its children as
     muted `Title(arg)` lines, the last `CHILD_PREVIEW_LINES` only, preceded by a muted
     `+N more tool uses` line when more exist.
   - `summary` on error: the first non-empty preview line, tone `danger` (`"failed"`
     when the preview is empty or absent).
   - `summary` on ok: Edit -> `Updated <path> (+a -r)` where a and r are the line counts
     of `new_string` and `old_string`; Write -> `Wrote <n> lines to <path>` (n = line
     count of `input.content`, a trailing newline not counted); Read -> `Read <k> lines`
     (k = preview line count) with `+` after k when the preview is at least 4096 bytes (UTF-8)
     long (the nax-agent preview cap); Bash -> the preview lines, the first
     `BASH_PREVIEW_LINES` while collapsed with the rest counted in `hiddenLines`;
     Agent -> `Done (<n> tool uses · <s>s)` (n = children, s = whole seconds from
     `startedAt` to `endedAt`); any other tool -> its first non-empty preview line, or
     `Done` for an empty preview. Ok summaries are muted except Bash preview lines,
     which are plain.
   - Line counts: a string's line count is the number of `\n`-separated lines after one
     trailing `\n` is removed; an empty string has 0 lines.
   - `diff`: only an ok Edit has one: `diffLines(old_string, new_string)`, the first
     `DIFF_PREVIEW_LINES` lines while collapsed (rest in `hiddenLines`).
   - `diffLines`: lines common to the start of both texts and lines common to the end
     become `" "` lines; the remaining old lines become `"-"` lines followed by the
     remaining new lines as `"+"` lines.
   - Expanded: no line limits; an ok Agent also lists every child after its summary.

5. **Markdown (US-007 inline and blocks, US-008 code).** `markdown.ts`:
   `renderMarkdown(text, { width, theme }): readonly StyledLine[]`. Parsing uses a
   maintained markdown lexer and highlighting a maintained highlighter (proposal: the
   `marked` lexer and the `highlight.js` core build with a registered language set;
   both are added to `packages/nax/package.json` before the run, see Out of Scope;
   registered languages: typescript, javascript, json, bash, python, go, rust, yaml,
   diff, markdown, sql, css, xml, with aliases ts, js, sh, zsh, shell, py, yml, html).
   Rendering: headings bold (no `#`); paragraphs word-wrapped to `width`; `**strong**`
   bold; `*em*` italic; inline code in `accent`; unordered items `- ` (ordered `1. ` in
   `accent`), nested lists indented two columns per level; blockquotes prefixed by a
   muted `codeSide` glyph and a space, italic; a horizontal rule is a muted line of the
   `rule` glyph `width` long; a link renders its text followed by a muted ` (<href>)`;
   fenced code renders a muted `codeTop` line with the language name, each code line
   prefixed by a muted `codeSide` and a space, then a muted `codeBottom` line; code lines
   are not wrapped. A fence with a known language colours tokens by class: keywords and
   built-ins `syntaxKeyword`, strings `syntaxString`, comments `syntaxComment`, numbers
   and literals `syntaxNumber`, function and class titles `syntaxTitle`. Unknown or
   missing language: plain code lines. Tables and raw HTML render as their source text.
   An unclosed fence (mid-stream) renders as code to the end of the text. The
   highlighter call goes through the exported `_markdownDeps.highlight` so a test can
   make it throw.

6. **Layout (US-009 messages, US-010 tool cards and cache, US-011 status and listing entries).** `layout.ts`:
   `layoutTranscript(entries, { width, theme, expanded }): readonly StyledLine[]`, the
   concatenation of each entry's lines with one empty line between entries. Per entry:
   - `welcome` (counts from `host.catalog` skills, commands and agents lengths,
     `host.mcp.servers.length`, and connected = servers whose last `host.mcp.events()`
     entry for their id has kind `connected`; 0 when absent): `✻ nax chat` (thinking glyph + text, accent, bold), an empty line, a
     muted counts line `skills <s> · commands <c> · mcp <m> (<k> connected) · agents <a>`,
     and a muted tips line `/feature <name> loads a spec · /resume picks a session ·
     /help lists commands`.
   - `user`: each line of the text prefixed by `> ` (accent) the first and two spaces the
     rest, every span with background `userBand`.
   - `reply`: `renderMarkdown` at `width - 2`, the first line prefixed by the bullet
     glyph and a space, the rest by two spaces.
   - `thinking` without `endedAt`: no lines. With `endedAt`, collapsed: one muted italic
     line `✻ Thought for <s>s (ctrl+o to show)`; expanded: that line with
     `(ctrl+o to hide)` and then the thinking text, muted italic, indented two columns.
   - `tool`: the line `<bullet> <title>(<arg>)` (`<title>` alone when `arg` is undefined),
     the bullet coloured `muted`/`success`/`danger` by tone and the arg bold; then the
     summary lines, the first prefixed `  ⎿  ` (result glyph) and the rest five spaces,
     coloured by tone; then the diff lines prefixed five spaces, `-` lines with
     background `diffRemove`, `+` lines with background `diffAdd` (on a theme whose
     backgrounds are undefined, `-` lines are coloured `danger` and `+` lines `success`);
     then, when `hiddenLines > 0`, a muted line `     … +<n> lines (ctrl+o to expand)`.
   - `notice`: `※ <text>` muted; `warning`: `⚠ <text>` warning; `error`: `✗ <text>`
     danger; `interrupted`: `  ⎿  Interrupted by user` muted.
   - `listing`: the title bold, then each text line, coloured by `listingTone(line)`:
     a line containing `not locked` or `not connected` -> `warning`; containing
     `failed` -> `danger`; containing `connected` -> `success`; else plain.
   - Lines longer than `width` are wrapped at word boundaries, continuation lines
     keeping the entry's indent; a single word longer than the available width is cut
     at that width; a code line longer than `width` is cut at `width`.
   - Durations and countdowns from timestamps that do not parse (fixtures use
     `at: "now"`) count as 0 seconds.
   - Caching: the lines of one entry object are computed once per `(width, expanded)`
     pair; a later call with the same entry object, width and expanded reuses them
     (`_layoutDeps.layoutEntry` is the injectable per-entry function).

7. **Viewport (US-012 reducer, US-013 component).** `viewport.ts`, pure:

   ```ts
   export interface ViewportState { readonly offset: number; readonly follow: boolean; readonly unseen: number }
   export type ViewportAction =
     | { type: "content"; total: number; height: number }
     | { type: "pageUp" } | { type: "pageDown" } | { type: "lineUp" } | { type: "lineDown" }
     | { type: "home" } | { type: "end" };
   export const INITIAL_VIEWPORT: ViewportState; // { offset: 0, follow: true, unseen: 0 }
   export function reduceViewport(state: ViewportState, action: ViewportAction, total: number, height: number): ViewportState;
   export function visibleRange(total: number, height: number, offset: number): { start: number; end: number };
   ```

   `offset` counts lines between the bottom of the view and the last line. The
   reducer's `total` and `height` arguments are the values before the action; a
   `content` action carries the new ones. Growth (`action.total - total` when positive)
   while following keeps `offset` 0; while not following it adds the growth to both
   `offset` and `unseen`. After every action `offset` is re-clamped against the new
   total and height; a shrink (for example after `/clear`) never makes `unseen` grow. `pageUp`/`pageDown` move by
   `height - 1`, `lineUp`/`lineDown` by 1; `offset` is clamped to
   `[0, max(0, total - height)]`; any move to `offset > 0` sets `follow: false`; reaching
   `offset 0` sets `follow: true, unseen: 0`. `home` goes to the top, `end` to
   `INITIAL_VIEWPORT`. `TranscriptViewport` renders `height` rows: the visible lines,
   padded with empty rows at the top while `total < height`, and while `unseen > 0` the
   last row is replaced by the muted line `↓ <unseen> new lines (End)`. Keys, while its
   `active` prop is true: pageUp, pageDown, shift+upArrow (lineUp), shift+downArrow
   (lineDown), home, end.

8. **Line editor (US-014).** `line-editor.ts`, a pure reducer over
   `{ text: string; cursor: number }` (cursor = code-point index into `text`):

   ```ts
   export interface EditorState { readonly text: string; readonly cursor: number }
   export const EMPTY_EDITOR: EditorState;
   export type EditorKey = { input: string; key: Pick<Key, "return" | "backspace" | "delete" | "leftArrow" | "rightArrow" | "ctrl" | "meta" | "shift" | "escape" | "tab" | "upArrow" | "downArrow"> };
   export type EditorResult = { kind: "edit"; state: EditorState } | { kind: "submit"; text: string } | { kind: "ignored" };
   export function editLine(state: EditorState, input: EditorKey): EditorResult;
   export function cursorRow(state: EditorState): { row: number; rows: number };
   ```

   Keys: printable input inserts at the cursor (a multi-character chunk, a paste, is
   inserted whole, `\r\n` and `\r` normalised to `\n`); backspace and `key.delete` both
   delete before the cursor (ink 6.7 reports the Backspace key's `\x7f` as `delete` and
   cannot tell it from forward-delete); left/right move one code point;
   ctrl+a / ctrl+e move to the start / end of the current line; meta+left / meta+right
   move to the previous / next word boundary; ctrl+u deletes from the line start to the
   cursor; ctrl+k deletes from the cursor to the line end; ctrl+w deletes the word before
   the cursor; return with meta or shift inserts `\n`; return when the character before
   the cursor is `\` replaces that `\` with `\n`; any other return is `submit` with the
   text (not trimmed); ctrl, escape, tab, up and down are `ignored` (the input component
   owns them).

9. **Input (US-015).** `ChatInput` is controlled: its owner keeps an `InputDraft`
   (`{ editor: EditorState; history: readonly string[]; browse?: { index: number; saved: EditorState } }`,
   with `EMPTY_DRAFT`, both exported from `ChatInput.tsx`) and passes `draft` and
   `onDraftChange`, so unmounting the input while an ask card or a picker is shown loses
   neither the text nor the history. `ChatInput.tsx` also exports `DOUBLE_ESCAPE_MS` and
   `_chatInputDeps`. Props: `{ draft: InputDraft; onDraftChange(d: InputDraft): void;
   onSubmit(text: string): void; width: number; theme: ChatTheme; active?: boolean;
   busy?: boolean; hint?: string; yieldNavigation?: boolean; onClearArmedChange?(armed: boolean): void }`.
   With `yieldNavigation` true (the slash menu is open) it ignores up, down, return,
   tab and escape so the menu owns them. It renders the editor between two full-width rule
   lines (the `rule` glyph repeated `width` times, coloured `borderFocus` while active,
   `border` otherwise), the first text row prefixed `> ` (accent), further rows by two
   spaces, the cursor cell shown in inverse. At most 8 text rows are shown; with more,
   the 8-row window follows the cursor row. Empty and idle: a muted placeholder
   `Try "explain how nax run picks a model" · / for commands` (or the `hint` prop when
   given). History: submitted texts are kept in memory for the component's life; up on
   the first row recalls the previous entry, down on the last row the next, and moving
   past the newest restores the draft that was there before browsing. Busy: return
   submits only when the text starts with `/` (today's rule); otherwise the text stays.
   Escape on a non-empty idle input arms a clear: a second escape within
   `DOUBLE_ESCAPE_MS` (2000, timed by the exported `_chatInputDeps.now`) empties it; the
   component reports the armed state through `onClearArmedChange(armed)`.

10. **Status (US-016 turn status, US-017 footer, US-018 working line and header).** `chat-status.ts`, pure:

    ```ts
    export type TurnPhase = "thinking" | "writing" | "tool" | "approval" | "compacting" | "retrying";
    export interface TurnStatus {
      readonly running: boolean; readonly startedAt?: string; readonly phase: TurnPhase;
      readonly toolName?: string; readonly inputTokens: number; readonly outputTokens: number;
      /** input + cacheRead + cacheWrite of the latest usage event; survives turn_end. */
      readonly contextTokens?: number;
    }
    export const IDLE_STATUS: TurnStatus;
    export function reduceTurnStatus(status: TurnStatus, event: SessionEvent): TurnStatus;
    export type FooterHint = "quit" | "clear" | "busy" | "expanded" | "idle";
    export function footerModel(input: { state: ChatHostState; status: TurnStatus; hint: FooterHint }): { left: StyledLine; right: StyledLine };
    export function workingLine(status: TurnStatus, nowMs: number, glyphs: ChatGlyphs): StyledLine | undefined;
    export function headerLines(input: { state: ChatHostState; version: string; cwd: string; home: string; width: number }): readonly StyledLine[];
    export function shortModel(model: string): string;
    export function formatTokens(n: number): string;
    ```

    - `reduceTurnStatus`: `turn_start` -> running, `startedAt = at`, phase `thinking`,
      token sums 0, `contextTokens` kept; `thinking_delta` -> `thinking`; `text_delta` ->
      `writing`; `tool_call` -> `tool` with `toolName`; `tool_result` -> `thinking`;
      `approval_requested` without `answerable: false` -> `approval`;
      `approval_resolved` -> `thinking`; `compaction` -> `compacting`; `stream_reset` ->
      `retrying`; `usage` adds `inputTokens`/`outputTokens` and sets `contextTokens`;
      `turn_end` -> not running. Events whose `metadata.subagentTask` is set leave the
      status unchanged.
    - `footerModel` left: guarded -> `⏵ guarded` muted; full -> `⏵⏵ full` danger; then a
      muted ` · ` and the hint text: `quit` -> `press ctrl-c again to quit` (warning; it replaces
      the whole left side, mode and sandbox suffix included); `clear` -> `esc again to clear`; `busy` ->
      `esc to interrupt`; `expanded` -> `ctrl+o to collapse`; `idle` ->
      `shift+tab to cycle`. Then ` · sandbox unavailable` (warning) when
      `state.sandbox.kind` is `unavailable`, ` · sandbox off` (muted) when `sandbox` is
      absent or its kind is `disabled`, nothing when `available`. Right: `shortModel(state.model)`, then
      ` · <p>% ctx` when both `state.contextWindow` and `status.contextTokens` are known
      (p = rounded percentage; `warning` above 70, `danger` above 90, else muted; a
      `contextWindow` of 0 or less counts as unknown), then
      ` · $<cost to 2 decimals>` from `state.meta.costUsd ?? 0`, muted.
    - `workingLine`: undefined when not running; else the spinner frame
      `glyphs.spinner[floor(elapsedMs / 120) % length]` (accent), a space, the verb
      (accent): `Thinking…`, `Writing…`, `Running <toolTitle(toolName)>…`,
      `Waiting for approval…`, `Compacting…`, `Retrying…`, then muted
      ` (<s>s · ↑ <in> ↓ <out> tokens · esc to interrupt)`.
    - `formatTokens`: below 1000 the integer; else one decimal and `k` (`1234` -> `1.2k`).
    - `shortModel`: the text after the last `/`; longer than 24 characters -> 23 characters
      and `…`.
    - `headerLines`: line 1 `✻ nax chat` (accent, bold) then muted
      ` v<version> · <shortModel> · <mode>`; line 2 two spaces, the cwd with the `home`
      prefix replaced by `~` (elided in the middle with `…` to fit `width - 20`), then
      muted ` · sandbox <on|off|unavailable>` (`available` -> on; `disabled` or absent -> off); line 3 a `border` rule `width` long.

11. **Full screen and exit summary (US-019).** `ENTER_ALT_SCREEN` and `LEAVE_ALT_SCREEN`
    live in `tui/chat/alt-screen.ts` and `formatChatExitSummary(state)` in
    `tui/chat/exit-summary.ts`, all exported from `@/tui/chat`. `renderChat` writes `ENTER_ALT_SCREEN`
    (`\x1b[?1049h\x1b[H`) through `_renderChatDeps.write` before rendering and
    `LEAVE_ALT_SCREEN` (`\x1b[?1049l`) exactly once when the returned instance is
    unmounted or the process emits `exit` (`_renderChatDeps.onExit` registers the guard;
    the returned remover is called after the first restore). After the shell
    exits on any path (`waitUntilExit` resolved, or the signal handler finished) and
    the shell is unmounted, `runShell` in `cli/chat.ts` reads `host.current()` (still
    readable after `close`) and writes `formatChatExitSummary(state)` once through
    `deps.writeOut`:

    ```
    ✻ nax chat session <sessionId> · $<cost to 2 decimals>
      resume with: nax chat --resume <sessionId>
    ```

    A `current()` that throws means no summary.

12. **Composition (US-020 layout and transcript, US-021 keys).** `ChatAppProps` becomes
    `{ host; theme?: ChatTheme; version?: string; cwd?: string; home?: string }`; absent
    values default to `resolveChatTheme({ env: {}, colorLevel: 0 })`, `NAX_VERSION`,
    `host.repoRoot` and `""`. `chatCommand` passes
    `resolveChatTheme({ env: process.env, colorLevel: chalk.level })`, `NAX_VERSION`, the
    launch `cwd` and `homedir()` through `renderChat` (`_chatCommandDeps.renderChat`
    receives them). `ChatApp` owns the `InputDraft`. `ChatApp` renders a root column `rows` tall and `columns`
    wide (from `useStdout().stdout`; 24 and 80 when undefined; re-rendered on the
    stream's `resize` event): `headerLines` (3 rows), `TranscriptViewport` (all remaining
    rows), the working line (1 row, only while a turn runs; re-rendered every
    `WORKING_TICK_MS` = 250, exported from `chat-status.ts`, through a cancellable timer), the bottom region (one of: the
    ask card, a picker, or `ChatInput` with the slash menu under it), and the footer
    (1 row). Viewport height = `rows - 3 - workingRows - bottomRows - 1`, never below 1.
    Entries: the welcome entry at mount and after `/clear`; `user` entries for sent
    messages; `reduceTranscript` for session events; `notice`, `warning` and `error`
    entries replace today's `message` rows (resource notice, host notice -> notice;
    sandbox warning -> warning; thrown errors -> error). Text a slash command passes to
    `show` becomes a `listing` entry for `/help`, `/skills`, `/plugins`, `/mcp`,
    `/agents`, `/sessions` and `/cost` (titles `Commands`, `Skills`, `Plugins`,
    `MCP servers`, `Agents`, `Sessions`, `Cost`; one entry per command run, the
    `/sessions` rows joined with newlines) and a `notice` entry for every other command.
    Keys added: escape while a turn
    runs calls `host.cancel()` (ctrl-c is unchanged); ctrl+o toggles `expanded`; pageUp,
    pageDown, shift+up/down, home and end go to the viewport whenever no picker is open. `useChatKeys` gains `quitArmed(): boolean`, true while a ctrl-c that
    cancelled a turn is less than `DOUBLE_INTERRUPT_MS` old by `_chatKeyDeps.now()`,
    which the footer reads as the `quit` hint; the first ctrl-c calls `refresh()` and arms
    a cancellable timer of `DOUBLE_INTERRUPT_MS` that calls `refresh()` again;
    `finishTurn` disarms it. Every timer in this feature (working-line tick, countdown,
    quit arm) is a `setTimeout` chain cleared with `clearTimeout` on unmount, documented
    at the call site; `setInterval` is not used. The footer
    hint precedence is quit, clear, busy, expanded, idle. Mode cycling, ctrl-c and the
    busy rules are unchanged. State and handlers may move into hooks
    (`use-chat-transcript.ts` and the like) to keep `ChatApp.tsx` under the 600-line
    source limit.

    Key ownership (one owner per key and state; the first matching column wins):

    | Key | Ask card shown | Picker shown | Slash menu open | Otherwise |
    |---|---|---|---|---|
    | escape | the card (No) | the picker (cancel) | the menu (close) | turn running: `host.cancel()`; idle: the input's clear-arm |
    | return | the card (choose) | the picker (choose) | the menu (run selected) | the input |
    | up / down | the card (move) | the picker (move) | the menu (move) | the input (history) |
    | tab | nothing | nothing | the menu (complete) | nothing |
    | pageUp, pageDown, home, end, shift+up / down | the viewport | nothing | the viewport | the viewport |
    | ctrl+o | toggle expanded in every state | | | |
    | ctrl-c, shift+tab | `useChatKeys`, unchanged, in every state | | | |

    While an ask card is shown, escape never reaches `host.cancel()`.

13. **Ask cards (US-022 model, US-023 component).** `ask-card.ts` (pure) and `AskCard.tsx` replace
    `AskPrompt.tsx`. Approval card: a frame (`warning` border; `danger` when
    `unsandboxed`), a title, an empty line, the `command` (bold, when present) and the
    `summary` (muted) indented three columns, the `reason` line, then for Edit/Write the
    diff of the call (looked up by `callId` in the transcript's tool entries) as in the
    tool card, then the question and the options, then the countdown.
    - Title: Bash -> `Bash command`, Edit -> `Edit file`, Write -> `Write file`, Delete
      -> `Delete file`, a name starting `nax-agents__` -> `Agent`, any other name
      containing `__` -> `MCP tool <name>`, else the name; plus ` · outside the sandbox`
      when `unsandboxed`. A reason starting `[agent <name>] ` has that prefix removed
      from the reason and shown as a muted tag after the title.
    - Options: `1. Yes`, `2. Yes, and don't ask again for this in this session` (only
      when `controller.canRemember(ask)`), and the last
      `<n>. No, tell nax what to do instead (esc)`. Up/down move the selection, return
      chooses it, a number key chooses that option, escape chooses No; `a`, `s`
      (when remembering is allowed) and `d` keep resolving `allow_once`,
      `allow_session` and `deny`. Ctrl or meta letters do nothing (today's rule).
    - Choosing No resolves `deny` and sets the input's hint to
      `tell nax what to do instead` until the next submit.
    - Countdown: muted `expires in m:ss` from `expiresAt` minus now, re-rendered each
      second through a cancellable timer (`_askCardDeps.now`), `warning` below 60 s.
    - Question card: title `nax asks`, the question text, then a `ChatInput` inside the
      frame with its own `InputDraft`, starting from `EMPTY_DRAFT` for each `requestId`
      (never the chat input's draft); submit calls
      `controller.answerQuestion(requestId, text)`.

14. **Slash menu (US-024 model and help, US-025 component).** `slash-menu.ts` and `SlashMenu.tsx`. `COMMAND_DESCRIPTIONS`
    (in `slash-commands.ts`) gives every built-in a description: help `Show commands and
    skills`, mode `Switch permission mode`, model `Switch model`, sessions `List saved
    sessions`, resume `Resume a saved session`, clear `Clear the conversation`, cost
    `Show session cost`, feature `Load a feature spec into the conversation`, skills
    `List skills`, plugins `List plugins and what they provide`, mcp `List MCP servers`,
    agents `List agents`, quit `Quit nax chat`. Items: built-ins (in `COMMANDS` order),
    then catalog commands (`(command) <description>`), then skills
    (`(skill) <description>`). The menu is open while the input text starts with `/`,
    has no whitespace, and has not been closed with escape since its last change. The
    query is the text after `/`; matches (case-insensitive) are an item whose name
    equals the query first, then names starting with it, then names containing it
    elsewhere, each group keeping item order. Up/down move the selection (no wrap), tab replaces the input with
    `/<name> `, return submits `/<name>`, escape closes it. At most 8 rows; the window
    follows the selection. No match: the menu is not shown. `/help` lists
    `/<name>  <description>` for each built-in, then catalog commands and skills as today.

15. **Pickers (US-026 outcome and relative time, US-027 component).** `SlashOutcome` gains
    `{ kind: "picker"; picker: "model" | "resume" | "mode" }`, returned by `/model`,
    `/resume` and `/mode` with no argument (today they list models, resume the latest
    session, and print the mode). `Picker.tsx` replaces the input while open: a framed
    titled list (`Switch model`, `Resume a session`, `Permission mode`), the current
    choice marked `(current)`, up/down to move, return to choose, escape to cancel.
    Model rows are `host.models`; return calls `host.switchTo({ model })`. Mode rows are
    `guarded  asks before risky actions` and `full  never asks; runs outside the sandbox
    when it is unavailable`; return calls `host.switchTo({ mode })`. Resume rows come
    from `host.listSessions()` (a muted `loading…` row until it resolves; `no saved
    sessions` when empty): title (or `untitled <id8>`), `relativeTime(updatedAt, now)`,
    and `in use (pid <n>)` (warning) when `heldByPid` is set; return on an in-use row
    adds the warning `session <id> is in use by pid <n>` and keeps the picker open,
    otherwise calls `host.resume({ id })`. Choices run through `useChatKeys.runControl`.
    `relativeTime(iso, nowMs)` in `relative-time.ts`: under 60 s `just now`, under
    60 min `<m> min ago`, under 24 h `<h> h ago`, under 48 h `yesterday`, else
    `<Mon> <D>` (UTC); a null or unparsable `updatedAt` gives an empty string.

16. **Cleanup (US-028).** Delete `Transcript.tsx`, `ChatStatusLine.tsx` and
    `AskPrompt.tsx`, and `InputBox.tsx` if nothing imports it; the build/static gate
    verifies the removal.

### Integration (extends existing code)

Read-only (verified on `main` `492527891`):

- `ChatHost` (`packages/nax/src/chat/chat-host.ts`): `repoRoot`, `catalog`, `mcp`,
  `models`, `asks`, `current()`, `agents?()`, `start`, `clear`, `resume`, `notice`,
  `resourceNotice?`, `switchTo`, `send(message, onEvent)`, `runCommand?`, `cancel`,
  `listSessions(): Promise<readonly ChatSessionRow[]>` (`sessionId`, `title`,
  `updatedAt`, `heldByPid?`), `close`.
- `ChatAskController` (`chat/ask-controller.ts`): `pending()`, `resolve(id, choice)`,
  `canRemember(ask)`, `answerQuestion(id, text)`, `onChange(listener)`.
  `ChatPendingAsk` = the `approval_requested | question` `SessionEvent`s.
- `SessionEvent` (`@nathapp/nax-agent`): bodies `turn_start`, `text_delta`,
  `thinking_delta`, `stream_reset`, `tool_call { callId, name, input }`,
  `tool_result { callId, isError, preview }` (preview capped at 4096 bytes),
  `approval_requested { requestId, callId?, tool, summary, command?, reason, expiresAt,
  unsandboxed?, answerable? }`, `approval_resolved`, `question`, `usage { inputTokens,
  outputTokens, cacheRead?, cacheWrite?, costUsd }`, `compaction`, `turn_end { status,
  error? }`; base `sessionId`, `turnId`, `at`, `metadata`.
- `useChatKeys` (`tui/chat/useChatKeys.ts`): `locked`, `finishTurn`, `close`,
  `runControl`; ctrl-c and shift-tab handling stay as they are (US-021 adds the
  read-only `quitArmed()`).
- `parseSlashCommand`, `runSlashCommand(command, { host, show })`, `COMMANDS`
  (`tui/chat/slash-commands.ts`).
- `lookupPricing(provider, model)` and `loadCatalog` in `packages/nax/src/agents/catalog/index.ts`
  (fail-open pattern to mirror); nax-ai `ResolvedModel.contextWindow`.
- `NAX_VERSION` (`packages/nax/src/version.ts`).
- ink 6.7: `useInput` `Key` has `pageUp`, `pageDown`, `home`, `end`, `shift`, `meta`,
  `escape`; `useStdout()`.

Changed (the baseline exists only to locate the code; implement the target):

- `ChatHostState` — Baseline: `{ sessionId, mode, model, meta, sandbox? }`. Target: the
  same plus `readonly contextWindow?: number`.
- `routeActivity` in `chat/subagent-runs.ts` — Baseline: forwards nested `tool_call` /
  `tool_result` events unchanged. Target: forwards them with
  `metadata: { ...event.metadata, subagent: agent.qualifiedName, subagentTask: task }`.
- `renderChat` (`tui/chat/index.ts`) — Baseline: `render(createElement(ChatApp, props), { exitOnCtrlC: false })`.
  Target: enters the alternate screen first and returns an instance whose `unmount`
  leaves it once (Approach 11).
- `ChatCommandDeps` (`cli/chat.ts`) — Baseline: no stdout writer. Target: gains
  `writeOut(message: string): void` (default writes `message + "\n"` to stdout).
- `SlashOutcome` (`tui/chat/slash-commands.ts`) — Baseline: `send | command`. Target:
  `send | command | picker` (Approach 15).
- `ChatAppProps` — Baseline: `{ host }`. Target: `{ host; theme?; version?; cwd?; home? }` (Approach 12).
- `ChatApp` — Baseline: `Transcript`, `AskPrompt`, `InputBox`, `ChatStatusLine` in a
  column. Target: Approach 12.

### Failure Handling

| Failure | Behaviour |
|---|---|
| Catalog load fails or the model is missing | `lookupContextWindow` returns undefined; `contextWindow` is absent; the footer omits the ctx percentage. |
| Malformed markdown (unclosed emphasis, stray fences) | Rendered as the lexer tokenises it; never throws. |
| Highlighter throws for a fence | That fence renders as plain code lines. |
| `listSessions()` rejects in the resume picker | The picker closes and an `error` entry shows the message. |
| `switchTo` / `resume` from a picker rejects | An `error` entry shows the message; the input returns. |
| `host.current()` throws during exit | No exit summary is written. |
| Process exits without unmount (uncaught error) | The `exit` guard writes `LEAVE_ALT_SCREEN`. |
| Terminal smaller than the fixed regions | The viewport height is at least 1. |

## Out of Scope

- Adding the markdown lexer and highlighter packages (`marked`, `highlight.js`) to `packages/nax/package.json` and `bun.lock` is done on the feature branch before `nax run`; no story installs packages.
- Mouse support (wheel scrolling, click to select) is not added; the screen does not capture the mouse.
- Forward delete (deleting the character under the cursor) is not supported; ink 6.7 reports the Backspace key's `\x7f` and the forward-delete key as the same `delete` key, and both delete before the cursor.
- Searching the transcript and copying from scrolled-off output inside the app are not added; native terminal selection works on what is on screen.
- `@` file mentions and image paste are not added.
- Prompt history is not persisted across processes.
- Line numbers in Edit diffs are not shown; the Edit tool's input carries no start line.
- A per-model `contextWindow` override from config (`models` entries) is not applied to the footer; the catalog value is used.
- Subagent tokens are not shown on the Agent card; only tool-use count and duration, because nested usage is not forwarded to the transcript.
- Markdown tables are not formatted as aligned columns; they render as their source text.
- A Write approval or tool card does not show the written content as a diff.
- The run TUI (`nax run`), koda and the ACP server are not changed.
- No change to session, mode, approval, skill, MCP or subagent behaviour; only presentation and the two host additions.
- Updating `.nax/mono/packages/nax/context.md` for the new TUI modules and running `nax generate` is a manual step after merge; `.nax/` is read-only to the run.
- No release and no version bump.

## Stories

Paths below are repo-relative. Twenty-eight stories, one capability: the full-screen chat
screen (user ruling 2026-10-26: one feature, not three). The count comes from the 24-AC
cap counted as assertions: the design's fifteen pieces split along their natural seams
(pure model, then component). US-001 to US-019 add new modules beside the old components
and change nothing `nax chat` shows, except US-003's two additive host fields and
US-019's alternate screen; US-020 to US-027 switch `ChatApp` to them; US-028 deletes the
old components. Every story runs in `packages/nax`.

### US-001 — Theme tokens and glyphs

Workdir: packages/nax. No dependencies.

- Create `resolveChatTheme`, `ChatTheme`, `ChatGlyphs` and `ChatColorToken` in `theme.ts` (Design Approach 1).

### US-002 — Styled lines, display width and sanitising

Workdir: packages/nax. Depends on US-001.

- Create `Span`, `StyledLine`, `plainText`, `displayWidth`, `sanitizeText`, `MIN_LAYOUT_WIDTH` and `StyledLineView` in `styled-line.tsx` (Design Approach 1).

### US-003 — Host: context window and subagent event tags

Workdir: packages/nax. No dependencies.

- Add `lookupContextWindow` to `@/agents/catalog`, `contextWindow` to `ChatHostState` (through `_chatHostDeps.lookupContextWindow`), and the `subagent` / `subagentTask` metadata on forwarded nested tool events (Design Approach 2).

### US-004 — Transcript model

Workdir: packages/nax. Depends on US-003.

- Create `TranscriptEntry`, `ToolChild` and `reduceTranscript` in `transcript-model.ts` (Design Approach 3).

### US-005 — Tool card identity: title, argument, tone, running and error

Workdir: packages/nax. Depends on US-004.

- Create `tool-card.ts` with `toolTitle`, the limit constants, and `toolCardModel` for title, arg, tone, running summaries and error summaries (Design Approach 4).

### US-006 — Tool card results and collapsing

Workdir: packages/nax. Depends on US-005.

- Add `diffLines` and extend `toolCardModel` with the ok summaries, the Edit diff and the collapsed / expanded limits; cases go in the tool-card test file created by US-005 (Design Approach 4).

### US-007 — Markdown: inline styles and blocks

Workdir: packages/nax. Depends on US-001, US-002.

- Create `renderMarkdown` in `markdown.ts` for headings, paragraphs, emphasis, inline code, lists, blockquotes, rules and links (Design Approach 5).

### US-008 — Markdown: fenced code and highlighting

Workdir: packages/nax. Depends on US-007.

- Extend `renderMarkdown` with fenced code blocks and syntax highlighting through `_markdownDeps.highlight` (Design Approach 5).

### US-009 — Layout: message entries

Workdir: packages/nax. Depends on US-001, US-002, US-004, US-007.

- Create `layoutTranscript` in `layout.ts` for user, reply and thinking entries, entry spacing and wrapping (Design Approach 6).

### US-010 — Layout: tool cards, listings and the cache

Workdir: packages/nax. Depends on US-006, US-008, US-009.

- Extend `layoutTranscript` with tool cards, and cache per-entry lines through `_layoutDeps.layoutEntry`; cases go in the layout test file created by US-009 (Design Approach 6).

### US-011 — Layout: status and listing entries

Workdir: packages/nax. Depends on US-009.

- Extend `layoutTranscript` with welcome, notice, warning, error, interrupted and listing entries, and add `listingTone`; cases go in the layout test file created by US-009 (Design Approach 6).

### US-012 — Viewport reducer

Workdir: packages/nax. No dependencies.

- Create `reduceViewport`, `visibleRange` and `INITIAL_VIEWPORT` in `viewport.ts` (Design Approach 7).

### US-013 — Transcript viewport component

Workdir: packages/nax. Depends on US-001, US-002, US-012.

- Create `TranscriptViewport` in `TranscriptViewport.tsx` (Design Approach 7).

### US-014 — Line editor

Workdir: packages/nax. No dependencies.

- Create `editLine`, `cursorRow` and `EMPTY_EDITOR` in `line-editor.ts` (Design Approach 8).

### US-015 — Chat input

Workdir: packages/nax. Depends on US-001, US-002, US-014.

- Create `ChatInput`, `InputDraft`, `EMPTY_DRAFT`, `DOUBLE_ESCAPE_MS` and `_chatInputDeps` in `ChatInput.tsx` (Design Approach 9).

### US-016 — Turn status

Workdir: packages/nax. No dependencies.

- Create `chat-status.ts` with `TurnStatus`, `IDLE_STATUS`, `reduceTurnStatus`, `shortModel` and `formatTokens` (Design Approach 10).

### US-017 — Footer

Workdir: packages/nax. Depends on US-001, US-002, US-003, US-016.

- Add `footerModel` to `chat-status.ts` (Design Approach 10).

### US-018 — Working line and header

Workdir: packages/nax. Depends on US-001, US-002, US-005, US-016.

- Add `workingLine`, `headerLines` and `WORKING_TICK_MS` to `chat-status.ts` (Design Approach 10).

### US-019 — Alternate screen and exit summary

Workdir: packages/nax. No dependencies.

- Add `ENTER_ALT_SCREEN` / `LEAVE_ALT_SCREEN` (`alt-screen.ts`) and `formatChatExitSummary` (`exit-summary.ts`); make `renderChat` enter and leave the alternate screen; print the summary from `runShell` through the new `writeOut` dep (Design Approach 11).

### US-020 — Full-screen ChatApp: layout and transcript

Workdir: packages/nax. Depends on US-010, US-011, US-013, US-015, US-017, US-018, US-019.

- Rebuild `ChatApp` as the full-screen composition: header, viewport over `layoutTranscript`, working line, `ChatInput`, footer, welcome, notice / warning / error / listing entries, resize (Design Approach 12).

### US-021 — Full-screen ChatApp: keys

Workdir: packages/nax. Depends on US-020.

- Add escape-to-interrupt and ctrl+o to `ChatApp`, route viewport and input keys, and add `quitArmed()` to `useChatKeys` (Design Approach 12).

### US-022 — Ask card model

Workdir: packages/nax. Depends on US-006.

- Create `askCardModel` in `ask-card.ts` (Design Approach 13).

### US-023 — Ask card component

Workdir: packages/nax. Depends on US-015, US-021, US-022.

- Create `AskCard` in `AskCard.tsx` with `_askCardDeps`, and mount it in `ChatApp` in place of `AskPrompt` (Design Approach 13).

### US-024 — Slash menu model and help descriptions

Workdir: packages/nax. No dependencies.

- Export `COMMANDS` and add `COMMAND_DESCRIPTIONS` in `slash-commands.ts`, make `/help` list descriptions, and create `slashMenuItems` and `filterSlashMenu` in `slash-menu.ts` (Design Approach 14).

### US-025 — Slash menu component

Workdir: packages/nax. Depends on US-015, US-021, US-024.

- Create `SlashMenu` in `SlashMenu.tsx` and mount it under `ChatInput` in `ChatApp`, passing `yieldNavigation` to `ChatInput` while it is open (Design Approach 14).

### US-026 — Picker outcome and relative time

Workdir: packages/nax. No dependencies.

- Add the `picker` `SlashOutcome` for `/model`, `/resume` and `/mode` with no argument, narrow `ChatApp`'s outcome handling so a `picker` outcome is ignored until US-027 opens the picker, and create `relativeTime` in `relative-time.ts` (Design Approach 15).

### US-027 — Picker component

Workdir: packages/nax. Depends on US-015, US-021, US-026.

- Create `Picker` in `Picker.tsx` and open it from `ChatApp` on a `picker` outcome (Design Approach 15).

### US-028 — Remove the old chat components

Workdir: packages/nax. Depends on US-020, US-021, US-023, US-025, US-027.

- Delete `packages/nax/src/tui/chat/Transcript.tsx`, `ChatStatusLine.tsx` and `AskPrompt.tsx`, and `InputBox.tsx` when no module imports it (Design Approach 16). Verification: `bun run typecheck` and `bun run lint` in `packages/nax`; the removal is verified by the build/static gate, not by acceptance criteria.

### Context Files

**US-001**
- `packages/nax/src/tui/chat/ChatStatusLine.tsx`
- `packages/nax/src/tui/components/StatusBar.tsx`

**US-002**
- `packages/nax/src/tui/chat/theme.ts` — created by US-001

**US-003**
- `packages/nax/src/agents/catalog/index.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/subagent-runs.ts`
- `packages/nax/test/unit/chat/host-subagents.test.ts`

**US-004**
- `packages/nax/src/tui/chat/Transcript.tsx`
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax/src/chat/agents-provider.ts`

**US-005**
- `packages/nax/src/tui/chat/transcript-model.ts` — created by US-004
- `packages/nax/src/resources/skills-provider.ts`
- `packages/nax/src/tui/chat/Transcript.tsx`

**US-006**
- `packages/nax/test/unit/tui/chat/tool-card.test.ts` — created by US-005
- `packages/nax/src/tui/chat/tool-card.ts` — created by US-005
- `packages/nax-agent/src/tools/edit.ts`
- `packages/nax-agent/src/tools/write.ts`
- `packages/nax-agent/src/native/session/turn-event-emitter.ts`

**US-007**
- `packages/nax/src/tui/chat/theme.ts` — created by US-001
- `packages/nax/src/tui/chat/styled-line.tsx` — created by US-002

**US-008**
- `packages/nax/test/unit/tui/chat/markdown.test.ts` — created by US-007
- `packages/nax/src/tui/chat/markdown.ts` — created by US-007
- `packages/nax/src/tui/chat/theme.ts` — created by US-001

**US-009**
- `packages/nax/src/tui/chat/transcript-model.ts` — created by US-004
- `packages/nax/src/tui/chat/markdown.ts` — created by US-007
- `packages/nax/src/tui/chat/styled-line.tsx` — created by US-002

**US-010**
- `packages/nax/test/unit/tui/chat/layout.test.ts` — created by US-009
- `packages/nax/src/tui/chat/layout.ts` — created by US-009
- `packages/nax/src/tui/chat/tool-card.ts` — created by US-005
- `packages/nax/src/chat/chat-mcp-listing.ts`

**US-011**
- `packages/nax/src/tui/chat/layout.ts` — created by US-009
- `packages/nax/test/unit/tui/chat/layout.test.ts` — created by US-009
- `packages/nax/src/chat/chat-mcp-listing.ts`

**US-012**
None. A pure reducer with no collaborators.

**US-013**
- `packages/nax/src/tui/chat/viewport.ts` — created by US-012
- `packages/nax/src/tui/chat/styled-line.tsx` — created by US-002

**US-014**
- `packages/nax/src/tui/chat/InputBox.tsx`

**US-015**
- `packages/nax/src/tui/chat/line-editor.ts` — created by US-014
- `packages/nax/src/tui/chat/InputBox.tsx`
- `packages/nax/src/tui/chat/theme.ts` — created by US-001

**US-016**
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax/src/tui/chat/ChatStatusLine.tsx`

**US-017**
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — created by US-016
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/tui/chat/chat-status.ts` — created by US-016

**US-018**
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — created by US-016
- `packages/nax/src/tui/chat/chat-status.ts` — created by US-016
- `packages/nax/src/tui/chat/tool-card.ts` — created by US-005
- `packages/nax/src/version.ts`

**US-019**
- `packages/nax/src/tui/chat/index.ts`
- `packages/nax/src/cli/chat.ts`
- `packages/nax/test/unit/cli/chat.test.ts`

**US-020**
- `packages/nax/src/cli/chat.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/TranscriptViewport.tsx` — created by US-013
- `packages/nax/src/tui/chat/ChatInput.tsx` — created by US-015
- `packages/nax/src/tui/chat/chat-status.ts` — created by US-016

**US-021**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/useChatKeys.ts`
- `packages/nax/test/ui/chat/chat-asks-keys.test.tsx`

**US-022**
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/src/tui/chat/AskPrompt.tsx`
- `packages/nax/src/tui/chat/tool-card.ts` — created by US-005

**US-023**
- `packages/nax/src/tui/chat/ask-card.ts` — created by US-022
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/test/ui/chat/chat-asks-keys.test.tsx`

**US-024**
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/resources/catalog.ts`
- `packages/nax/test/ui/chat/slash-commands.test.tsx`

**US-025**
- `packages/nax/src/tui/chat/slash-menu.ts` — created by US-024
- `packages/nax/test/ui/chat/chat-shell-lines.test.tsx`
- `packages/nax/src/tui/chat/ChatInput.tsx` — created by US-015
- `packages/nax/src/tui/chat/ChatApp.tsx`

**US-026**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/test/ui/chat/slash-commands.test.tsx`

**US-027**
- `packages/nax/src/tui/chat/relative-time.ts` — created by US-026
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/useChatKeys.ts`

**US-028**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/index.ts`

### Creates

**US-001**
- `packages/nax/src/tui/chat/theme.ts`
- `packages/nax/test/unit/tui/chat/theme.test.ts`

**US-002**
- `packages/nax/src/tui/chat/styled-line.tsx`
- `packages/nax/test/ui/chat/styled-line.test.tsx`

**US-003**
- `packages/nax/test/unit/agents/catalog/context-window.test.ts`
- `packages/nax/test/unit/chat/chat-host-context-window.test.ts`

**US-004**
- `packages/nax/src/tui/chat/transcript-model.ts`
- `packages/nax/test/unit/tui/chat/transcript-model.test.ts`

**US-005**
- `packages/nax/src/tui/chat/tool-card.ts`
- `packages/nax/test/unit/tui/chat/tool-card.test.ts`

**US-006**
None. New cases go in the tool-card test file created by US-005.

**US-007**
- `packages/nax/src/tui/chat/markdown.ts`
- `packages/nax/test/unit/tui/chat/markdown.test.ts`

**US-008**
None. New cases go in the markdown test file created by US-007.

**US-009**
- `packages/nax/src/tui/chat/layout.ts`
- `packages/nax/test/unit/tui/chat/layout.test.ts`

**US-010**
None. New cases go in the layout test file created by US-009.

**US-011**
None. New cases go in the layout test file created by US-009.

**US-012**
- `packages/nax/src/tui/chat/viewport.ts`
- `packages/nax/test/unit/tui/chat/viewport.test.ts`

**US-013**
- `packages/nax/src/tui/chat/TranscriptViewport.tsx`
- `packages/nax/test/ui/chat/transcript-viewport.test.tsx`

**US-014**
- `packages/nax/src/tui/chat/line-editor.ts`
- `packages/nax/test/unit/tui/chat/line-editor.test.ts`

**US-015**
- `packages/nax/src/tui/chat/ChatInput.tsx`
- `packages/nax/test/ui/chat/chat-input.test.tsx`

**US-016**
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/test/unit/tui/chat/chat-status.test.ts`

**US-017**
None. New cases go in the chat-status test file created by US-016.

**US-018**
None. New cases go in the chat-status test file created by US-016.

**US-019**
- `packages/nax/src/tui/chat/alt-screen.ts`
- `packages/nax/src/tui/chat/exit-summary.ts`
- `packages/nax/test/ui/chat/index.test.tsx`
- `packages/nax/test/unit/tui/chat/exit-summary.test.ts`

**US-020**
- `packages/nax/test/ui/chat/chat-app-layout.test.tsx`

**US-021**
- `packages/nax/test/ui/chat/chat-app-keys.test.tsx`

**US-022**
- `packages/nax/src/tui/chat/ask-card.ts`
- `packages/nax/test/unit/tui/chat/ask-card.test.ts`

**US-023**
- `packages/nax/src/tui/chat/AskCard.tsx`
- `packages/nax/test/ui/chat/ask-card.test.tsx`

**US-024**
- `packages/nax/src/tui/chat/slash-menu.ts`
- `packages/nax/test/unit/tui/chat/slash-menu.test.ts`

**US-025**
- `packages/nax/src/tui/chat/SlashMenu.tsx`
- `packages/nax/test/ui/chat/slash-menu.test.tsx`

**US-026**
- `packages/nax/src/tui/chat/relative-time.ts`
- `packages/nax/test/unit/tui/chat/relative-time.test.ts`

**US-027**
- `packages/nax/src/tui/chat/Picker.tsx`
- `packages/nax/test/ui/chat/picker.test.tsx`

**US-028**
None. Deletions only.

### Modifies

**US-001**
None. New files only.

**US-002**
None. New files only.

**US-003**
- `packages/nax/test/unit/chat/host-subagents.test.ts` — the `toContainEqual(call)`, `toContainEqual(result)` and `toContainEqual(lateCall)` assertions on events forwarded through `host.send` (the forwarding, spend and late-call cases) change to find the forwarded event by `type` and `callId` and assert its `name` (or `isError`) equals the fixture's and its metadata carries `subagent` and `subagentTask`; the `not.toContainEqual(lateCall)` assertion changes the same way to assert no forwarded event has the late call's `callId`; the spend, ledger and text-delta assertions are unchanged.
- `packages/nax/test/unit/chat/subagent-runs.test.ts` — "forwards only tool_call and tool_result to the turn listener" asserts `toEqual([call, result])` on the forwarded events; with the new metadata tags it changes to assert the forwarded events' `type`, `callId` and `name` (or `isError`) equal those of `call` and `result`, and that each forwarded event's metadata carries `subagent` equal to the agent's qualified name and `subagentTask` equal to `check it`; that only those two event types are forwarded is unchanged.

**US-004**
None. New file only; `Transcript.tsx` and `appendChatEvent` stay until US-028.

**US-005**
None. New file only.

**US-006**
None. Extends a file created by US-005.

**US-007**
None. New file only.

**US-008**
None. Extends a file created by US-007.

**US-009**
None. New file only.

**US-010**
None. Extends a file created by US-009.

**US-011**
None. Extends a file created by US-009.

**US-012**
None. New file only.

**US-013**
None. New file only.

**US-014**
None. New file only.

**US-015**
None. New file only; `InputBox` keeps serving `AskPrompt` until US-023.

**US-016**
None. New file only.

**US-017**
None. Extends a file created by US-016.

**US-018**
None. Extends a file created by US-016.

**US-019**
- `packages/nax/test/ui/chat/chat-app.test.tsx` — "AC-1 renderChat renders with Ctrl-C exit disabled and unmounts" stubs `_renderChatDeps.write` and `_renderChatDeps.onExit` (restoring them after the test) so no escape sequence reaches the real stdout and no process `exit` listener is left behind; its render-options and unmount assertions are unchanged.
- `packages/nax/test/unit/cli/chat.test.ts` — the deps objects built for the composed-chat cases (including those that spread `_chatCommandDeps`) set `writeOut: mock(() => {})` so the summary is captured instead of printed and the deps still satisfy `ChatCommandDeps`; the shutdown-order assertions (close before unmount, signal exit codes 143 and 129) are unchanged.
- `packages/nax/test/unit/cli/chat-resources.test.ts` — the deps objects that spread `_chatCommandDeps` set `writeOut: mock(() => {})` so the summary is not printed to the test output; every resource assertion is unchanged.

**US-020**
- `packages/nax/test/unit/cli/chat.test.ts` — the assertion `toHaveBeenCalledWith({ host: f.host })` on `deps.renderChat` changes to `toHaveBeenCalledWith(expect.objectContaining({ host: f.host }))`, and the fixture's `renderChat` mock parameter type widens from `{ host }` to the props `renderChat` now receives; the start, mode and model assertions are unchanged.
- `packages/nax/test/ui/chat/chat-app.test.tsx` — the status-line assertions `toContain("test-model | guarded")` and `toContain("abcdefgh | $0.00")` change to the footer: the frame contains `⏵ guarded`, `test-model` and `$0.00`; the session id is no longer asserted because the footer does not show it. The tool-row assertions "Read src/a.ts [ok]" and `[error]` change to the card line "⏺ Read(src/a.ts)" once, the ok case showing a line starting `⎿` and the error case showing the error preview's first line. "shows Bash command" changes `toContain("Bash bun run build")` to `toContain("Bash(bun run build)")`. The thinking test changes from `thinking...` appearing once to `Thought for` appearing once, and its scripted events gain a `turn_end` after the `thinking_delta` so the thinking entry ends; the assertion that the thinking text `secret` is not shown is unchanged. The 60-character truncation `test.each` keeps Read, Write, Edit and Delete and changes its expectation to the card label: the tool name, `(`, `first ` and 54 `x` characters, then `…`, with the frame still not containing 55 `x` characters; Bash leaves that `test.each` and gets its own case asserting `Bash(first)` because a Bash card shows only the command's first line. Every notice, warning-count, error-text, draft, backspace and cost assertion is unchanged.
- `packages/nax/test/ui/chat/chat-asks-keys.test.tsx` — the four status assertions `toContain("model | guarded")` and `toContain("model | full")` change to the header's `model · guarded` and `model · full` (the header always shows the mode; the footer hides it while the quit hint shows); the ask, ctrl-c, shift-tab and close assertions are unchanged.

**US-021**
None. New keys only; ctrl-c, shift-tab and the ask letters keep their existing tests.

**US-022**
None. New file only.

**US-023**
- `packages/nax/test/ui/chat/chat-asks-keys.test.tsx` — the ask tests render through `ChatApp` with `AskCard` mounted instead of `AskPrompt`; the label assertions `toContain("s: allow for this session")` (present when remembering is allowed, absent when not) change to the option text `Yes, and don't ask again for this in this session`; `toContain("outside the sandbox")` is unchanged (now in the card title); every `resolve` call assertion for `a`, `s`, `d` and ctrl-letter keys is unchanged.

**US-024**
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the three help assertions (that the frame contains every name in COMMANDS, each prefixed with a slash and joined by newlines), "toContain('/plugins\n/mcp\n')" and "toContain('/mcp\n/agents\n/quit')" change to the same command order rendered as "/<name>  <description>" lines: every built-in's line in `COMMANDS` order, "/plugins  List plugins and what they provide" directly above "/mcp  List MCP servers", and the "/mcp", "/agents", "/quit" lines consecutive; every other routing assertion is unchanged.

**US-025**
None. The menu ranks an item whose name equals the typed query first, so return on a fully typed name (for example `/skill` with the built-in `skills` also matching) runs exactly that name, and existing slash tests that submit full lines (`chat-shell-lines.test.tsx`, `slash-commands.test.tsx`, `slash-resources.test.tsx`) keep sending what they typed; a US-025 AC pins the `/skill` case.

**US-026**
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — "AC-5 reports current mode in transcript" ("/mode" alone, expects `guarded\n` in the frame) changes to call `runSlashCommand` for "/mode" with no argument and assert the outcome `{ kind: "picker", picker: "mode" }` with `show` not called; "AC-8 lists all configured models" ("/model" alone) changes the same way to the outcome `{ kind: "picker", picker: "model" }`; the explicit-argument "/mode full", "/model <id>" and "/resume abc" assertions are unchanged.

**US-027**
None. New file and new `ChatApp` handling of an outcome kind no existing test produces through the app.

**US-028**
None. The deleted components have no direct test imports; tests reach them only through `ChatApp`, already moved by US-020 and US-023.

### Seams

UI seam ACs mount `ChatApp` with ink-testing-library over the typed fake `ChatHost` used
by `test/ui/chat/chat-app.test.tsx`, whose `send` replays scripted `SessionEvent`s
through `onEvent`. Tests set `columns` and `rows` on the ink-testing-library stdout
and emit `resize` (its stdout has a fixed `columns` of 100 and no `rows` until set). The production entry point for every TUI seam is the mounted
`ChatApp` (what `renderChat` renders); for the host seam it is `host.send`.

- US-001, US-002 -> US-007, US-009, US-013, US-015, US-017: `resolveChatTheme`, `StyledLine`, `StyledLineView`, `sanitizeText`; covered by US-020's mounted-app ACs, which render the header, transcript and footer through them.
- US-003 -> US-017, US-020: `ChatHostState.contextWindow`; US-020 asserts, by mounting `ChatApp` over a host whose `current()` returns `contextWindow: 200000` and a scripted turn emitting `usage` with 36000 input tokens, that the footer shows `18% ctx`.
- US-003 -> US-004, US-020: `metadata.subagentTask`; US-003 asserts through the host-subagents harness, entering at `host.send`, that the forwarded nested `tool_call` reaching the turn listener carries it; US-020 asserts through a scripted turn with a `nax-agents__run` call and a tagged nested `Read` call that the frame shows the `Read(` line indented under `⏺ Agent(`.
- US-004, US-005, US-006, US-007, US-008, US-009, US-010 -> US-020: `reduceTranscript`, `toolCardModel`, `renderMarkdown`, `layoutTranscript`; US-020 asserts through the mounted app that a scripted reply `**done**` renders `done` without asterisks, an ok Edit call renders `Updated`, and a fenced block renders the code side glyph.
- US-012, US-013 -> US-021: `reduceViewport`, `TranscriptViewport`; US-021 asserts that after a pageUp key the newest line is not in the frame and after an end key it is.
- US-014, US-015 -> US-021: `editLine`, `ChatInput`; US-021 asserts that typing `ab`, leftArrow, `X`, return calls `host.send` with `aXb`.
- US-016, US-017, US-018 -> US-020: `reduceTurnStatus`, `footerModel`, `workingLine`, `headerLines`; covered by US-020's header, footer and working-line ACs.
- US-019 -> `nax chat`: `formatChatExitSummary`, `writeOut`; US-019 asserts through `chatCommand` with stubbed deps that `writeOut` receives the summary after `unmount`.
- US-022 -> US-023: `askCardModel`; US-023 asserts through the mounted app that a pending Bash ask renders the card title `Bash command`.
- US-024 -> US-025: `slashMenuItems`, `filterSlashMenu`; US-025 asserts through the mounted app that typing `/` shows `/help` with its description.
- US-026 -> US-027: the `picker` outcome and `relativeTime`; US-027 asserts through the mounted app that `/resume` shows rows with relative times.

## Acceptance Criteria

### US-001 — Theme tokens and glyphs

- [unit] `resolveChatTheme({ env: {}, colorLevel: 3 })` returns `color: true` and `background: "dark"`.
- [unit] `resolveChatTheme({ env: {}, colorLevel: 3 })` returns `colors.accent` equal to `#2bb5a3`.
- [unit] `resolveChatTheme({ env: { COLORFGBG: "0;15" }, colorLevel: 3 })` returns `background: "light"` and `colors.accent` equal to `#0f7f71`.
- [unit] `resolveChatTheme({ env: { COLORFGBG: "15;0" }, colorLevel: 3 })` returns `background: "dark"`.
- [unit] `resolveChatTheme({ env: {}, colorLevel: 1 })` returns `colors.accent` equal to `cyan`.
- [unit] `resolveChatTheme({ env: {}, colorLevel: 1 })` returns `colors.diffAdd`, `colors.diffRemove` and `colors.userBand` all undefined.
- [unit] `resolveChatTheme({ env: {}, colorLevel: 0 })` returns `color: false` and every entry of `colors` undefined.
- [unit] `resolveChatTheme({ env: { NO_COLOR: "1" }, colorLevel: 3 })` returns `color: false` and every entry of `colors` undefined.
- [unit] `resolveChatTheme({ env: { NO_COLOR: "" }, colorLevel: 3 })` returns `color: true`.
- [unit] `resolveChatTheme({ env: { TERM: "dumb" }, colorLevel: 3 })` returns `color: false`.
- [unit] `resolveChatTheme({ env: {}, colorLevel: 3 })` returns `glyphs.bullet` equal to `⏺` and `glyphs.result` equal to `⎿`.
- [unit] `resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 3 })` returns `glyphs.bullet` equal to `*` and `glyphs.spinner` equal to `["-", "\\", "|", "/"]`.
- [unit] `resolveChatTheme({ env: { LANG: "C" }, colorLevel: 3 })` returns `glyphs.bullet` equal to `*`.
- [unit] `resolveChatTheme({ env: { LC_ALL: "en_US.UTF-8", LANG: "C" }, colorLevel: 3 })` returns `glyphs.bullet` equal to `⏺`.

### US-002 — Styled lines, display width and sanitising

- [unit] `plainText([{ text: "a" }, { text: "b", bold: true }])` returns `ab`.
- [unit] Rendering `StyledLineView` with the line `[{ text: "hi", color: "accent" }]` and a `colorLevel: 0` theme produces the frame text `hi`.
- [unit] Rendering `StyledLineView` with the line `[{ text: "x", background: "userBand" }]` and a theme whose `userBand` is undefined produces the frame text `x` without throwing.
- [unit] `displayWidth("ab")` returns 2.
- [unit] `displayWidth("日本")` returns 4.
- [unit] `sanitizeText("a\x1b[31mb\x1b[0m")` returns `ab`.
- [unit] `sanitizeText("x\x1b[?1049ly")` returns `xy`.
- [unit] `sanitizeText("a\x1b]0;title\x07b")` returns `ab`.
- [unit] `sanitizeText("a\tb")` returns `a  b`.
- [unit] `sanitizeText("a\rb\x07c\x7f")` returns `abc`.
- [unit] `sanitizeText("a\nb")` returns `a\nb`.

### US-003 — Host: context window and subagent event tags

- [unit] With `_catalogDeps.loadProviders` returning a catalog whose model `anthropic/m1` has `contextWindow: 200000`, `lookupContextWindow("anthropic", "m1")` resolves to `200000`.
- [unit] With that catalog, `lookupContextWindow("anthropic", "missing")` resolves to undefined.
- [unit] With `_catalogDeps.loadProviders` rejecting, `lookupContextWindow("anthropic", "m1")` resolves to undefined.
- [unit] With a catalog whose `model()` throws, `lookupContextWindow("anthropic", "m1")` resolves to undefined.
- [unit] A chat host built by `createChatHost` with `_chatHostDeps.lookupContextWindow` stubbed to return 200000, after `start({ mode: "guarded", model: "anthropic/m1" })`, returns `current().contextWindow` equal to `200000`.
- [unit] That host's stub was called with `("anthropic", "m1")`.
- [unit] With the stub returning undefined for `anthropic/m2`, `current().contextWindow` is undefined after `switchTo({ model: "anthropic/m2" })`.
- [unit] With the stub rejecting, `start` resolves and `current().contextWindow` is undefined.
- [unit] `start` on `anthropic/m1` followed by `switchTo({ mode: "full" })` on the same model calls the stub once.
- [unit] `start` on the model string `test-model` (no `/`) does not call the stub and leaves `current().contextWindow` undefined.
- [unit] Through the host-subagents harness, a `host.send` whose scripted chat turn runs `nax-agents__run` with task `scan` and whose nested session emits a `tool_call` named `Read` delivers to the turn listener a `tool_call` event with `metadata.subagentTask` equal to `scan`.
- [unit] In that run, the delivered nested `tool_call` event has `metadata.subagent` equal to the agent's qualified name.
- [unit] In that run, the delivered nested `tool_result` event has `metadata.subagentTask` equal to `scan`.
- [unit] In that run, a nested event whose own metadata has key `k` with value `v` is delivered with `metadata.k` equal to `v`.

### US-004 — Transcript model

- [unit] `reduceTranscript` over a `text_delta` of turn `t1` with text `Hel` and then one with `lo` yields one entry `{ kind: "reply", turnId: "t1", text: "Hello" }`.
- [unit] A `text_delta` of turn `t2` after a `reply` of turn `t1` adds a second `reply` entry.
- [unit] A `text_delta` of turn `t1` after a `tool` entry of turn `t1` adds a new `reply` entry.
- [unit] Two `thinking_delta` events of turn `t1` with texts `a` and `b` yield one `thinking` entry with text `ab`.
- [unit] That thinking entry's `startedAt` equals the first event's `at`.
- [unit] A `tool_call` of turn `t1` after an open `thinking` entry of `t1` sets that entry's `endedAt` to the `tool_call` event's `at`.
- [unit] A `turn_end` of turn `t1` sets `endedAt` on that turn's open thinking entry.
- [unit] A `tool_call` with `callId: "c1"`, `name: "Read"` and `input: { path: "a.ts" }` adds a `tool` entry with `status: "running"` and empty `children`.
- [unit] That tool entry's `startedAt` equals the event's `at`.
- [unit] A `tool_result` with `callId: "c1"`, `isError: false` and `preview: "x"` on turn `t1` sets that entry's `status` to `ok` and `preview` to `x`.
- [unit] That `tool_result` sets the entry's `endedAt` to the event's `at`.
- [unit] A `tool_result` with `isError: true` sets the matching entry's `status` to `error`.
- [unit] A `tool_result` whose `callId` matches no entry returns the input array (same reference).
- [unit] After a running `nax-agents__run` entry with `input.task` `scan`, a `tool_call` named `Read` with `metadata.subagentTask: "scan"` adds no top-level entry.
- [unit] That call is appended to the agent entry's `children` as a `ToolChild` named `Read` with status `running`.
- [unit] A `tool_result` with `metadata.subagentTask: "scan"` and that child's `callId` sets the child's status to `ok`.
- [unit] A `tool_call` with `metadata.subagentTask: "other"` and no running `nax-agents__run` entry with that task is added as a top-level `tool` entry.
- [unit] A `turn_end` with status `errored` and error `{ code: "X", message: "broke" }` adds `{ kind: "error", text: "X: broke" }`.
- [unit] A `turn_end` with status `cancelled` adds `{ kind: "interrupted" }`.
- [unit] A `compaction` event adds `{ kind: "notice", text: "conversation compacted" }`.
- [unit] Appending a `text_delta` to the last reply leaves every earlier entry object identical (same reference) in the result.

### US-005 — Tool card identity: title, argument, tone, running and error

- [unit] `toolTitle("nax-agents__run")` returns `Agent`.
- [unit] `toolTitle("nax-skills__load")` returns `Skill`, and `toolTitle("Read")` returns `Read`.
- [unit] `toolCardModel` of a running `Read` entry with input `{ path: "src/a.ts" }` returns `title: "Read"` and `arg: "src/a.ts"`.
- [unit] That model has `tone: "running"` and an empty `summary`.
- [unit] For a `Bash` entry with input `{ command: "bun test\nexit" }`, `arg` is `bun test`.
- [unit] For a `Grep` entry with input `{ pattern: "foo", path: "src" }`, `arg` is `"foo", src`.
- [unit] For a `Grep` entry with input `{ pattern: "foo" }`, `arg` is `"foo"`.
- [unit] For a `Git` entry with input `{ subcommand: "log" }`, `arg` is `log`.
- [unit] For a `nax-agents__run` entry with input `{ agent: "explorer", task: "find x" }`, `arg` is `explorer: find x`.
- [unit] For a `nax-skills__load` entry with input `{ name: "review" }`, `arg` is `review`.
- [unit] For a `Read` entry whose path is 70 characters, `arg` is its first 60 characters followed by `…`.
- [unit] For an entry named `acme__get`, `arg` is undefined.
- [unit] An ok entry has `tone: "success"` and an error entry `tone: "danger"`.
- [unit] An error entry with preview `\n  boom\nmore` returns summary `[{ text: "boom", tone: "danger" }]`.
- [unit] An error entry with no preview returns summary `[{ text: "failed", tone: "danger" }]`.
- [unit] A running `nax-agents__run` entry with five `Read` children returns four summary lines: `+2 more tool uses` and then three lines starting `Read(`.
- [unit] Every summary line of that running agent entry has tone `muted`.

### US-006 — Tool card results and collapsing

- [unit] An ok `Edit` entry with `old_string` `"a\nb"`, `new_string` `"a\nc\nd"` and path `x.ts` returns summary text `Updated x.ts (+3 -2)`.
- [unit] That model's `diff` equals `diffLines("a\nb", "a\nc\nd")`.
- [unit] An ok `Write` entry with content `"1\n2\n3\n"` and path `y.ts` returns summary text `Wrote 3 lines to y.ts`.
- [unit] An ok `Read` entry with a two-line preview returns summary text `Read 2 lines`.
- [unit] An ok `Read` entry with a preview of 4096 ASCII characters across 50 lines returns summary text `Read 50+ lines`.
- [unit] An ok `Bash` entry with a five-line preview, collapsed, returns the first three lines as summary lines with tone `plain`.
- [unit] That collapsed model has `hiddenLines: 2`.
- [unit] The same entry with `expanded: true` returns all five lines and `hiddenLines: 0`.
- [unit] An ok `nax-agents__run` entry with two children and `startedAt` / `endedAt` 38 seconds apart returns summary text `Done (2 tool uses · 38s)`.
- [unit] That entry with `expanded: true` lists both children after the summary line.
- [unit] An ok entry named `Glob` with preview `3 files\na\nb` returns summary text `3 files` with tone `muted`.
- [unit] An ok entry named `Glob` with an empty preview returns summary text `Done`.
- [unit] An ok `Edit` entry whose diff has 20 lines, collapsed, returns 12 diff lines.
- [unit] That collapsed Edit model has `hiddenLines: 8`.
- [unit] The same Edit entry with `expanded: true` returns 20 diff lines.
- [unit] A running `Edit` entry returns an empty `diff`.
- [unit] `diffLines("a\nb\nz", "a\nc\nz")` returns `{ sign: " ", text: "a" }`, `{ sign: "-", text: "b" }`, `{ sign: "+", text: "c" }`, `{ sign: " ", text: "z" }` in that order.
- [unit] `diffLines("a", "a\nb")` returns `{ sign: " ", text: "a" }` and `{ sign: "+", text: "b" }`.
- [unit] `diffLines("a\na", "a")` returns `{ sign: " ", text: "a" }` and `{ sign: "-", text: "a" }` (the common suffix is taken only from what remains after the common prefix).
- [unit] An ok `Bash` entry with an empty preview returns summary text `Done`.

### US-007 — Markdown: inline styles and blocks

- [unit] `renderMarkdown("# Title", { width: 40, theme })` returns one line whose plain text is `Title`.
- [unit] That line's span is bold.
- [unit] `renderMarkdown("a **b** c", …)` returns one line whose plain text is `a b c`.
- [unit] In that line the `b` span is bold and the `a ` span is not.
- [unit] `renderMarkdown("a *b*", …)` returns a line whose `b` span is italic.
- [unit] `renderMarkdown("use `x`", …)` returns a line whose plain text is `use x`.
- [unit] In that line the `x` span has color `accent`.
- [unit] `renderMarkdown("- one\n- two", …)` returns two lines with plain texts `- one` and `- two`.
- [unit] `renderMarkdown("1. one\n2. two", …)` returns lines starting `1. ` and `2. `.
- [unit] In those lines the number spans have color `accent`.
- [unit] An item nested under `- a` renders with plain text starting with two spaces and `- `.
- [unit] A paragraph of twelve five-letter words rendered at width 20 returns lines each at most 20 characters long.
- [unit] That paragraph's lines, joined with spaces, equal the original words in order.
- [unit] `renderMarkdown("> quoted", …)` returns a line whose plain text starts with the theme's `codeSide` glyph.
- [unit] In that line the `quoted` span is italic.
- [unit] `renderMarkdown("[nax](https://x.y)", …)` returns a line whose plain text is `nax (https://x.y)`.
- [unit] In that line the ` (https://x.y)` span has color `muted`.
- [unit] `renderMarkdown("---", { width: 10, theme })` returns one line of ten `rule` glyphs with color `muted`.
- [unit] `renderMarkdown("**unclosed", …)` returns without throwing and its plain text contains `unclosed`.

### US-008 — Markdown: fenced code and highlighting

- [unit] A fenced block with language `ts` and body `const x = 1;` returns three lines.
- [unit] The first of them is a muted line containing the `codeTop` glyph and `ts`.
- [unit] The second has plain text equal to the `codeSide` glyph, a space and `const x = 1;`.
- [unit] The third is a muted line containing the `codeBottom` glyph.
- [unit] In that code line the span `const` has color `syntaxKeyword`.
- [unit] In that code line the span `1` has color `syntaxNumber`.
- [unit] A fenced `ts` block with body `const s = "q";` gives the span `"q"` color `syntaxString`.
- [unit] A fenced `ts` block with body `// note` gives the comment span color `syntaxComment`.
- [unit] A fenced `ts` block with body `function run() {}` gives the span `run` color `syntaxTitle`.
- [unit] A fenced block with language `nosuchlang` renders its code line text after the side glyph as spans with no color.
- [unit] A fenced block with no language renders its code line text as spans with no color.
- [unit] A code line of 80 characters rendered at width 40 is returned as one line.
- [unit] `renderMarkdown("```ts\nconst a", …)` (unclosed fence) returns a code line whose plain text ends with `const a`.
- [unit] With `_markdownDeps.highlight` stubbed to throw, a fenced `ts` block renders its code line without throwing.
- [unit] In that case the code line's spans after the side glyph have no color.

### US-009 — Layout: message entries

- [unit] A `user` entry with text `hi` lays out as one line whose plain text is `> hi`.
- [unit] In that line the `>` span has color `accent` and every span has background `userBand`.
- [unit] A `user` entry with text `a\nb` lays out as lines `> a` and `  b`.
- [unit] A `reply` entry with text `done` lays out as one line whose plain text is the bullet glyph, a space and `done`.
- [unit] A `reply` whose markdown renders three lines lays out with its second and third lines starting with two spaces.
- [unit] A `thinking` entry without `endedAt` lays out as zero lines.
- [unit] A `thinking` entry with `startedAt` and `endedAt` 6 seconds apart lays out, collapsed, as one line `✻ Thought for 6s (ctrl+o to show)`.
- [unit] That line is muted and italic, and the layout does not include the thinking text.
- [unit] The same entry with `expanded: true` lays out a first line ending `(ctrl+o to hide)` followed by its text indented two columns.
- [unit] Two entries lay out with exactly one empty line between their lines.
- [unit] A reply line wider than `width` wraps so no line is longer than `width`.
- [unit] Every continuation line of that wrapped reply starts with two spaces.
- [unit] With ASCII glyphs, a `reply` entry's first line starts with `* `.
- [unit] A `user` entry of thirty `日` characters laid out at width 20 gives lines whose `displayWidth` is at most 20.
- [unit] `layoutTranscript` at width 4 lays out a `reply` entry `hello world` without throwing, as at width 10.

### US-010 — Layout: tool cards, listings and the cache

- [unit] An ok `Read` tool entry lays out a first line `⏺ Read(src/a.ts)` whose bullet span has color `success`.
- [unit] That card's second line starts `  ⎿  Read`.
- [unit] An error tool entry's first-line bullet span has color `danger`.
- [unit] A tool entry whose model has no `arg` lays out its first line as the bullet, a space and the title, with no parentheses.
- [unit] A card's second and later summary lines start with five spaces.
- [unit] An ok `Edit` entry lays out its `-` diff lines with background `diffRemove`.
- [unit] It lays out its `+` diff lines with background `diffAdd`.
- [unit] With a theme whose `diffAdd` and `diffRemove` are undefined, the `-` lines have color `danger` and the `+` lines color `success`.
- [unit] A collapsed card with `hiddenLines: 2` lays out a final muted line `     … +2 lines (ctrl+o to expand)`.
- [unit] An ok `Bash` entry whose preview is `a\x1b[?1049lb` lays out a summary line whose plain text contains `ab` and no escape character.
- [unit] Calling `layoutTranscript` twice with the same entry objects, width and `expanded` calls `_layoutDeps.layoutEntry` once per entry in total.
- [unit] Calling it again with a different width calls `_layoutDeps.layoutEntry` again for each entry.
- [unit] Calling it with the same width and the other `expanded` value calls `_layoutDeps.layoutEntry` again for each entry.
- [unit] After `reduceTranscript` appends to the last reply, the next `layoutTranscript` call calls `_layoutDeps.layoutEntry` for that entry only.

### US-011 — Layout: status and listing entries

- [unit] A `notice` entry `x` lays out as the line `※ x` with color `muted`.
- [unit] A `warning` entry `y` lays out as `⚠ y` with color `warning`.
- [unit] An `error` entry `z` lays out as `✗ z` with color `danger`.
- [unit] An `interrupted` entry lays out as the muted line `  ⎿  Interrupted by user`.
- [unit] A `welcome` entry with skills 42, commands 9, mcpServers 3, mcpConnected 2 and agents 4 lays out a line containing `skills 42 · commands 9 · mcp 3 (2 connected) · agents 4`.
- [unit] That welcome layout's first line has plain text `✻ nax chat` and is bold.
- [unit] A `listing` entry with title `MCP servers` lays out the title as a bold first line.
- [unit] Each text line of a listing follows the title in order.
- [unit] `listingTone("a  not locked (run nax mcp lock)")` returns `warning`.
- [unit] `listingTone("b  not connected")` returns `warning`.
- [unit] `listingTone("c  failed: x")` returns `danger`.
- [unit] `listingTone("d  connected, 3 tools")` returns `success`.
- [unit] `listingTone("e")` returns `plain`.
- [unit] A listing line `x  connected, 3 tools` lays out with color `success`.
- [unit] A `notice` entry whose text is `a\x1b[31mb` lays out the line `※ ab`.
- [unit] A `listing` entry with an empty text lays out only its title line.

### US-012 — Viewport reducer

- [unit] `reduceViewport(INITIAL_VIEWPORT, { type: "content", total: 100, height: 10 }, 100, 10)` returns `{ offset: 0, follow: true, unseen: 0 }`.
- [unit] From `{ offset: 0, follow: true, unseen: 0 }` with total 100 and height 10, `pageUp` returns `offset: 9`.
- [unit] That `pageUp` returns `follow: false`.
- [unit] From `{ offset: 9, follow: false, unseen: 0 }`, a `content` action growing total from 100 to 105 returns `offset: 14`.
- [unit] That `content` action returns `unseen: 5`.
- [unit] From `{ offset: 0, follow: true, unseen: 0 }`, a `content` action growing total from 100 to 105 returns `offset: 0`.
- [unit] From `{ offset: 9, follow: false, unseen: 5 }` with total 100 and height 10, `pageDown` returns `{ offset: 0, follow: true, unseen: 0 }`.
- [unit] `lineUp` from offset 0 with total 100 and height 10 returns `offset: 1`.
- [unit] `lineDown` from offset 1 returns `offset: 0` and `follow: true`.
- [unit] `pageUp` repeated 20 times with total 100 and height 10 returns `offset: 90`.
- [unit] With total 5 and height 10, `pageUp` returns `offset: 0` and `follow: true`.
- [unit] `home` with total 100 and height 10 returns `offset: 90` and `follow: false`.
- [unit] `end` from any state returns `INITIAL_VIEWPORT`'s values.
- [unit] `visibleRange(100, 10, 0)` returns `{ start: 90, end: 100 }`.
- [unit] `visibleRange(100, 10, 9)` returns `{ start: 81, end: 91 }`.
- [unit] `visibleRange(5, 10, 0)` returns `{ start: 0, end: 5 }`.
- [unit] From `{ offset: 50, follow: false, unseen: 3 }` with total 100 and height 10, a `content` action with total 20 and height 10 returns `offset: 10` and `unseen: 3`.
- [unit] From `{ offset: 90, follow: false, unseen: 0 }` with total 100 and height 10, a `content` action with total 100 and height 30 returns `offset: 70`.

### US-013 — Transcript viewport component

- [unit] Rendering `TranscriptViewport` with 3 lines and height 5 shows 5 rows, the 3 lines in the last 3 rows.
- [unit] Rendering it with 20 numbered lines and height 5 shows lines 16 to 20.
- [unit] After a pageUp key on an active viewport with 20 lines and height 5, line 20 is not in the frame.
- [unit] After that pageUp, line 16 is in the frame.
- [unit] After that pageUp and 3 more lines arriving, the last row reads `↓ 3 new lines (End)`.
- [unit] After an end key, line 23 is in the frame and no row contains `new lines`.
- [unit] A shift+upArrow key on an active viewport with 20 lines and height 5 shows lines 15 to 19.
- [unit] A home key shows lines 1 to 5.
- [unit] Keys on a viewport whose `active` prop is false leave the frame unchanged.

### US-014 — Line editor

- [unit] `editLine` from `EMPTY_EDITOR` with input `a` and then `b` gives `{ text: "ab", cursor: 2 }`.
- [unit] From `{ text: "ab", cursor: 2 }`, leftArrow then input `X` gives `{ text: "aXb", cursor: 2 }`.
- [unit] From `{ text: "ab", cursor: 1 }`, backspace gives `{ text: "b", cursor: 0 }`.
- [unit] From `{ text: "ab", cursor: 1 }`, `key.delete` (what ink reports for the Backspace key's `\x7f`) gives `{ text: "b", cursor: 0 }`.
- [unit] Backspace at cursor 0 returns the state unchanged.
- [unit] From `{ text: "a😀b", cursor: 2 }`, backspace gives `{ text: "ab", cursor: 1 }`.
- [unit] From `{ text: "one\ntwo", cursor: 6 }`, ctrl+a gives cursor 4.
- [unit] From `{ text: "one\ntwo", cursor: 4 }`, ctrl+e gives cursor 7.
- [unit] From `{ text: "foo bar baz", cursor: 11 }`, meta+leftArrow gives cursor 8.
- [unit] From `{ text: "foo bar baz", cursor: 0 }`, meta+rightArrow gives cursor 3.
- [unit] From `{ text: "foo bar", cursor: 7 }`, ctrl+w gives `{ text: "foo ", cursor: 4 }`.
- [unit] From `{ text: "ab\ncd", cursor: 4 }`, ctrl+u gives `{ text: "ab\nd", cursor: 3 }`.
- [unit] From `{ text: "ab\ncd", cursor: 1 }`, ctrl+k gives `{ text: "a\ncd", cursor: 1 }`.
- [unit] A pasted chunk `"x\r\ny\rz"` at cursor 0 gives `{ text: "x\ny\nz", cursor: 5 }`.
- [unit] Return with `meta: true` on `{ text: "a", cursor: 1 }` gives `{ text: "a\n", cursor: 2 }`.
- [unit] Return with `shift: true` on `{ text: "a", cursor: 1 }` gives `{ text: "a\n", cursor: 2 }`.
- [unit] Return on `{ text: "a\\", cursor: 2 }` gives `{ text: "a\n", cursor: 2 }`.
- [unit] Return on `{ text: " hi ", cursor: 4 }` returns `{ kind: "submit", text: " hi " }`.
- [unit] upArrow, downArrow, tab and escape each return `{ kind: "ignored" }`.
- [unit] ctrl+x returns `{ kind: "ignored" }`.
- [unit] `cursorRow({ text: "a\nb\nc", cursor: 3 })` returns `{ row: 1, rows: 3 }`.

### US-015 — Chat input

- [unit] Rendering `ChatInput` with width 20, active, empty and idle shows a first and last row of 20 `rule` glyphs.
- [unit] Its middle row starts `> ` followed by the placeholder `Try "explain how nax run picks a model" · / for commands`.
- [unit] Rendering it with `hint` `tell nax what to do instead` shows that hint instead of the placeholder.
- [unit] Typing `hello` then return calls `onSubmit` with `hello`.
- [unit] After that submit the input is empty.
- [unit] Return on an input of only spaces does not call `onSubmit`.
- [unit] With `busy` true, typing `hello` then return does not call `onSubmit` and the frame still shows `hello`.
- [unit] With `busy` true, typing `/cost` then return calls `onSubmit` with `/cost`.
- [unit] After submitting `one` then `two`, upArrow on an empty input shows `two`.
- [unit] A second upArrow shows `one`.
- [unit] After that, downArrow twice shows an empty input.
- [unit] Typing `dra`, upArrow, then downArrow shows `dra`.
- [unit] An input of 10 lines shows 8 text rows, and the cursor's row is one of them.
- [unit] The second text row of a two-line input starts with two spaces.
- [unit] Escape on a non-empty idle input calls `onClearArmedChange(true)` and keeps the text.
- [unit] A second escape within 2000 ms of `_chatInputDeps.now` empties the input.
- [unit] That second escape calls `onClearArmedChange(false)`.
- [unit] A second escape 2001 ms later keeps the text.
- [unit] Keys while `active` is false change nothing.
- [unit] With `yieldNavigation` true, return does not call `onSubmit` and upArrow does not recall history.

### US-016 — Turn status

- [unit] `reduceTurnStatus(IDLE_STATUS, turn_start at 2026-10-26T00:00:00Z)` returns `running: true`, `phase: "thinking"` and that `startedAt`.
- [unit] That `turn_start` resets `inputTokens` and `outputTokens` to 0.
- [unit] A `text_delta` sets `phase: "writing"`.
- [unit] A `tool_call` named `Bash` sets `phase: "tool"` and `toolName: "Bash"`.
- [unit] A `tool_result` sets `phase: "thinking"`.
- [unit] An `approval_requested` without `answerable` sets `phase: "approval"`.
- [unit] An `approval_requested` with `answerable: false` leaves the phase unchanged.
- [unit] An `approval_resolved` sets `phase: "thinking"`.
- [unit] A `compaction` sets `phase: "compacting"`.
- [unit] A `stream_reset` sets `phase: "retrying"`.
- [unit] Two `usage` events with input 100 and 200 and output 10 and 20 give `inputTokens: 300` and `outputTokens: 30`.
- [unit] A `usage` event with input 100, cacheRead 50 and cacheWrite 5 sets `contextTokens: 155`.
- [unit] A `turn_end` sets `running: false`.
- [unit] That `turn_end` keeps `contextTokens`.
- [unit] A `tool_call` with `metadata.subagentTask` set returns the status unchanged.
- [unit] `formatTokens(999)` returns `999`.
- [unit] `formatTokens(1234)` returns `1.2k`.
- [unit] `shortModel("anthropic/claude-sonnet-5-5")` returns `claude-sonnet-5-5`.
- [unit] `shortModel` of a 30-character name without `/` returns its first 23 characters followed by `…`.

### US-017 — Footer

- [unit] `footerModel` for mode `guarded`, hint `idle`, sandbox available, model `anthropic/m1`, cost 0.42 and no context window gives the left plain text `⏵ guarded · shift+tab to cycle`.
- [unit] It gives the right plain text `m1 · $0.42`.
- [unit] For mode `full` the left plain text starts `⏵⏵ full`, and that span has color `danger`.
- [unit] Hint `quit` gives the left plain text `press ctrl-c again to quit` with color `warning`.
- [unit] Hint `clear` gives a left plain text ending `esc again to clear`.
- [unit] Hint `busy` gives a left plain text ending `esc to interrupt`.
- [unit] Hint `expanded` gives a left plain text ending `ctrl+o to collapse`.
- [unit] Sandbox `unavailable` appends ` · sandbox unavailable` with color `warning`.
- [unit] An absent sandbox appends ` · sandbox off`.
- [unit] A sandbox of kind `disabled` appends ` · sandbox off`.
- [unit] `contextWindow` 200000 and `contextTokens` 36000 put `18% ctx` in the right text with color `muted`.
- [unit] 150000 context tokens give `75% ctx` with color `warning`.
- [unit] 190000 context tokens give `95% ctx` with color `danger`.
- [unit] With `contextTokens` undefined, the right text contains no `ctx`.
- [unit] With `contextWindow` undefined and `contextTokens` 36000, the right text contains no `ctx`.
- [unit] With `contextWindow` 0 and `contextTokens` 36000, the right text contains no `ctx`.
### US-018 — Working line and header

- [unit] `workingLine(IDLE_STATUS, 0, glyphs)` returns undefined.
- [unit] For a running status in phase `tool` with `toolName: "nax-agents__run"`, started 12 s before `nowMs`, with 8400 input and 1200 output tokens, the plain text is the spinner frame, a space and `Running Agent… (12s · ↑ 8.4k ↓ 1.2k tokens · esc to interrupt)`.
- [unit] The spinner frame at 0 ms elapsed is `glyphs.spinner[0]` and at 120 ms is `glyphs.spinner[1]`.
- [unit] Phase `approval` gives the verb `Waiting for approval…`.
- [unit] A running status whose `startedAt` is `now` (unparsable) gives `0s` and the first spinner frame.
- [unit] `headerLines` with version `0.91.7`, model `a/m1`, mode `guarded`, cwd `/Users/u/repo`, home `/Users/u`, sandbox available and width 60 returns a first line with plain text `✻ nax chat v0.91.7 · m1 · guarded`.
- [unit] Its second line starts `  ~/repo` and ends `sandbox on`.
- [unit] Its third line is 60 `rule` glyphs.
- [unit] With a sandbox of kind `disabled`, the second line ends `sandbox off`.
- [unit] A cwd longer than `width - 20` is shown with a `…` in the middle and at most `width - 20` characters.

### US-019 — Alternate screen and exit summary

- [unit] `renderChat(props)` with `_renderChatDeps.write` and `_renderChatDeps.render` stubbed writes `\x1b[?1049h\x1b[H` before calling `render`.
- [unit] Unmounting the returned instance writes `\x1b[?1049l`.
- [unit] Unmounting it twice writes `\x1b[?1049l` once in total.
- [unit] Invoking the handler registered through `_renderChatDeps.onExit` writes `\x1b[?1049l`.
- [unit] After that handler ran, unmounting writes nothing more.
- [unit] After the first restore, the remover returned by `_renderChatDeps.onExit` has been called.
- [unit] `formatChatExitSummary` for session `abc123` and cost 0.875 returns `✻ nax chat session abc123 · $0.88` followed on the next line by `  resume with: nax chat --resume abc123`.
- [unit] `chatCommand` with stubbed deps whose shell exits normally calls `writeOut` once with the summary built from `host.current()`.
- [unit] In that run, `writeOut` is called after the shell's `unmount`.
- [unit] When the SIGTERM handler runs, `writeOut` is called once with the summary.
- [unit] When `host.current()` throws at exit, `writeOut` is not called.
- [unit] In that case the exit code is the one the run would set without the summary.

### US-020 — Full-screen ChatApp: layout and transcript

- [unit] Mounting `ChatApp` with stdout rows 30 and columns 80 renders a frame of 30 rows.
- [unit] The frame's first row starts `✻ nax chat`.
- [unit] The frame's last row contains `⏵ guarded`.
- [unit] With stdout rows undefined the frame has 24 rows.
- [unit] With stdout rows 5, mounting does not throw and the frame contains the footer's `⏵ guarded`.
- [unit] `chatCommand` with stubbed deps calls `renderChat` with props whose `cwd` is the launch directory and whose `version` is `NAX_VERSION`.
- [unit] At mount, for a host without a catalog or MCP, the transcript shows the line containing `skills 0 · commands 0 · mcp 0 (0 connected) · agents 0`.
- [unit] Sending `hello` adds a transcript line `> hello`.
- [unit] A scripted reply `**done**` renders a row whose text is the bullet glyph, a space and `done`.
- [unit] A scripted fenced `ts` block renders a row containing the `codeSide` glyph.
- [unit] A scripted ok Edit call on `x.ts` renders a row containing `Updated x.ts`.
- [unit] While a scripted turn is running, a row shows `Thinking…`.
- [unit] While it is running, the footer contains `esc to interrupt`.
- [unit] After the turn ends, no row contains `Thinking…`.
- [unit] With `current()` returning `contextWindow: 200000` and a scripted `usage` of 36000 input tokens, the footer shows `18% ctx`.
- [unit] A scripted `nax-agents__run` call with task `scan` followed by a nested `Read` call tagged `subagentTask: "scan"` renders a row starting with spaces and `Read(` below the row containing `⏺ Agent(`.
- [unit] Entering full mode with the sandbox unavailable renders `⚠ sandbox unavailable: commands run outside the sandbox`.
- [unit] A `send` that rejects with `boom` renders `✗ boom`.
- [unit] `/mcp` renders a bold `MCP servers` row above the listing text.
- [unit] `/cost` for cost 1.235 renders a `Cost` row followed by a row `$1.24`.
- [unit] `/mode bogus` renders the row `※ unknown mode bogus; expected full or guarded`.
- [unit] `/clear` shows the welcome counts line again and no earlier transcript row.

### US-021 — Full-screen ChatApp: keys

- [unit] Escape while a scripted turn runs calls `host.cancel` once.
- [unit] That escape does not call `host.close`.
- [unit] Escape while no turn runs does not call `host.cancel`.
- [unit] Escape while an ask is pending does not call `host.cancel`.
- [unit] After a scripted Bash result of five lines, the frame contains `+2 lines (ctrl+o to expand)`.
- [unit] After ctrl+o, the frame contains all five lines.
- [unit] After ctrl+o, the footer contains `ctrl+o to collapse`.
- [unit] A second ctrl+o shows `+2 lines (ctrl+o to expand)` again.
- [unit] With 100 transcript lines, a pageUp key leaves the newest line out of the frame.
- [unit] After that pageUp, an end key brings the newest line back.
- [unit] Sending a message after a pageUp shows the newest line.
- [unit] An escape on a non-empty idle input makes the footer show `esc again to clear`.
- [unit] One ctrl-c during a turn makes the footer show `press ctrl-c again to quit`.
- [unit] Typing `ab`, leftArrow, `X`, return calls `host.send` with `aXb`.
- [unit] A stdout `resize` event to columns 60 re-renders the header rule 60 glyphs long.

### US-022 — Ask card model

- [unit] `askCardModel` for a Bash ask with command `npm test`, summary `Run the tests` and remembering allowed returns title `Bash command`.
- [unit] It returns options `Yes`, `Yes, and don't ask again for this in this session` and `No, tell nax what to do instead (esc)` in that order.
- [unit] With remembering not allowed, the options are `Yes` and `No, tell nax what to do instead (esc)`.
- [unit] An `unsandboxed` ask returns the title `Bash command · outside the sandbox`.
- [unit] An `unsandboxed` ask returns border tone `danger`; an ordinary ask returns `warning`.
- [unit] Tool `Edit` gives title `Edit file`.
- [unit] Tool `Write` gives title `Write file`, and tool `Delete` gives `Delete file`.
- [unit] Tool `nax-agents__run` gives title `Agent`.
- [unit] Tool `acme__put` gives title `MCP tool acme__put`.
- [unit] Tool `Grep` gives title `Grep`.
- [unit] A reason `[agent reviewer] needs to run` returns reason `needs to run`.
- [unit] That ask returns tag `[agent reviewer]`.
- [unit] A reason without the agent prefix returns no tag.
- [unit] An Edit ask whose `callId` matches a transcript tool entry with `old_string` `a` and `new_string` `b` returns diff lines `{ sign: "-", text: "a" }` and `{ sign: "+", text: "b" }`.
- [unit] An Edit ask with no matching tool entry returns an empty diff.
- [unit] A Bash ask returns an empty diff.

### US-023 — Ask card component

- [unit] Rendering `AskCard` for a Bash ask shows `❯ 1. Yes`.
- [unit] downArrow then return resolves `allow_session` when remembering is allowed.
- [unit] Key `1` resolves `allow_once`.
- [unit] Escape resolves `deny`.
- [unit] Key `a` resolves `allow_once` and key `d` resolves `deny`.
- [unit] Key `s` resolves `allow_session` when remembering is allowed.
- [unit] Key `s` resolves nothing when remembering is not allowed.
- [unit] Ctrl+a resolves nothing.
- [unit] With `_askCardDeps.now` 9 min 41 s before `expiresAt`, the card shows `expires in 9:41`.
- [unit] With 48 s left, it shows `expires in 0:48` with color `warning`.
- [unit] One second later on the fake clock, it shows `expires in 0:47`.
- [unit] A question ask renders the title `nax asks`.
- [unit] Typing `yes` then return in the question card calls `answerQuestion` with its `requestId` and `yes`.
- [unit] In `ChatApp`, with `draft` typed in the chat input, a question card's input starts empty.
- [unit] After answering that question, return in the chat input sends `draft`.
- [unit] In `ChatApp`, a pending Bash approval shows the card title `Bash command`.
- [unit] In `ChatApp`, choosing No shows the input with the hint `tell nax what to do instead`.
- [unit] After the next submit, that hint is gone.
- [unit] In `ChatApp`, a draft `draft` typed before a pending ask appears in the input after the ask resolves, and return sends `draft`.
- [unit] In `ChatApp`, escape while an approval is pending during a running turn resolves `deny` and does not call `host.cancel`.

### US-024 — Slash menu model and help descriptions

- [unit] `COMMAND_DESCRIPTIONS` has a non-empty description for every name in `COMMANDS`.
- [unit] `slashMenuItems` for a host whose catalog has command `deploy` (description `Ship it`) and skill `review` (description `Review code`) returns the built-ins first, in `COMMANDS` order.
- [unit] After the built-ins it returns `deploy` with description `(command) Ship it`.
- [unit] Last it returns `review` with description `(skill) Review code`.
- [unit] `slashMenuItems` for a host without a catalog returns only the built-ins.
- [unit] `filterSlashMenu(items, "/re")` returns names starting with `re` first, in item order.
- [unit] It then returns names containing `re` elsewhere, in item order.
- [unit] `filterSlashMenu(items, "/RE")` returns the same list as `/re`.
- [unit] `filterSlashMenu(items, "/")` returns every item.
- [unit] `filterSlashMenu(items, "/mode full")` returns null.
- [unit] `filterSlashMenu(items, "hello")` returns null.
- [unit] `filterSlashMenu(items, "/zzz")` returns an empty list.
- [unit] With the built-in `skills` and a catalog skill `skill`, `filterSlashMenu(items, "/skill")` returns `skill` first and `skills` second.
- [unit] `runSlashCommand` for `/help` calls `show` with text containing the line `/plugins  List plugins and what they provide` directly above `/mcp  List MCP servers`.
- [unit] That text contains `/quit  Quit nax chat` on the line after `/agents  List agents`.
- [unit] For a host whose catalog has command `deploy`, that text contains `/deploy - Ship it`.

### US-025 — Slash menu component

- [unit] Typing `/` in `ChatApp` shows the menu with `/help` and `Show commands and skills` under the input.
- [unit] Typing `/re` shows `❯` on the first match.
- [unit] downArrow moves `❯` to the second match.
- [unit] downArrow on the last match leaves `❯` there.
- [unit] Tab with `/resume` selected replaces the input text with `/resume `.
- [unit] After that tab, the menu is closed.
- [unit] Return with `/cost` selected after typing `/co` runs `/cost` and does not call `host.send`.
- [unit] Escape closes the menu and keeps the input text `/re`.
- [unit] Typing `s` after that escape opens the menu again.
- [unit] With 13 matches, the menu shows 8 rows.
- [unit] After 9 downArrow presses with 13 matches, the selected row is in the frame.
- [unit] Typing `/zzz` shows no menu rows.
- [unit] Typing `/mode full` shows no menu rows.
- [unit] While a pending ask is shown, typing does not open the menu.
- [unit] With a catalog skill named `skill`, typing `/skill` then return sends the skill invocation message for `skill` and does not run `/skills`.
- [unit] Escape with the menu open does not make the footer show `esc again to clear`.
- [unit] pageUp with the menu open scrolls the transcript viewport.

### US-026 — Picker outcome and relative time

- [unit] `runSlashCommand` for `/model` with no argument returns `{ kind: "picker", picker: "model" }`.
- [unit] That call invokes neither `show` nor `host.switchTo`.
- [unit] `/resume` with no argument returns `{ kind: "picker", picker: "resume" }`.
- [unit] That call does not invoke `host.resume`.
- [unit] `/mode` with no argument returns `{ kind: "picker", picker: "mode" }`.
- [unit] `/resume abc` still calls `host.resume({ id: "abc" })`.
- [unit] `/model a/b` still calls `host.switchTo({ model: "a/b" })`.
- [unit] In `ChatApp`, submitting `/model` with no argument calls neither `host.send` nor `host.switchTo`, and no row contains `unknown command`.
- [unit] `relativeTime` for 30 s before now returns `just now`.
- [unit] It returns `5 min ago` for 5 minutes before now.
- [unit] It returns `3 h ago` for 3 hours before now.
- [unit] It returns `yesterday` for 30 hours before now.
- [unit] It returns `Oct 20` for 2026-10-20T10:00:00Z seen at 2026-10-26T10:00:00Z.
- [unit] It returns an empty string for a null `updatedAt`.
- [unit] It returns an empty string for `not-a-date`.

### US-027 — Picker component

- [unit] In `ChatApp`, `/model` shows the picker titled `Switch model` with a row for each of `host.models`.
- [unit] The current model's row shows `(current)`.
- [unit] downArrow then return calls `host.switchTo` with the second model.
- [unit] After that choice the picker is closed and the input is shown.
- [unit] Escape closes the picker without calling `switchTo`.
- [unit] `/mode` shows the picker titled `Permission mode` with rows starting `guarded` and `full`.
- [unit] In that picker, the `guarded` row shows `(current)`.
- [unit] Choosing `full` calls `host.switchTo({ mode: "full" })`.
- [unit] `/resume` shows `loading…` until `listSessions` resolves.
- [unit] After it resolves, each session row shows its title and its relative time.
- [unit] A session row with `title: null` and id `abcdef1234` shows `untitled abcdef12`.
- [unit] A row with `heldByPid: 4242` shows `in use (pid 4242)`.
- [unit] Return on that row adds the warning row `⚠ session <id> is in use by pid 4242`.
- [unit] After that return the picker is still open and `host.resume` was not called.
- [unit] Return on a free row calls `host.resume({ id })` with that row's id.
- [unit] `listSessions` resolving to no rows shows `no saved sessions`.
- [unit] `listSessions` rejecting with `disk` closes the picker and renders `✗ disk`.
- [unit] `host.switchTo` rejecting with `nope` from the model picker renders `✗ nope`.
- [unit] After that rejection the input is shown again.
- [unit] `host.resume` rejecting with `locked` from the resume picker renders `✗ locked`.

### US-028 — Remove the old chat components

- [unit] Importing `@/tui/chat` after the deletions succeeds, and `renderChat` and `ChatApp` from it are usable as a function and a React component.

The removal itself is verified by `bun run typecheck` and `bun run lint` in `packages/nax` (see the story's verification note); nax requires at least one acceptance criterion per story.

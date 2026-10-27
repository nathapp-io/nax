# SPEC: tui-render-fixes — steady frame, block spacing, mouse scroll and selection, full /model list

Closes: #2708, #2709, #2710, #2711

## Summary

Four fixes to the `nax` interactive TUI found while testing v0.91.7-canary.3. (1) The
screen stops blinking: the chat frame is composed one row shorter than the terminal so
Ink never takes its clear-the-terminal path, and Ink renders incrementally. (2) A reply's
markdown blocks (heading, paragraph, list, code fence, quote, rule, table) are separated
by one blank row. (3) The mouse works the way Claude Code's full-screen UI does: the TUI
enables SGR any-motion mouse tracking on the alternate screen, the wheel scrolls the
transcript, and a left-button drag over the transcript selects text, highlights it and
copies it to the clipboard on release. Mouse bytes are filtered out of the stream Ink
reads, so they never reach the input as typed text. (4) `/model` lists every
tool-capable catalog model of each provider with usable auth, plus the
`agent.native.catalogOverrides` models the bundled catalog does not have, after the
configured tier models, and the `/model` picker filters its list as the user types.

## Motivation

The user tested v0.91.7-canary.3 on 2026-10-27 and filed:

- #2708 — the whole screen blinks on every keystroke, on the working-line tick and while
  text streams. Root cause: Ink 6.7 `onRender` writes `ansiEscapes.clearTerminal` plus the
  full frame whenever the previous frame's height is `>= stdout.rows`; `ChatApp` composes
  a frame exactly `rows` tall (`viewportHeight = rows - header - working - bottom - footer`).
- #2709 — no vertical space inside a reply. `layoutTranscript` separates entries with one
  empty line, but `renderMarkdown` (`src/tui/chat/markdown.ts`) maps marked's `space`
  token to no lines and concatenates blocks, so `# T\n\npara\n\n- a` lays out as three
  adjacent rows.
- #2710 — the transcript cannot be scrolled with the mouse. `TranscriptViewport` reacts
  only to PgUp, PgDn, Home, End and Shift+Up/Down. The TUI enables no mouse reporting, so
  on the alternate screen the terminal turns the wheel into bare Up/Down, which the input
  consumes as prompt history. A tmux probe on 2026-10-27 confirmed Claude Code v2.1 enables
  any-motion tracking with SGR encoding on its alternate screen and draws and copies its own
  selection; the user ruled the TUI does the same (wheel scroll on, in-app drag selection).
- #2711 — `/model` offers three models. `nativeModels()` (`src/chat/chat-host.ts`) lists
  only `models.native.{fast,balanced,powerful}`. User ruling 2026-10-27: list the catalog
  models of every provider `nax auth list` reports available, plus `catalogOverrides`
  provider/model entries that do not exist in the bundled catalog. Follow-up ruling the
  same day: the `/model` list must be filterable by name, since it now holds dozens of rows.

#2712 (guarded mode asks before every command) is the separate feature
`tui-guarded-posture`, which follows this one.

## Design

### Approach

**1. Steady frame (US-001, #2708).** `ChatApp` derives every row budget from
`usableRows = size.rows - FRAME_SLACK_ROWS` (`FRAME_SLACK_ROWS = 1`) instead of `size.rows`:
the bottom budget, the menu, ask-card and picker budgets and the viewport height alike. The
composed frame is therefore at most `rows - 1` rows tall in every state — a long draft, an
oversized ask card, an open picker or slash menu included — so Ink's
`lastOutputHeight >= stdout.rows` branch is never taken and Ink's normal log-update path
runs. The footer stays the frame's last row; the terminal's last row stays blank.
`renderChat` passes `incrementalRendering: true` (an Ink 6.7 `RenderOptions` field) next to
`exitOnCtrlC: false`, so Ink rewrites only the rows that changed.

**2. Block spacing (US-001, #2709).** `renderMarkdown` renders each top-level token with
`blockLines` as today, drops the blocks that produced no lines (`space`, `def`, an empty
paragraph), and joins the remaining blocks with exactly one empty `StyledLine` (`[]`)
between each adjacent pair: none before the first block and none after the last. The gap
is independent of the source: `code` immediately followed by a paragraph with no blank
source line still gets one blank row. Spacing inside a list (between items, tight or loose)
and inside a blockquote is unchanged — only top-level blocks are separated.

**3. Mouse input (US-002 module, US-003 wiring, #2710).** New module `src/tui/chat/mouse-input.ts`:

```ts
export const ENABLE_MOUSE = "\u001b[?1003h\u001b[?1006h";
export const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1003l";

export type MouseButton = "left" | "middle" | "right" | "none";
export interface MouseEvent {
  readonly kind: "press" | "release" | "drag" | "move" | "wheelUp" | "wheelDown";
  readonly button: MouseButton;
  /** 1-based terminal column and row, as the terminal reports them. */
  readonly x: number;
  readonly y: number;
}
export interface MouseEvents {
  subscribe(listener: (event: MouseEvent) => void): () => void;
}
export interface MouseInput {
  /** What Ink reads: the source with every complete SGR mouse report removed. */
  readonly stdin: NodeJS.ReadStream;
  readonly events: MouseEvents;
}
export function parseSgrMouse(sequence: string): MouseEvent | undefined;
export function createMouseInput(source: NodeJS.ReadStream): MouseInput;
```

An SGR report is `ESC [ < b ; x ; y M` (press or motion) or `... m` (release). The low two
bits of `b` name the button (0 left, 1 middle, 2 right, 3 none); bit 32 marks motion
(`drag` when a button is held, `move` when `b & 3 === 3`); 64 is `wheelUp` and 65
`wheelDown`; modifier bits 4, 8 and 16 are ignored. Horizontal wheel reports (`b` 66 and
67) parse to `undefined` but, being complete reports, are still removed from the stream
and emit no event. `parseSgrMouse` returns `undefined` for anything that is not one complete
report.

`createMouseInput` returns a `PassThrough` stream that forwards Ink's control calls to the
source — `isTTY` (a property), `setRawMode`, `ref` and `unref` (added to the stream, since a
`PassThrough` has no `ref`/`unref`) — and whose own `setEncoding("utf8")` call also sets
the stream's own encoding, so Ink's `read()` returns strings. Source chunks are decoded with
a `StringDecoder("utf8")`, so a multi-byte character split across chunks is not corrupted.
`MouseInput` also has `dispose(): void`, which removes the source listener. For every chunk the
source emits, writes the chunk minus its complete SGR reports and emits one `MouseEvent`
per report, in order. A chunk that ends inside a report (its tail begins with `ESC [ <` and
has no `M`/`m` terminator yet) keeps that tail and prepends it to the next chunk. A
trailing bare `ESC` or `ESC [` is never held, so a pressed Escape key reaches Ink at once.
A sequence that begins with `ESC [ <` but breaks the grammar before a terminator is passed
through unchanged.

`renderChat` builds the mouse input from `process.stdin` (injected through
`_renderChatDeps.stdin`), passes `stdin: mouse.stdin` to `render`, passes `mouse.events` to
`ChatApp` as a new optional prop `mouse`, writes `ENABLE_MOUSE` after `render` returns
(Ink has put the terminal in raw mode by then, so no report is echoed) when the source is a
TTY, and in its one-shot restore (unmount and the process `exit` handler alike) writes
`DISABLE_MOUSE` right before `LEAVE_ALT_SCREEN` and calls `mouse.dispose()`.

**Wheel scroll.** `ChatApp` hands `mouse` to `TranscriptViewport` (new optional prop
`mouse`). The viewport subscribes while it is active; `wheelUp` reduces the new viewport
action `{ type: "wheelUp" }` and `wheelDown` `{ type: "wheelDown" }`, which move
`WHEEL_LINES = 3` lines through the same `settle` clamp the line actions use (toward older
lines for `wheelUp`). The wheel scrolls wherever the pointer is. Keyboard scrolling and
the footer are unchanged.

**4. Selection and copy (US-004 modules, US-005 wiring, #2710).** A pure module `src/tui/chat/selection.ts`:

```ts
export interface TranscriptPoint { readonly line: number; readonly column: number }
export interface Selection { readonly anchor: TranscriptPoint; readonly focus: TranscriptPoint }
export interface ViewportGeometry {
  readonly top: number;      // 0-based screen row of the viewport's first row
  readonly height: number;   // viewport rows
  readonly total: number;    // transcript lines
  readonly offset: number;   // ViewportState.offset
  readonly unseen: number;   // ViewportState.unseen
}
export function transcriptPointAt(geometry: ViewportGeometry, x: number, y: number): TranscriptPoint | undefined;
export function selectedText(lines: readonly StyledLine[], selection: Selection): string;
export function highlightLine(line: StyledLine, index: number, selection: Selection): StyledLine;
```

`transcriptPointAt` maps a 1-based terminal cell to a transcript line and 0-based display
column using the same window `ViewportRows` draws: `visibleRange(total, height, offset)`,
the blank padding rows above short content, and the unseen-marker row (which is not a
transcript line). Rows outside the viewport, padding rows and the marker row map to
`undefined`. `selectedText` orders anchor and focus, takes each line's span text, slices
the first and last line by display column (a wide grapheme partly inside the range is
taken whole), trims trailing spaces per line and joins lines with `\n`. `highlightLine`
returns the line with the selected columns split into spans carrying `inverse: true`; a
line outside the selection is returned unchanged. `Span` gains `inverse?: boolean`, which
`StyledLineView` passes to Ink's `Text` `inverse`.

`TranscriptViewport` owns the selection state: a `press` with `button: "left"` on a
transcript point starts a selection (anchor = focus = that point) and clears any earlier
one; a `drag` with `button: "left"` moves the focus to the point under the pointer (a drag
outside the viewport keeps the last focus); a `release` copies when anchor and focus
differ, by calling the new optional prop `onCopy(text)` with `selectedText`; the highlight
stays until the next left press or until the transcript's line count changes (a
re-render with the same number of lines, such as the working-line tick or a streamed token
on the last line, keeps it). Selection is inclusive of the focus cell. `ChatApp` passes
`top={HEADER_ROWS}` (3), the screen row of the viewport's first row. The press, drag and
release state lives in a new hook `src/tui/chat/use-mouse-selection.ts`
(`useMouseSelection`), which `TranscriptViewport` calls, so neither component grows a new
branchy body. A press outside the
transcript clears the selection and starts none. Drag-to-autoscroll past the viewport edge
is out of scope.

New module `src/tui/chat/clipboard.ts`:

```ts
export const _clipboardDeps = {
  write: (text: string): void => { process.stdout.write(text); },
  platform: process.platform,
  spawnCopy: (text: string): Promise<number> => { /* Bun.spawn(["pbcopy"], { stdin }) exit code */ },
};
export function osc52(text: string): string; // "\u001b]52;c;" + base64(utf8 text) + "\u0007"
export async function copyToClipboard(text: string): Promise<void>;
```

`copyToClipboard` always writes `osc52(text)`; on `platform === "darwin"` it also runs
`spawnCopy(text)`, because Terminal.app ignores OSC 52. A rejected or non-zero `spawnCopy`
is swallowed (OSC 52 was already sent). `ChatApp` passes `onCopy` that calls
`copyToClipboard` and shows the footer hint `copied <n> chars` (new `FooterHint` value
`copied`, with the count) until the next key press or mouse press.

**5. `/model` list (US-006, #2711).** New function in `src/agents/catalog/index.ts`:

```ts
export async function listCatalogModels(providerIds: readonly string[]): Promise<readonly string[]>;
```

It loads the bundled catalog through the existing cached `loadCatalog(_catalogDeps.loadProviders)`
and returns `"<provider>/<id>"` for every model of each named provider whose
`supportsTools` is true, providers in the order given, models in catalog order. A failed
catalog load returns `[]`.

New module `src/chat/chat-models.ts`, exported from the chat barrel:

```ts
export interface ChatModelChoicesInput {
  readonly config: Pick<NaxConfig, "models" | "agent">;
  readonly availableProviders: readonly string[];
  readonly listCatalogModels: (providerIds: readonly string[]) => Promise<readonly string[]>;
}
export async function chatModelChoices(input: ChatModelChoicesInput): Promise<readonly string[]>;
```

Order: (a) the tier models `fast`, `balanced`, `powerful` exactly as `nativeModels` builds
them today — `nativeModels` moves from `chat-host.ts` into `chat-models.ts` as the exported
`tierModels(config)`, and `chat-host.ts` imports it; (b) every `agent.native.catalogOverrides[].models[]` entry whose
`supportsTools` is true, as `"<provider>/<id>"`, in config order, whether or not its
provider is in `availableProviders` (the user configured it on purpose); (c)
`listCatalogModels(availableProviders)`. Duplicates keep their first position. A
`listCatalogModels` rejection yields (a) then (b).

`ChatHostDeps` gains optional `models?: readonly string[]`; `NativeChatHost` uses it when
present and `nativeModels(config)` otherwise. `composeChat` (`src/cli/chat.ts`) computes the
list before `createChatHost`: `collectAuthList(requested)` (new
`_chatCommandDeps.collectAuthList`), where `requested` is the provider of every tier model
and every override (so a provider authenticated only through an environment variable is
probed too), gives the providers with `available: true`, `chatModelChoices` (with new
`_chatCommandDeps.listCatalogModels`) builds the list, and it is passed as `models`. A
rejected `collectAuthList` is treated as no available provider.

**6. `/model` filter (US-007, #2711).** The filter lives in the picker's state, not in the
`Picker` component, so the rows `ChatApp` reserves (`bottomRowsFor` → `pickerRows`) are the
rows it draws. `PickerModelInput` and `PickerModel` gain `query?: string`. For `kind:
"model"`, `pickerModel` keeps only the entries whose `value` contains the query
case-insensitively (an empty or absent query keeps every entry) and always carries the
query; the `mode` and `resume` kinds ignore it. A model picker draws one extra row under
its title (counted by `fixedRows`, so `pickerRows` grows by one for `kind: "model"`):
`Filter: <query>` when the query is non-empty, and the muted placeholder `type to filter`
when it is empty; the row starts at column 0, never with the pointer or its blank. A model
picker whose filter matches nothing draws the muted note `no models match`.

`ChatPicker` gains `setQuery(query: string): void`; `useChatPicker` stores the query with
the open picker, resets it to `""` on `open` and on `cancel`/`choose`, and builds `model`
from it. `PickerProps` gains optional `onQuery?: (query: string) => void` and `query?:
string`; `ChatApp` passes `picker.setQuery` and `picker.model.query`. While a `kind: "model"`
picker is active, `Picker` also owns: a printable input with no ctrl or meta modifier
(appended to the query), and backspace or delete (the last grapheme removed; nothing
happens on an empty query). Escape, return and the arrows keep their meaning. The pointer
returns to the first entry whenever the query changes. Return on a picker with no entries
does nothing.

### Integration (extends existing code)

Read only (verified 2026-10-27):

- Ink 6.7 `render(node, options)` with `RenderOptions.stdin`, `incrementalRendering`,
  `exitOnCtrlC`; Ink's `App` reads input through `stdin.read()` on `'readable'` and calls
  `stdin.setRawMode`, `setEncoding('utf8')`, `ref`, `unref`, `isTTY`.
- `visibleRange(total, height, offset)` and `reduceViewport(state, action, total, height)`
  in `src/tui/chat/viewport.ts`.
- `collectAuthList(providerIds): Promise<AuthListReport>` in `src/cli/auth-list.ts`;
  `AuthListProvider.available: boolean`.
- nax-ai `Catalog.listModels(provider?)` returning `ResolvedModel { id, provider, ... }`;
  `RawModel.supportsTools`.
- `ProviderCatalogOverrideSchema` (`provider`, `models[]` of `CatalogModelOverrideSchema`
  with `id`, `supportsTools`) in `src/config/schemas-model.ts`.

Changed (the baseline exists only to locate the code; implement the target):

- `renderChat(props)` — Baseline: `render(createElement(ChatApp, props), { exitOnCtrlC: false })`, writes `ENTER_ALT_SCREEN` / `LEAVE_ALT_SCREEN`. Target: `render(createElement(ChatApp, { ...props, mouse: mouse.events }), { exitOnCtrlC: false, incrementalRendering: true, stdin: mouse.stdin })`, writes `ENTER_ALT_SCREEN` before `render` and `ENABLE_MOUSE` after it (TTY only), and `DISABLE_MOUSE` then `LEAVE_ALT_SCREEN` plus `mouse.dispose()` on restore. `_renderChatDeps` gains `stdin: () => NodeJS.ReadStream` and `createMouseInput`.
- `ChatAppProps` — Target adds `readonly mouse?: MouseEvents`.
- `TranscriptViewportProps` — Target adds `readonly mouse?: MouseEvents`, `readonly top?: number` (default 0; `ChatApp` passes `HEADER_ROWS`) and `readonly onCopy?: (text: string) => void`.
- `MouseInput` — new; `stdin`, `events`, `dispose()`.
- `ViewportAction` — Target adds `{ type: "wheelUp" }` and `{ type: "wheelDown" }`.
- `Span` (`src/tui/chat/styled-line.tsx`) — Target adds `readonly inverse?: boolean`.
- `FooterHint` — Baseline: `"quit" | "clear" | "busy" | "expanded" | "idle"`. Target adds `"copied"`; `footerModel` input gains `copiedChars?: number` used by that hint.
- `ChatHostDeps` — Target adds `readonly models?: readonly string[]`.
- `PickerModelInput`, `PickerModel` (`src/tui/chat/Picker.tsx`) — Target adds `readonly query?: string`.
- `ChatPicker` — Baseline: `model`, `open`, `cancel`, `choose`. Target adds `setQuery(query: string): void`.
- `PickerProps` — Target adds `readonly query?: string` and `readonly onQuery?: (query: string) => void`.
- `_chatCommandDeps` — Target adds `collectAuthList` and `listCatalogModels`.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| stdin is not a TTY | `renderChat` writes no `ENABLE_MOUSE` and no `DISABLE_MOUSE`; the filtered stream passes data through. |
| A chunk ends inside an SGR report | The partial report is held and completed by the next chunk; nothing of it reaches Ink. |
| A chunk ends with a bare `ESC` or `ESC [` | Passed to Ink immediately, not held. |
| `ESC [ <` followed by bytes that break the grammar | Passed through unchanged. |
| Process exits without unmount | The exit handler writes `DISABLE_MOUSE` then `LEAVE_ALT_SCREEN`, once. |
| `spawnCopy` rejects or exits non-zero | Swallowed; `copyToClipboard` resolves; the `copied` hint still shows. |
| Release with anchor equal to focus (a click) | No copy; no hint. |
| Catalog load fails | `listCatalogModels` returns `[]`; `/model` lists tiers then overrides. |
| `collectAuthList` rejects | Treated as no available provider; `/model` lists tiers then overrides. |
| The `/model` filter matches nothing | The picker shows no entries and the muted note `no models match`; return does nothing; escape cancels. |

## Out of Scope

- Guarded-mode permission posture (#2712) is the follow-up feature `tui-guarded-posture`; this feature does not change `chat-mode.ts`, `askRulesFor` or any permission or approval behaviour.
- US-005 only: drag-to-autoscroll when the pointer leaves the viewport during a selection is not implemented; the focus stays at the last point inside the viewport.
- US-005 only: double-click word selection, triple-click line selection and selecting text inside the input, ask card, picker, header or footer are not implemented.
- US-004 only: copying uses OSC 52 everywhere and `pbcopy` on macOS; no Linux or Windows clipboard command (`wl-copy`, `xclip`, `clip.exe`) is spawned.
- US-007 only: the `/resume` and `/mode` pickers do not filter; only the `/model` picker takes a typed query.
- US-007 only: the filter is a case-insensitive substring match on the model string; no fuzzy matching, ranking or highlighting of the matched characters.
- US-006 only: ACP `modelChoices` (`packages/nax-agent-acp/src/server/session-config.ts`) keeps its tier-only list.
- No configuration key to turn mouse reporting off is added.
- The Ink version is not changed.


## Stories

Paths below are repo-relative. Seven stories, one capability: the interactive TUI renders
steadily and takes the mouse, and `/model` offers and filters the real model list.
US-001 fixes the frame and the markdown spacing; US-002 builds the mouse input module;
US-003 wires it into the screen and scrolls on the wheel; US-004 builds the pure selection
and clipboard modules; US-005 wires selection and copy into the screen; US-006 widens
`/model`; US-007 adds the `/model` filter. Spec-review pass 1 split the mouse work and the
selection work to keep every story under the 24-assertion cap.

### US-001 — Steady frame and markdown block spacing

Workdir: packages/nax. No dependencies.

- Derive every row budget in `ChatApp` from `usableRows = size.rows - FRAME_SLACK_ROWS` and render with `incrementalRendering: true` (Design §Approach 1).
- Separate a reply's top-level markdown blocks with exactly one blank row (Design §Approach 2).

### US-002 — Mouse input module

Workdir: packages/nax. No dependencies.

- Create `mouse-input.ts` with `ENABLE_MOUSE`, `DISABLE_MOUSE`, `parseSgrMouse` and `createMouseInput` (with `dispose`) (Design §Approach 3, the module paragraphs).

### US-003 — Mouse wiring and wheel scrolling

Workdir: packages/nax. Depends on US-001, US-002.

- Wire `createMouseInput` through `renderChat`, `ChatApp` and `TranscriptViewport`; add the `wheelUp` / `wheelDown` viewport actions (Design §Approach 3, the `renderChat` and Wheel scroll paragraphs).

### US-004 — Selection and clipboard modules

Workdir: packages/nax. No dependencies.

- Create `selection.ts` (`transcriptPointAt`, `selectedText`, `highlightLine`) and `clipboard.ts` (`osc52`, `copyToClipboard`, `_clipboardDeps`); add `Span.inverse` and its rendering in `StyledLineView` (Design §Approach 4, the module paragraphs).

### US-005 — Drag selection and copy in the screen

Workdir: packages/nax. Depends on US-003, US-004.

- Create `use-mouse-selection.ts`; let `TranscriptViewport` select on left drag and call `onCopy`; `ChatApp` passes `top={HEADER_ROWS}`, copies through `copyToClipboard` and shows the `copied` footer hint (Design §Approach 4, the wiring paragraphs).

### US-006 — `/model` lists catalog and override models

Workdir: packages/nax. No dependencies.

- Add `listCatalogModels` to the catalog boundary, create `chat-models.ts` (`tierModels`, `chatModelChoices`), accept `models` in `ChatHostDeps`, and compute the list in `composeChat` (Design §Approach 5).

### US-007 — `/model` picker filters by name

Workdir: packages/nax. No dependencies.

- Add `query` to the picker model and state, `setQuery` to `ChatPicker`, the filter row and the `no models match` note, and the typing keys in `Picker` for the model kind; `ChatApp` passes the query through (Design §Approach 6).

### Context Files

**US-001**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/index.ts`
- `packages/nax/src/tui/chat/markdown.ts`
- `packages/nax/test/ui/chat/chat-app-layout.test.tsx`
- `packages/nax/test/ui/chat/slash-menu.test.tsx`

**US-002**
- `packages/nax/src/tui/chat/index.ts`
- `packages/nax/src/tui/chat/alt-screen.ts`

**US-003**
- `packages/nax/src/tui/chat/index.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/TranscriptViewport.tsx`
- `packages/nax/src/tui/chat/viewport.ts`
- `packages/nax/src/tui/chat/mouse-input.ts` — created by US-002, consumed here

**US-004**
- `packages/nax/src/tui/chat/styled-line.tsx`
- `packages/nax/src/tui/chat/wrap.ts`
- `packages/nax/src/tui/chat/viewport.ts`
- `packages/nax/src/tui/chat/TranscriptViewport.tsx`

**US-005**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/TranscriptViewport.tsx`
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/src/tui/chat/selection.ts` — created by US-004, consumed here
- `packages/nax/src/tui/chat/clipboard.ts` — created by US-004, consumed here

**US-006**
- `packages/nax/src/agents/catalog/index.ts`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/cli/chat.ts`
- `packages/nax/src/cli/auth-list.ts`
- `packages/nax/test/unit/cli/chat.test.ts`

**US-007**
- `packages/nax/src/tui/chat/Picker.tsx`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/bottom-region.ts`
- `packages/nax/test/ui/chat/picker.test.tsx`

### Creates

**US-002**
- `packages/nax/src/tui/chat/mouse-input.ts`
- `packages/nax/test/unit/tui/chat/mouse-input.test.ts`

**US-004**
- `packages/nax/src/tui/chat/selection.ts`
- `packages/nax/src/tui/chat/clipboard.ts`
- `packages/nax/test/unit/tui/chat/selection.test.ts`
- `packages/nax/test/unit/tui/chat/clipboard.test.ts`

**US-005**
- `packages/nax/src/tui/chat/use-mouse-selection.ts`

**US-006**
- `packages/nax/src/chat/chat-models.ts`
- `packages/nax/test/unit/chat/chat-models.test.ts`

### Modifies

**US-001**
- `packages/nax/test/ui/chat/chat-app-layout.test.tsx` — every assertion that the frame has exactly the terminal's row count changes to that count minus one, because every budget now derives from `usableRows = rows - 1`: the default-stream case (24 becomes 23), the 30-row harness cases including the tall-draft (F1) and ask-card cases (30 becomes 29), and the 12-row tall-draft case (12 becomes 11); an assertion that counts viewport or input rows changes by the same one row where the slack falls on it; every assertion on what the footer, header, input or viewport rows contain is unchanged.
- `packages/nax/test/ui/chat/slash-menu.test.tsx` — the short-terminal cases that assert `rows` has length `SHORT_ROWS` (12) change to `SHORT_ROWS - 1`, and the F15/F16 cases (a terminal with no rows for the menu) keep their behaviour but move their terminal height up by one row if the one-row slack would otherwise change whether the menu gets a row; the menu-key behaviour each case asserts is unchanged.
- `packages/nax/test/ui/chat/index.test.tsx` — the case asserting `render` was called with options equal to `{ exitOnCtrlC: false }` changes its expected options to include `incrementalRendering: true` beside `exitOnCtrlC: false` (US-003 later adds `stdin`); the alt-screen write-order assertions are unchanged in this story.

**US-002**
None. `mouse-input.ts` is a new module and no existing test imports it.

**US-003**
- `packages/nax/test/ui/chat/index.test.tsx` — `stubScreen()` gains an injected fake stdin (`_renderChatDeps.stdin`) and an injected `_renderChatDeps.createMouseInput` returning a fake `MouseInput` whose `dispose` is recorded, so no test touches the runner's real `process.stdin`; the render-options assertion gains `stdin` equal to that fake mouse input's stream; the write-order assertions change from `[ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]` to `[ENTER_ALT_SCREEN, ENABLE_MOUSE, DISABLE_MOUSE, LEAVE_ALT_SCREEN]` when the fake stdin is a TTY and stay `[ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]` for a non-TTY stdin; the order assertion places `ENABLE_MOUSE` after `render`; restore still runs exactly once.

**US-004**
None. `selection.ts` and `clipboard.ts` are new, and `Span.inverse` is optional, so no existing span literal or test changes.

**US-005**
None. The new `TranscriptViewport` and `ChatApp` props are optional and the new `copied` footer hint is additive; no existing test passes a `mouse` or asserts an exhaustive hint list.

**US-006**
- `packages/nax/test/unit/cli/chat.test.ts` — the deps fixture built from `...api._chatCommandDeps` gains stubs for the two new members: `collectAuthList` resolving a report with no providers and `listCatalogModels` resolving `[]`, so no existing `chatCommand` case reads real credentials or loads the real catalog; every existing assertion is unchanged.
- `packages/nax/test/unit/cli/chat-resources.test.ts` — the deps fixture built from `...api._chatCommandDeps` gains the same two stubs for the same reason; every existing assertion is unchanged.

**US-007**
- `packages/nax/test/ui/chat/picker.test.tsx` — an assertion that counts every row inside the `Switch model` frame (rather than the entry rows `entryRows` selects) gains the one filter row under the title; the entry-row, label, `(current)` marker and choice assertions are unchanged, because the filter row starts at column 0 and is not an entry row.

### Seams

- US-002 → US-003: `createMouseInput` is consumed by `renderChat`; US-003's seam ACs call `renderChat` with an injected `createMouseInput` spy and assert the injected stdin reaches it, its `stdin` reaches `render` and its `events` reach `ChatApp`.
- US-002 → US-003: `MouseEvents` is consumed by `ChatApp` and `TranscriptViewport`; US-003's seam AC mounts `ChatApp` with a fake `mouse` and asserts a `wheelUp` scrolls the transcript.
- US-004 → US-005: `transcriptPointAt`, `selectedText`, `highlightLine` and `copyToClipboard` are consumed by `useMouseSelection`, `TranscriptViewport` and `ChatApp`; US-005's seam ACs drive a mounted `ChatApp` through a fake `MouseEvents` at absolute screen coordinates and assert the stubbed clipboard write receives the selected text.
- US-006 internal: `chatModelChoices` and `listCatalogModels` are consumed by `composeChat`; US-006's seam ACs call `chatCommand(options, deps)` with injected deps and assert what the host receives.
- US-007 internal: `ChatPicker.setQuery` is consumed by `ChatApp` through the `Picker`'s `onQuery`; US-007's seam AC types into the mounted `ChatApp` after `/model` and asserts the drawn entries are filtered.

## Acceptance Criteria

### US-001 — Steady frame and markdown block spacing

- [unit] Mounting `ChatApp` on a 30-row, 80-column stream renders exactly 29 rows.
- [unit] Mounting `ChatApp` on a stream that reports no rows renders exactly 23 rows (the 24-row default minus one).
- [unit] On a 30-row stream the last rendered row is the footer and contains the mode label `⏵ guarded`.
- [unit] On a 30-row stream with a running turn (working line shown), the frame renders exactly 29 rows.
- [unit] On a 30-row stream with a draft wider than four terminal rows typed into the input, the frame renders exactly 29 rows.
- [unit] On a 30-row stream with a pending approval ask whose card is taller than the bottom budget, the frame renders exactly 29 rows.
- [unit] On a 30-row stream with the `/model` picker open, the frame renders exactly 29 rows.
- [unit] On a 30-row stream with `/` typed so the slash menu is open, the frame renders exactly 29 rows.
- [unit] `renderChat(props)` calls the injected `render` with options whose `incrementalRendering` is `true`.
- [unit] `renderMarkdown("# T\n\npara", ...)` returns the lines `T`, an empty line, `para`.
- [unit] `renderMarkdown("para\n\n- a\n- b", ...)` returns `para`, an empty line, `- a`, `- b`.
- [unit] `renderMarkdown` of a fenced `ts` block followed on the next source line by `after` (no blank source line) returns the fence's lines, one empty line, then `after`.
- [unit] `renderMarkdown("a\n\n\n\nb", ...)` returns `a`, exactly one empty line, `b`.
- [unit] `renderMarkdown("- a\n\n- b", ...)` returns `- a`, `- b` with no empty line between the items (a loose list is still one block).
- [unit] `renderMarkdown("para\n\n[1]: https://x.y", ...)` returns exactly one line, `para`, with no trailing empty line (a link definition renders no lines and adds no gap).
- [unit] `renderMarkdown("> q\n\n---", ...)` returns the quote's line, one empty line, then the rule line.
- [unit] `layoutTranscript` of one reply entry `"# T\n\npara"` at width 40 returns the gutter line for `T`, then the line `"  "` (the gutter's blank indent), then the indented `para` line.

### US-002 — Mouse input module

- [unit] `parseSgrMouse("\u001b[<0;10;5M")` returns `{ kind: "press", button: "left", x: 10, y: 5 }`.
- [unit] `parseSgrMouse("\u001b[<0;10;5m")` returns `{ kind: "release", button: "left", x: 10, y: 5 }`.
- [unit] `parseSgrMouse("\u001b[<32;11;5M")` returns `{ kind: "drag", button: "left", x: 11, y: 5 }`.
- [unit] `parseSgrMouse("\u001b[<35;11;5M")` returns `{ kind: "move", button: "none", x: 11, y: 5 }`.
- [unit] `parseSgrMouse("\u001b[<64;3;4M")` returns `{ kind: "wheelUp", button: "none", x: 3, y: 4 }`.
- [unit] `parseSgrMouse("\u001b[<65;3;4M")` returns `{ kind: "wheelDown", button: "none", x: 3, y: 4 }`.
- [unit] `parseSgrMouse("\u001b[<16;3;4M")` (left press with the ctrl bit) returns kind `press` and button `left`.
- [unit] `parseSgrMouse("\u001b[<x;3;4M")` returns `undefined`.
- [unit] Writing the chunk `a\u001b[<64;3;4Mb` to the source of `createMouseInput` makes the filtered stream yield `ab`.
- [unit] Writing that same chunk emits exactly one `wheelUp` event to a subscriber.
- [unit] Writing `\u001b[<0;10` then `;5M` as two source chunks yields nothing on the filtered stream.
- [unit] Writing `\u001b[<0;10` then `;5M` as two source chunks emits one `press` event at `x: 10, y: 5`.
- [unit] Writing the chunk `\u001b` to the source yields `\u001b` on the filtered stream without waiting for another chunk.
- [unit] Writing `\u001b[<x;1;1M` to the source yields `\u001b[<x;1;1M` unchanged on the filtered stream and emits no event.
- [unit] Writing `\u001b[<66;3;4M` to the source yields nothing on the filtered stream and emits no event.
- [unit] Writing the two Buffer chunks that split the UTF-8 bytes of `é` makes the filtered stream yield `é`.
- [unit] After `setEncoding("utf8")` on the filtered stream, `read()` returns a string.
- [unit] Calling `setRawMode(true)` on the filtered stream calls `setRawMode(true)` on the source.
- [unit] The filtered stream's `isTTY` equals the source's `isTTY`.
- [unit] A listener whose unsubscribe function was called receives no further events.
- [unit] After `dispose()`, writing a report to the source emits no event.

### US-003 — Mouse wiring and wheel scrolling

- [unit] `renderChat` with a TTY stdin writes `ENTER_ALT_SCREEN` before calling `render`.
- [unit] `renderChat` with a TTY stdin writes `ENABLE_MOUSE` after `render` returns.
- [unit] Unmounting the instance `renderChat` returned writes `DISABLE_MOUSE` then `LEAVE_ALT_SCREEN`, each exactly once.
- [unit] Unmounting the instance `renderChat` returned calls the mouse input's `dispose` once.
- [unit] Invoking the registered process-exit handler of a `renderChat` instance that was never unmounted writes `DISABLE_MOUSE` then `LEAVE_ALT_SCREEN`.
- [unit] `renderChat` with a non-TTY stdin writes neither `ENABLE_MOUSE` nor `DISABLE_MOUSE`.
- [unit] Seam: `renderChat` with an injected `createMouseInput` spy calls it once with the injected stdin.
- [unit] Seam: `renderChat` passes the spy's returned `stdin` as the `stdin` option of `render`.
- [unit] Seam: `renderChat` passes the spy's returned `events` as the `mouse` prop of the rendered `ChatApp` element.
- [unit] `reduceViewport` with `{ type: "wheelUp" }` from offset 0 with 100 lines and height 10 returns offset 3 and `follow: false`.
- [unit] `reduceViewport` with `{ type: "wheelDown" }` from offset 2 with 100 lines and height 10 returns offset 0 and `follow: true`.
- [unit] `reduceViewport` with `{ type: "wheelUp" }` from offset 89 with 100 lines and height 10 returns offset 90 (clamped).
- [unit] `TranscriptViewport` given a fake `MouseEvents`, 50 lines labelled `line-0` to `line-49` and height 10 shows `line-37` to `line-46` after one emitted `wheelUp` event.
- [unit] `TranscriptViewport` with `active: false` ignores an emitted `wheelUp` event and keeps showing `line-40` to `line-49`.
- [unit] Seam: `ChatApp` given a fake `mouse` and a transcript longer than its viewport shows an older line after one emitted `wheelUp` event.

### US-004 — Selection and clipboard modules

- [unit] `transcriptPointAt` with `top: 3, height: 10, total: 50, offset: 0, unseen: 0` maps terminal cell `x: 5, y: 4` to `{ line: 40, column: 4 }`.
- [unit] `transcriptPointAt` with the same geometry maps `y: 3` (a header row) to `undefined`.
- [unit] `transcriptPointAt` with the same geometry maps `y: 14` (below the viewport) to `undefined`.
- [unit] `transcriptPointAt` with `total: 4, height: 10, top: 0` maps `y: 1` (a padding row) to `undefined`.
- [unit] `transcriptPointAt` with `total: 4, height: 10, top: 0` maps `y: 7` to line 0.
- [unit] `transcriptPointAt` with `unseen: 2` maps the viewport's last row (the unseen marker) to `undefined`.
- [unit] `selectedText` over lines `hello world` and `second line` with anchor `{ line: 0, column: 6 }` and focus `{ line: 1, column: 5 }` returns `world\nsecond` (the focus cell is included).
- [unit] `selectedText` with focus before anchor returns the same text as with the two points swapped.
- [unit] `selectedText` over a line `a😀b` with a range starting at column 2 (the emoji's second cell) returns text starting with `😀`.
- [unit] `selectedText` trims trailing spaces from each selected line.
- [unit] `highlightLine` returns a line whose spans covering the selected columns carry `inverse: true`.
- [unit] `highlightLine` returns a line whose spans outside the selected columns do not carry `inverse: true`.
- [unit] `highlightLine` for a line index outside the selection returns the line unchanged.
- [unit] `StyledLineView` renders a span with `inverse: true` using Ink's inverse attribute.
- [unit] `osc52("hi")` returns `"\u001b]52;c;aGk=\u0007"`.
- [unit] `copyToClipboard("hi")` with `platform` `"linux"` writes `osc52("hi")`.
- [unit] `copyToClipboard("hi")` with `platform` `"linux"` does not call `spawnCopy`.
- [unit] `copyToClipboard("hi")` with `platform` `"darwin"` calls `spawnCopy` with `"hi"`.
- [unit] `copyToClipboard` resolves when `spawnCopy` rejects.
- [unit] `copyToClipboard` resolves when `spawnCopy` resolves a non-zero exit code.

### US-005 — Drag selection and copy in the screen

- [unit] Seam: `TranscriptViewport` given a fake `MouseEvents`, `top: 0` and a row showing `hello world`, receiving a left `press` at column 1, a left `drag` at column 5 and a left `release` at column 5 on that row, calls `onCopy` exactly once.
- [unit] In that sequence `onCopy` receives `hello`.
- [unit] A left press and release at the same cell does not call `onCopy`.
- [unit] After a completed drag, the selected cells render with the inverse attribute.
- [unit] After a completed drag, the next left press removes the inverse attribute from those cells.
- [unit] A completed drag's highlight survives a re-render with the same number of lines.
- [unit] A completed drag's highlight is removed when the number of transcript lines changes.
- [unit] A left press on a row outside the viewport clears an existing highlight.
- [unit] Seam: a mounted `ChatApp` given a fake `mouse` with `_clipboardDeps.write` stubbed, after a left drag over the absolute screen cells of five transcript characters on the row below the three header rows, passes `osc52` of those five characters to the stubbed `write`.
- [unit] After that copy the footer shows `copied 5 chars`.
- [unit] The `copied` footer hint is gone after the next key press.
- [unit] The `copied` footer hint is gone after the next left press.

### US-006 — `/model` lists catalog and override models

- [unit] `listCatalogModels(["anthropic"])` with an injected catalog holding anthropic models `a1` (supportsTools true) and `a2` (supportsTools false) returns `["anthropic/a1"]`.
- [unit] `listCatalogModels(["p2", "p1"])` returns p2's models before p1's.
- [unit] `listCatalogModels(["nope"])` for a provider the catalog lacks returns `[]`.
- [unit] `listCatalogModels` returns `[]` when the injected `loadProviders` rejects.
- [unit] `tierModels` with tiers `fast: "p1/m1"`, `balanced: "p1/m1"`, `powerful: "p2/m2"` returns `["p1/m1", "p2/m2"]`.
- [unit] `chatModelChoices` with tier `fast: "p1/m1"`, an override `{ provider: "local", models: [{ id: "x", supportsTools: true }] }` and catalog result `["p1/m1", "p1/m3"]` returns `["p1/m1", "local/x", "p1/m3"]`.
- [unit] `chatModelChoices` excludes an override model whose `supportsTools` is false.
- [unit] `chatModelChoices` includes an override model whose provider is not in `availableProviders`.
- [unit] `chatModelChoices` calls `listCatalogModels` with exactly `availableProviders`.
- [unit] `chatModelChoices` returns tiers then overrides when `listCatalogModels` rejects.
- [unit] `createChatHost` given `models: ["a/b", "c/d"]` exposes `host.models` equal to `["a/b", "c/d"]`.
- [unit] Seam: `chatCommand(options, deps)` with tier `fast: "p1/m1"` and an override for provider `local` calls the injected `collectAuthList` with a list containing `p1` and `local`.
- [unit] Seam: `chatCommand(options, deps)` with injected `collectAuthList` reporting providers `p1` (available) and `p2` (not available) calls the injected `listCatalogModels` with `["p1"]`.
- [unit] Seam: the host `chatCommand` creates receives `models` equal to the tier models followed by the injected `listCatalogModels` result.
- [unit] `chatCommand(options, deps)` with an injected `collectAuthList` that rejects creates the host with `models` equal to the tier models.
- [unit] The `/model` picker for a host whose `models` has 20 entries lists the 20th entry after the pointer is moved down 19 times.

### US-007 — `/model` picker filters by name

- [unit] `pickerModel({ kind: "model", models: ["anthropic/claude-x", "openai/gpt-y"], query: "GPT", ... })` returns exactly one entry, `openai/gpt-y`.
- [unit] `pickerModel` with `kind: "model"` and `query: ""` returns every model as an entry.
- [unit] `pickerModel` with `kind: "model"` carries the given `query` on the returned model.
- [unit] `pickerModel` with `kind: "mode"` and `query: "zzz"` still returns both mode entries.
- [unit] `pickerRows` for a `kind: "model"` picker with 3 entries and a budget of 20 is one more than for a `kind: "mode"` picker with 3 entries and no note.
- [unit] `pickerLayout` of a model picker with `query: ""` draws a row reading `type to filter` directly under the title.
- [unit] `pickerLayout` of a model picker with `query: "gp"` draws the row `Filter: gp` directly under the title.
- [unit] `pickerLayout` of a model picker whose filter matches nothing draws the note `no models match`.
- [unit] `useChatPicker`'s `setQuery("gp")` after `open("model")` makes `model.entries` contain only models whose string contains `gp`.
- [unit] `useChatPicker`'s `open("model")` after an earlier `setQuery("gp")` and `cancel()` starts with `query` `""`.
- [unit] Seam: in a mounted `ChatApp` whose host has models `anthropic/claude-x` and `openai/gpt-y`, submitting `/model` then typing `gpt` leaves exactly one entry row, `openai/gpt-y`.
- [unit] After typing `gpt` in that picker, pressing backspace leaves the filter row reading `Filter: gp`.
- [unit] After typing `gpt` in that picker, pressing return switches the host to `openai/gpt-y`.
- [unit] After moving the pointer down once and then typing `a`, the pointer is on the first remaining entry.
- [unit] Typing `zzz` in the model picker and pressing return calls no host switch and keeps the picker open.
- [unit] Pressing escape in a filtered model picker closes it and calls no host switch.
- [unit] Typing in the model picker does not change the chat input's draft.
- [unit] A ctrl-modified letter typed in the model picker leaves the query unchanged.

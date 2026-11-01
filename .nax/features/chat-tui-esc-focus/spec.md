# SPEC: nax chat TUI esc layers, focus, collapsed notices and image follow-ups

## Summary

Make `nax chat` say and do what esc does, show where typing goes, and stop background noise from flooding the transcript. Esc acts on the top layer only: an ask card, then a picker, then the mention or slash menu, then the running turn. Esc on a question card now closes it and declines the question, and stops the running turn when the chat session asked it. The footer and the working line name what esc does at that moment (`esc to close jobs`, `esc to close and stop`, `esc to deny`) instead of always saying `esc to interrupt`. An empty, focused input draws the cursor on the placeholder, and a question card's answer box says what it is. A `[nax-tasks]` or `[nax-jobs]` notice is drawn as one collapsed row (`3 background commands ended · 3 succeeded (ctrl+o to show)`) live and on resume, and the job output the jobs picker prints is collapsed too. Five image-attachment follow-ups from the 2026-11-01 live smoke ship with it: a slash command typed after image placeholders runs and keeps them, a missing image replays at its own number, sizes under 1 KiB print in bytes, a burst of backspaces deletes that many characters (today the bytes are inserted as invisible text), and the session title drops image placeholders.

Approved design: `docs/superpowers/specs/2026-11-01-nax-chat-tui-esc-focus-design.md` (commit `6c6d8f67e`). Spec refinements against that design, decided while grounding: the picker titles do not change (`picker.test.tsx` pins the exact title and the footer already names what esc closes); `/image` keeps taking one path, because splitting would break today's unquoted `my red.png`; the question card's guidance is its input placeholder, not a new row; the esc order follows what is drawn (an ask card renders over a picker, and the menus render only under the input). This is one feature by user ruling (2026-11-01), a bundle of TUI fixes and image follow-ups in one PR; its twelve stories come from one module per story and the 24-assertion gate.

## Motivation

User screenshots of `nax chat` (canary.10/11) and the image-attachments live smoke on main `c5ecc4cff`:

- No sign the input has focus: an empty editor draws only the muted placeholder with no cursor cell (`packages/nax/src/tui/chat/ChatInput.tsx`, `emptyRows`).
- Background notices fill the transcript: `useJobs` delivers each notice through `sendTurn({ message })` (`ChatApp.tsx`, the `deliver` option), so `sentEntries` lays it out as a highlighted `user` entry; replay does the same.
- A question card shows no choices and its answer box looks exactly like the chat input; esc does nothing on it (`AskCard.tsx` returns early from `useInput` for a question).
- The footer and the working line say `esc to interrupt` while a card, picker or menu is up, but `ChatApp.tsx` ignores esc whenever one is shown. Esc does close pickers, but nothing says so.
- The jobs picker's enter prints a job's status and last 40 output lines as a permanent `listing` entry (`useChatPicker.ts`, `showOutput`).
- After `/image a.png` the prompt holds `[Image #1]`, so `/image b.png` typed after it is not a slash line and is sent to the model as text.
- The loader writes a bare `[image missing]` per unreadable image (`packages/nax-agent/src/native/session/transcript-images.ts`), so replay cannot tell which image was lost and renumbers the rest.
- `imageSizeLabel` floors every size below 1 KiB to `1 KB`.
- ink delivers several backspaces arriving in one terminal write as one input string (`"\x7f\x7f\x7f"`, `key.backspace` false); `editLine` inserts it, so the draft holds invisible DEL bytes that are sent to the model.
- The session title is the typed text, `[Image #1] what colour...`.

## Design

### Approach

All behaviour changes are in `packages/nax`, except the missing-image marker in `packages/nax-agent`. New logic goes into small pure modules (`esc-layer.ts`, `notice-summary.ts`, `layout-background.ts`), and the screen files only wire them, so `ChatApp.tsx` (790 lines) grows by wiring only.

**Esc order.** `topEscLayer` reads what is drawn: an ask card (cards render over pickers and the input), then a picker, then the mention picker, then the slash menu, then a running turn. The footer and the working line draw `escHintText(topEscLayer(...))`, and the esc handlers act on the same layer, so the hint and the action cannot disagree. ChatApp passes `turnRunning: turnRunning && keys.canControl()`, `askFromSession: ask.sessionId !== "host"`, `ask` mapped from the pending ask's `type` (`question` → `"question"`, `approval_requested` → `"approval"`, `host_choice` → `"choice"`), `mentionShown: mention.ownsNavigation()` (the mention picker's esc claim, false while only its no-git diagnostic line is drawn) and `menuShown: menuShown()`; a question layer's `stops` is `turnRunning && askFromSession`, which is exactly when the dismiss cancels. The working line's presence is decided as today (from the turn status alone) before the menu rows are measured; only its text takes the esc hint, so the layer can read `menuShown()` without a cycle. The hint texts live in `esc-layer.ts`; `chat-status.ts` (574 lines, under the 600-line gate) only gains the `"layer"` member, `layerHint` and `escHint` parameters, written compactly; if it would pass 600 lines, the hint helpers move into `esc-layer.ts` rather than the gate baseline growing.

| Layer | Esc does (owner) | Hint |
|---|---|---|
| question card | decline the question; then, for a question the chat session asked (not a host question from a run ask or a job, whose `sessionId` is `"host"`), `host.cancel()` when a turn runs and `keys.canControl()` (AskCard via `onDismiss`, ChatApp) | `esc to close and stop` when esc will also cancel, `esc to close` otherwise |
| approval card | deny (unchanged) | `esc to deny` |
| choice card | the card's fallback choice (unchanged) | `esc to cancel` |
| picker | close it (unchanged) | `esc to close model picker` / `sessions` / `mode picker` / `effort picker` / `jobs` |
| mention picker or slash menu | close it (unchanged) | `esc to close menu` |
| running turn | interrupt (unchanged) | none: the footer keeps `esc to interrupt` / its background variants |

**Question decline.** `ChatAskController.declineQuestion(requestId)` settles a host question with `null` (what its timeout does today) and answers a session question with the text `QUESTION_DECLINED_REPLY` (`"The user closed the question without answering."`), then removes it from `pending()`. The question card's `ChatInput` gets `onEscape`, which replaces the input's own esc (the two-press clear) while set.

**Focus.** An empty, active, not-busy input draws the first cell of its placeholder or hint inverse, the rest muted. An inactive or busy input draws no inverse cell. The question card's input placeholder is `type your answer · enter to send`.

**Background notices.** A task line is matched from `[nax-tasks] background command <id> (` to the first `) ended: <state>,` after it, and a job line from `[nax-jobs] job <id> (<kind> <target>) ended: <state>`, `<state>` being the single word after `ended: `. `summarizeBackgroundNotice(text)` (`packages/nax/src/prompts/builders/notice-summary.ts`, beside the builders that write the notices) returns a one-line summary for a notice and `undefined` for any other text. `sentEntries(message)` returns one `{ kind: "background"; summary; text }` entry when the summary is defined, so live sends and replay (`replayUser` calls `sentEntries`) draw the same collapsed row. The model still receives the full notice text: only the transcript entry changes. A `background` entry is collapsible like a skill entry: collapsed it is one muted row `<summary> (ctrl+o to show)`; open it adds every notice line, indented and muted. A click on the summary row toggles it, ctrl+o expands all collapsible entries.

**Job output.** A `listing` entry gains `collapsible?: boolean`. The jobs picker's output listing sets it. A collapsible listing draws its bold title row, then one muted row behind the result prefix (`resultPrefix`, as a skill's line-count row) reading `<n> lines (ctrl+o to show)` when collapsed or `<n> lines (ctrl+o to hide)` when open, and, when open, every text line as today. Every other listing keeps `collapsible` absent and is drawn as today.

**Slash after placeholders.** `splitLeadingPlaceholders(text)` returns `{ lead, rest }` when `text` is one or more `[Image #<digits>]` placeholders and whitespace followed by a line starting with `/`. ChatApp's `submit` treats `rest` as the slash line: the image refusal checks only images whose placeholder is in `rest`, the prompt is written back to `lead` before the command runs, and the command runs as if `rest` had been typed. The image draft is untouched, so `/image b.png` attaches `[Image #2]` after `[Image #1]`.

**Missing images.** The loader appends `[image missing #<n>]`, `<n>` the image's 1-based position in the stored message's `images`. Replay strips both the numbered form and the old bare `[image missing]` from the trailing run of lines. The message's image slots are its loaded images plus its numbered missing markers, in stored order (the missing positions are re-inserted among the loaded images). The first `slots - mentioned` slots are placeholder images (`mentioned` = the `image`-status records in the message's mention envelope, as `sentEntries` counts today); each gets a row numbered by its slot, `imageNoteLabel(n, image)` for a loaded one and `image <n> · missing` for a missing one. A missing slot inside the mention region gets no row, because the mention's attachment row already names that file. A numbered marker beyond the slot count, and every bare marker, gets today's `image · missing` row after the others. A message whose text is empty once the markers are stripped still gets its slot rows (today's early return for empty text keeps only the bare rows). `sentEntries`' skill branch applies the same rule.

**Labels and title.** `imageSizeLabel(bytes)` below 1,024 returns `<bytes> B`. `titleWithoutPlaceholders(text)` removes every `[Image #<digits>]`, collapses runs of whitespace to one space and trims; an empty result is `image`; text with no placeholder is returned unchanged. ChatApp passes it as the `title` of a send that carries images.

**Control bytes.** `editLine` treats an input made only of DEL (`\x7f`) and BS (`\b`) bytes, with no key flag set, as that many backspaces. `insert` first normalises CRLF and a lone CR to a newline (as today), then drops C0 control bytes other than newline and tab, and DEL, from the inserted text.

### Integration

Read-only symbols (verified 2026-11-01 on main `c5ecc4cff`):

- `packages/nax/src/tui/chat/ChatApp.tsx`: `submit(message)` calls `parseSlashCommand(message)`, refuses a slash line with present images through `refuseSlashLine` (notice `IMAGES_PLAIN_ONLY`) and otherwise runs `runCommand(command)`; `restorePrompt(text)`; `sendTurn(composed, prepare?, title = composed.message)` appends `sentEntries(prepared.message, prepared.images)`; `sendMessage` calls `host.send(message, onEvent, { title, images })` when images are present; the esc `useInput` returns when `ask`, `picker.model` or `menuShown()` is set and otherwise calls `host.cancel()` when `turnRunning && keys.canControl()`; `useJobs(host, { deliver: (text) => sendTurn({ message: text }) })`.
- `packages/nax/src/tui/chat/slash-commands.ts`: `parseSlashCommand(text): SlashCommand | null` (null unless `text` starts with `/`); `PickerKind = "model" | "resume" | "mode" | "effort" | "jobs"`.
- `packages/nax/src/tui/chat/ask-card.ts`: `AskCardModel` with `kind` `"approval" | "question" | "choice"`.
- `packages/nax/src/tui/chat/image-draft.ts`: `imagePlaceholder(n)` (`[Image #<n>]`), `imagesForSend(draft, text)`.
- `packages/nax/src/tui/chat/layout-lines.ts`: `SHOW_HINT` (`"(ctrl+o to show)"`), `HIDE_HINT` (`"(ctrl+o to hide)"`), `cardRows`, `resultPrefix`, `cardIndent`.
- `packages/nax/src/prompts/builders/background-builder.ts`: `buildBackgroundTaskNotice` lines `[nax-tasks] background command <id> (<command>) ended: <state>, exit code <code>, log <path>`. `workflow-builder.ts`: `buildJobNotice` first line `[nax-jobs] job <id> (<kind> <target>) ended: <state>...`. `run-ask-builder.ts`: `buildRunAskNotice` first line `[nax-jobs] run ask <askId>`.
- `packages/nax/src/chat/chat-host.ts`: `ChatHost.cancel()`, `ChatHost.asks: ChatAskController`.

Symbols this feature changes. The baseline exists only to locate the code; implement the target.

- `ChatAskController` (`packages/nax/src/chat/ask-controller.ts`)
  - Baseline: no decline method; a question leaves `pending()` only through `answerQuestion` or its timeout.
  - Target: gains `declineQuestion(requestId: string): void`; `QUESTION_DECLINED_REPLY` exported from `@/chat`.
- `ChatInputProps` (`packages/nax/src/tui/chat/ChatInput.tsx`)
  - Target: gains optional `onEscape?: () => void`.
- `AskCardProps` (`packages/nax/src/tui/chat/AskCard.tsx`)
  - Target: gains optional `onDismiss?: () => void`.
- `FooterHint` and `footerModel` (`packages/nax/src/tui/chat/chat-status.ts`)
  - Baseline: `FooterHint = "quit" | "clear" | "busy" | "background" | "backgroundTmux" | "expanded" | "idle" | "copied"`; `footerModel({ state, status, hint, copiedChars?, glyphs?, jobs?, tasks? })`.
  - Target: `FooterHint` gains `"layer"`; `footerModel` input gains `layerHint?: string`, drawn as the hint text when `hint` is `"layer"`.
- `footerHint` (`packages/nax/src/tui/chat/use-clipboard-feedback.ts`)
  - Baseline: input `{ quitArmed, clearArmed, busy, expanded, backgroundable, tmux }`.
  - Target: input gains `layer: boolean`; `"layer"` is returned after `quit` and `clear` and before the busy hints.
- `workingLine` (`packages/nax/src/tui/chat/chat-status.ts`)
  - Baseline: `workingLine(status, nowMs, glyphs)`; the detail ends with `esc to interrupt`.
  - Target: `workingLine(status, nowMs, glyphs, escHint?: string)`; with `escHint` the detail ends with it instead.
- `TranscriptEntry` (`packages/nax/src/tui/chat/transcript-model.ts`)
  - Baseline: `{ kind: "listing"; title: string; text: string }`.
  - Target: gains `{ kind: "background"; summary: string; text: string; open?: boolean }`; the listing member gains `collapsible?: boolean; open?: boolean`.
- `sentEntries(message, images?)` (`packages/nax/src/tui/chat/mention-send.ts`)
  - Target: `sentEntries(message, images?, missing?: readonly number[])`; returns `[{ kind: "background", summary, text: message }]` when `summarizeBackgroundNotice(message)` is defined; `missing` holds 1-based positions of images lost on load.
- `imageSizeLabel(bytes)` (`packages/nax/src/chat/images/image-file.ts`)
  - Baseline: below 1 MiB returns `max(1, floor(bytes / 1024)) KB`.
  - Target: below 1,024 bytes returns `<bytes> B`.
- The transcript loader (`packages/nax-agent/src/native/session/transcript-images.ts`, the schemaVersion 2 read)
  - Baseline: appends `[image missing]` per unreadable image.
  - Target: appends `[image missing #<n>]`.
- `editLine` (`packages/nax/src/tui/chat/line-editor.ts`)
  - Target: a DEL/BS-only input deletes that many code points; inserted text loses C0 controls other than `\n` and `\t`, and DEL.

### Failure Handling

| Case | Behaviour |
|---|---|
| esc on a question card while no turn runs | question declined, card gone, `host.cancel()` not called |
| esc on a question card while a turn runs but `keys.canControl()` is false | question declined, `host.cancel()` not called; the hint reads `esc to close` (ChatApp passes `turnRunning && keys.canControl()`, so this is US-006's `turnRunning: false` case) |
| esc on a host question (a run ask or job asking) while a chat turn runs | question declined (`null`), the chat turn keeps running; the hint reads `esc to close` |
| `declineQuestion` with an id that is not an open question | no effect, no answer sent |
| a notice-looking text that matches no known notice line | `summarizeBackgroundNotice` returns `undefined`; drawn as today's user row |
| a numbered missing-image marker whose position is beyond the message's image slots | drawn as a bare `image · missing` row |
| a numbered missing-image marker inside the mention region | no image row (the mention's attachment row stands) |
| leading placeholders followed by a slash line that itself contains a present placeholder | today's `IMAGES_PLAIN_ONLY` refusal; the whole line goes back to the prompt |
| a DEL/BS run longer than the text before the cursor | deletes back to the start of the text; no error |

## Out of Scope

- Rendering markdown tables (deferred to the next spec by user ruling).
- Changing what esc does on approval cards (deny) and choice cards (fallback choice); neither stops the turn.
- Changing picker titles; the footer names what esc closes.
- Opening the slash menu for a line that starts with image placeholders; the menu opens only for a line that starts with `/`.
- `/image` with several paths in one command; `/image` keeps taking the rest of the line as one path.
- Collapsing slash-command listings (`/jobs`, `/agents`, `/mcp` and the rest); only the jobs picker's output listing is collapsible.
- Changing the text the model receives in a background notice.
- A typed user message that happens to start with a `[nax-tasks]` or `[nax-jobs]` notice line is drawn as a collapsed notice row; accepted.
- DEL or BS bytes mixed with printable text in one input chunk are dropped, not applied as deletions.
- Rewriting transcripts saved by older builds: a bare `[image missing]` keeps its `image · missing` row after the others.
- Reducing `ChatApp.tsx` or `ChatInput.tsx` below the 600-line source limit.
- A mounted-screen test of esc while the keys cannot control the turn (a mode switch in flight); the case is pinned at `topEscLayer` with `turnRunning: false`.
- Task commands containing a newline or the text `) ended:`: such a notice may summarise wrongly or fall back to the user row.
- A line of image placeholders followed by a slash command, submitted while a turn runs: `ChatInput` keeps today's busy rule (only a line starting with `/` is submitted mid-turn), so it is not run until the turn ends.

## Stories

**US-001: Missing-image marker carries its position.** No dependencies. Workdir: `packages/nax-agent`. The schemaVersion 2 transcript read appends `[image missing #<n>]` for each unreadable image.

**US-002: Control bytes in the line editor.** No dependencies. Workdir: `packages/nax`. `editLine` applies a DEL/BS-only chunk as that many backspaces and never inserts C0 controls (other than newline and tab) or DEL.

**US-003: Image size label in bytes and image-free session titles.** No dependencies. Workdir: `packages/nax`. `imageSizeLabel` prints bytes below 1 KiB; `titleWithoutPlaceholders` in `image-draft.ts`; ChatApp passes it as the title of a send with images.

**US-004: Missing images replay at their numbers.** Depends on US-001. Workdir: `packages/nax`. `replayUser` reads numbered and bare markers; `sentEntries` takes the missing positions and draws `image <n> · missing` in place.

**US-005: Slash commands after image placeholders.** No dependencies. Workdir: `packages/nax`. `splitLeadingPlaceholders` in `image-draft.ts`, and ChatApp's `submit` running the slash line after the placeholders and writing them back.

**US-006: The esc layer and its hints.** No dependencies. Workdir: `packages/nax`. New `src/tui/chat/esc-layer.ts` (`EscLayer`, `topEscLayer`, `escHintText`), the footer's `layer` hint and `workingLine`'s `escHint`.

**US-007: Declining a question.** No dependencies. Workdir: `packages/nax`. `ChatAskController.declineQuestion` and `QUESTION_DECLINED_REPLY`.

**US-008: Input focus cursor and an owner's esc.** No dependencies. Workdir: `packages/nax`. The inverse cursor cell on an empty active input's placeholder, and `ChatInput`'s optional `onEscape`.

**US-009: Esc and hints in the chat screen.** Depends on US-006, US-007, US-008. Workdir: `packages/nax`. AskCard's `onDismiss` and the question input's placeholder, ChatApp's question close-and-stop, and the footer and working line fed from `topEscLayer`.

**US-010: Background notice summaries.** No dependencies. Workdir: `packages/nax`. New `src/prompts/builders/notice-summary.ts` with `summarizeBackgroundNotice`, exported from `@/prompts`.

**US-011: Collapsed background notice rows.** Depends on US-010. Workdir: `packages/nax`. The `background` transcript entry, its layout in new `src/tui/chat/layout-background.ts`, click and ctrl+o toggling, and `sentEntries` returning it live and on replay.

**US-012: Collapsed job output from the jobs picker.** Depends on US-011. Workdir: `packages/nax`. `listing.collapsible`, its collapsed layout and toggle, and the jobs picker's output listing setting it.

### Context Files

**US-001**
- `packages/nax-agent/src/native/session/transcript-images.ts`
- `packages/nax-agent/test/unit/native/session/transcript-images-read.test.ts`

**US-002**
- `packages/nax/src/tui/chat/line-editor.ts`
- `packages/nax/test/unit/tui/chat/line-editor.test.ts`
- `packages/nax/src/tui/chat/ChatInput.tsx`

**US-003**
- `packages/nax/src/chat/images/image-file.ts`
- `packages/nax/src/tui/chat/image-draft.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/test/ui/chat/chat-app-image-send.test.tsx`

**US-004**
- `packages/nax/src/tui/chat/history-replay.ts`
- `packages/nax/src/tui/chat/mention-send.ts`
- `packages/nax/test/unit/tui/chat/image-entries.test.ts`
- `packages/nax-agent/src/native/session/transcript-images.ts`

**US-005**
- `packages/nax/src/tui/chat/image-draft.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/test/ui/chat/chat-app-image-command.test.tsx`

**US-006**
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/src/tui/chat/use-clipboard-feedback.ts`
- `packages/nax/src/tui/chat/ask-card.ts`
- `packages/nax/test/unit/tui/chat/chat-status.test.ts`

**US-007**
- `packages/nax/src/chat/ask-controller.ts`
- `packages/nax/test/unit/chat/ask-controller.test.ts`
- `packages/nax/src/chat/index.ts`

**US-008**
- `packages/nax/src/tui/chat/ChatInput.tsx`
- `packages/nax/test/ui/chat/chat-input.test.tsx`

**US-009**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/AskCard.tsx`
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/src/tui/chat/use-clipboard-feedback.ts`
- `packages/nax/src/tui/chat/esc-layer.ts` — created by US-006, wired here

**US-010**
- `packages/nax/src/prompts/builders/background-builder.ts`
- `packages/nax/src/prompts/builders/workflow-builder.ts`
- `packages/nax/src/prompts/builders/run-ask-builder.ts`
- `packages/nax/src/prompts/index.ts`

**US-011**
- `packages/nax/src/tui/chat/layout.ts`
- `packages/nax/src/tui/chat/transcript-click.ts`
- `packages/nax/src/tui/chat/mention-send.ts`
- `packages/nax/test/ui/chat/task-notices.test.tsx`
- `packages/nax/src/prompts/builders/notice-summary.ts` — created by US-010, read here

**US-012**
- `packages/nax/src/tui/chat/layout-listing.ts`
- `packages/nax/src/tui/chat/useChatPicker.ts`
- `packages/nax/src/tui/chat/transcript-click.ts`
- `packages/nax/test/ui/chat/jobs-picker.test.tsx`

### Creates

**US-001**
- None.

**US-002**
- None.

**US-003**
- None.

**US-004**
- None.

**US-005**
- `packages/nax/test/ui/chat/chat-app-placeholder-commands.test.tsx`

**US-006**
- `packages/nax/src/tui/chat/esc-layer.ts`
- `packages/nax/test/unit/tui/chat/esc-layer.test.ts`

**US-007**
- None.

**US-008**
- `packages/nax/test/ui/chat/chat-input-focus.test.tsx`

**US-009**
- `packages/nax/test/ui/chat/chat-app-esc-layers.test.tsx`

**US-010**
- `packages/nax/src/prompts/builders/notice-summary.ts`
- `packages/nax/test/unit/prompts/builders/notice-summary.test.ts`

**US-011**
- `packages/nax/src/tui/chat/layout-background.ts`
- `packages/nax/test/unit/tui/chat/layout-background.test.ts`

**US-012**
- None.

### Modifies

**US-001**
- `packages/nax-agent/src/native/session/transcript-images.ts` — the schemaVersion 2 read appends `[image missing #<n>]` (1-based position in the stored `images`) instead of `[image missing]`.
- `packages/nax-agent/test/unit/native/session/transcript-images-read.test.ts` — the load assertions that expect a bare `[image missing]` line now expect `[image missing #<n>]` with the lost image's position; the invariant is unchanged otherwise (one line per lost image, no leading newline on empty content, the readable images kept in order).

**US-002**
- `packages/nax/src/tui/chat/line-editor.ts` — `editLine` handles a DEL/BS-only input as repeated backspace, and `insert` strips C0 controls other than newline and tab, and DEL.

**US-003**
- `packages/nax/src/chat/images/image-file.ts` — `imageSizeLabel` returns `<bytes> B` below 1,024 bytes.
- `packages/nax/src/tui/chat/image-draft.ts` — new export `titleWithoutPlaceholders`.
- `packages/nax/src/tui/chat/ChatApp.tsx` — a send with images passes `titleWithoutPlaceholders(title)` as its title.
- `packages/nax/test/unit/chat/images/image-file.test.ts` — the `[100, "1 KB"]` case becomes `[100, "100 B"]` and the `imageNoteLabel(1, { data: "AAAA" })` expectation becomes `"image 1 · png · 3 B"`; sizes of 1,024 bytes and above keep their KB and MB labels.
- `packages/nax/test/unit/chat/mentions/mention-expand-images.test.ts` — notes of its real PNG and JPEG fixture files read `<n> B`, `<n>` that fixture file's byte length, instead of `1 KB`; every other part of the note is unchanged.
- `packages/nax/test/unit/tui/chat/image-entries.test.ts` — labels of its `data: "AAAA"` fixture images read `3 B` instead of `1 KB` (for example `image 1 · png · 2×3 · 3 B · clipboard`), and the hand-written `image · png · 2×3 · 1 KB` mention note may stay as written; the comment naming the `1 KB` floor goes; row order and kinds are unchanged.
- `packages/nax/test/ui/chat/chat-app-image-after-send.test.tsx` — `LABEL` reads `image 1 · png · 2×3 · 3 B · clipboard` (its `data: "AAAA"` fixture) instead of `... 1 KB ...`.

**US-004**
- `packages/nax/src/tui/chat/history-replay.ts` — strip numbered and bare missing-image markers and pass the numbered positions to `sentEntries`.
- `packages/nax/src/tui/chat/mention-send.ts` — `sentEntries` gains the optional `missing` positions and draws `image <n> · missing` rows in place.

**US-005**
- `packages/nax/src/tui/chat/image-draft.ts` — new export `splitLeadingPlaceholders`.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `submit` runs a slash line that follows image placeholders and writes the placeholders back to the prompt first.

**US-006**
- `packages/nax/src/tui/chat/chat-status.ts` — `FooterHint` gains `"layer"`, `footerModel` takes `layerHint`, and `workingLine` takes an optional `escHint`.
- `packages/nax/src/tui/chat/use-clipboard-feedback.ts` — `footerHint` takes `layer` and returns `"layer"` after quit and clear and before the busy hints.
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — `footerHint` calls that build the input object gain `layer: false`, with the same expected hints; no expected text changes.

**US-007**
- `packages/nax/src/chat/ask-controller.ts` — `declineQuestion` on the interface and the class, and `QUESTION_DECLINED_REPLY`.
- `packages/nax/src/chat/index.ts` — export `QUESTION_DECLINED_REPLY`.
- `packages/nax/test/ui/chat/ask-card.test.tsx` — the hand-built `ChatAskController` literal gains `declineQuestion: () => {}`; no assertion changes.
- `packages/nax/test/ui/chat/chat-app.test.tsx` — the hand-built host's `asks` literal gains `declineQuestion: () => {}`; no assertion changes.
- `packages/nax/test/ui/chat/chat-app-mentions.test.tsx` — the hand-built host's `asks` literal gains `declineQuestion: () => {}`; no assertion changes.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the hand-built host's `asks` literal gains `declineQuestion: () => {}`; no assertion changes.

**US-008**
- `packages/nax/src/tui/chat/ChatInput.tsx` — the empty-editor rows carry the inverse cursor cell when active and not busy, and the optional `onEscape` replaces the esc clear-arm while set.

**US-009**
- `packages/nax/src/tui/chat/AskCard.tsx` — optional `onDismiss`, passed to the question input as `onEscape`, and the question input's placeholder `type your answer · enter to send`, passed both to that `ChatInput` as `hint` and to `askCardLayout`'s `inputRows` call so the measured rows match the drawn ones.
- `packages/nax/src/tui/chat/ChatApp.tsx` — the question card's `onDismiss` (decline, then cancel when a turn runs and the keys can control it), and `topEscLayer` feeding `footerHint`, `footerModel`'s `layerHint` and `workingLine`'s `escHint`.

**US-010**
- `packages/nax/src/prompts/index.ts` — export `summarizeBackgroundNotice`.

**US-011**
- `packages/nax/src/tui/chat/transcript-model.ts` — the `background` member of `TranscriptEntry`.
- `packages/nax/src/tui/chat/layout.ts` — `layoutEntry` dispatches `background` to `backgroundLines`, and `cachedLines` treats it as collapsible (`open ?? expanded`).
- `packages/nax/src/tui/chat/transcript-click.ts` — a click on a `background` entry's summary row toggles it.
- `packages/nax/src/tui/chat/mention-send.ts` — `sentEntries` returns the `background` entry for a notice.

**US-012**
- `packages/nax/src/tui/chat/transcript-model.ts` — the listing member gains `collapsible?` and `open?`.
- `packages/nax/src/tui/chat/layout-listing.ts` — a collapsible listing's collapsed rows.
- `packages/nax/src/tui/chat/layout.ts` — `cachedLines` treats a collapsible listing as collapsible.
- `packages/nax/src/tui/chat/transcript-click.ts` — a click on a collapsible listing's title row toggles it.
- `packages/nax/src/tui/chat/useChatPicker.ts` — `showOutput` sets `collapsible: true` on the output listing.
- `packages/nax/test/ui/chat/jobs-opener.test.tsx` — the `AC-19` test (enter on a task row, then `line2` in the transcript) presses ctrl+o after enter before reading the output; its title and picker-closed assertions are unchanged.
- `packages/nax/test/ui/chat/jobs-picker.test.tsx` — the `AC-10` test (`job log` under the job's `label · state` title), the `AC-8` test (output lines `line1` and `line2` under the `label · state` title) and the `AC-11` test (`(no output yet)`) press ctrl+o after enter before reading the output rows, because the output listing now starts collapsed; the title-row and `tasks.output` / `jobs.logTail` call assertions are unchanged.

### Seams

- US-001 → US-004: replay reads the `[image missing #<n>]` lines the loader writes (US-004 replay ACs feed the loader's format as stored content).
- US-006 → US-009: the mounted chat screen draws `escHintText(topEscLayer(...))` in the footer and the working line (US-009 footer and working-line ACs, entering at stdin with a card, picker or menu up).
- US-007 → US-009: esc on a mounted question card calls `host.asks.declineQuestion` (US-009 esc ACs, entering at stdin).
- US-008 → US-009: the question card's input routes esc to `onDismiss` through `onEscape` (US-009 esc ACs).
- US-010 → US-011: `sentEntries` calls `summarizeBackgroundNotice` (US-011 ACs entering at a delivered notice in the mounted screen and at `replayHistory`).

## Acceptance Criteria

### US-001

1. [unit] Loading a schemaVersion 2 transcript whose user message has content `"x"` and two stored images, the second of whose files is missing, returns that message with content `"x\n[image missing #2]"` and `images` holding only the first image.
2. [unit] Loading a schemaVersion 2 transcript whose user message has content `"x"` and two stored images, both missing, returns content `"x\n[image missing #1]\n[image missing #2]"` and no `images` key.
3. [unit] Loading a schemaVersion 2 transcript whose user message has empty content and two stored images, the first missing, returns content `"[image missing #1]"` with no leading newline and `images` holding only the second image.
4. [unit] Loading a schemaVersion 2 transcript whose user message has three stored images, the second missing, returns `images` holding the first and the third in that order and content ending `"\n[image missing #2]"`.
5. [unit] Loading a schemaVersion 2 transcript whose stored images are all readable returns the content unchanged, with no missing-image line.

### US-002

1. [unit] `editLine` on editor `{ text: "abcd", cursor: 4 }` with input `"\x7f\x7f\x7f"` and no key flag set returns an edit to `{ text: "a", cursor: 1 }`.
2. [unit] `editLine` on editor `{ text: "abcd", cursor: 2 }` with input `"\b\b\b"` and no key flag set returns an edit to `{ text: "cd", cursor: 0 }`, deleting only back to the start.
3. [unit] `editLine` on editor `{ text: "abcd", cursor: 4 }` with input `"\x7f\b"` and no key flag set returns an edit to `{ text: "ab", cursor: 2 }`.
4. [unit] `editLine` on editor `{ text: "", cursor: 0 }` with input `"\x7f\x7f"` returns an edit whose state is `{ text: "", cursor: 0 }`.
5. [unit] `editLine` on an empty editor with input `"a\u0001b\u007fc"` returns an edit to `{ text: "abc", cursor: 3 }`.
6. [unit] `editLine` on an empty editor with input `"a\tb\nc"` returns an edit to `{ text: "a\tb\nc", cursor: 5 }`, keeping the tab and the newline.
7. [unit] `editLine` on an empty editor with input `"a\u001b[0mb"` returns an edit whose text is `"a[0mb"`, the ESC byte dropped.
8. [unit] `editLine` on an empty editor with input `"\r\n"` still inserts one newline (`{ text: "\n", cursor: 1 }`), as today.
9. [unit] `editLine` on an empty editor with input `"a\rb"` returns an edit to `{ text: "a\nb", cursor: 3 }`: a lone CR still becomes a newline before control bytes are dropped.
10. [integration] Rendering `ChatInput` with draft text `"abcd"` and writing `"\x7f\x7f\x7f"` to its stdin in one write publishes a draft whose editor text is `"a"`.

### US-003

1. [unit] `imageSizeLabel(178)` returns `"178 B"`, `imageSizeLabel(0)` returns `"0 B"` and `imageSizeLabel(1023)` returns `"1023 B"`.
2. [unit] `imageSizeLabel(1024)` returns `"1 KB"`, `imageSizeLabel(1536)` returns `"1 KB"` and `imageSizeLabel(350_208)` returns `"342 KB"`.
3. [unit] `imageSizeLabel(1_572_864)` returns `"1.5 MB"`, as today.
4. [unit] `imageNoteLabel(1, { mimeType: "image/png", data: "AAAA" })` returns `"image 1 · png · 3 B"`.
5. [unit] `titleWithoutPlaceholders("[Image #1] what colour is it")` returns `"what colour is it"`.
6. [unit] `titleWithoutPlaceholders("compare [Image #1]  and   [Image #2] now")` returns `"compare and now"`.
7. [unit] `titleWithoutPlaceholders("[Image #1][Image #2]")` returns `"image"`.
8. [unit] `titleWithoutPlaceholders("  two  spaces  ")`, a text with no placeholder, returns `"  two  spaces  "` unchanged.
9. [integration] In the mounted chat screen with a host whose `acceptsImages()` resolves `true`, attaching a clipboard image through ctrl+v (with `_imageAttachDeps.readClipboard` stubbed to return a PNG) and submitting `"[Image #1] what colour"` calls `host.send` with a third argument whose `title` is `"what colour"` and whose `images` holds that one image.
10. [integration] In the mounted chat screen, submitting the plain message `"hello"` with no image still calls `host.send("hello", onEvent)` with two arguments.

### US-004

1. [unit] `replayHistory` of a stored user message `{ content: "[Image #1] then [Image #2]\n[image missing #1]", images: [red] }` (red a PNG with source `"clipboard"`) returns the user entry with text `"[Image #1] then [Image #2]"`, then `{ kind: "image", label: "image 1 · missing" }`, then the image entry whose label is `imageNoteLabel(2, red)`.
2. [unit] `replayHistory` of a stored user message `{ content: "x\n[image missing #2]", images: [a] }` returns the user entry `"x"`, the image entry labelled `imageNoteLabel(1, a)`, then `{ kind: "image", label: "image 2 · missing" }`.
3. [unit] `replayHistory` of a stored user message `{ content: "x\n[image missing]", images: [a] }` (the bare marker of an older build) returns the user entry `"x"`, the image entry labelled `imageNoteLabel(1, a)`, then `{ kind: "image", label: "image · missing" }`, as today.
4. [unit] `replayHistory` of a stored user message `{ content: "x\n[image missing #5]", images: [a] }` (a position beyond the message's two image slots) returns the user entry `"x"`, the image entry labelled `imageNoteLabel(1, a)`, then `{ kind: "image", label: "image · missing" }`.
5. [unit] `replayHistory` of a stored user message whose content is only `"[image missing #1]"` and that has no images returns exactly `[{ kind: "image", label: "image 1 · missing" }]`.
6. [unit] `replayHistory` of a stored user message `{ content: "[image missing #1]", images: [b] }` returns exactly `{ kind: "image", label: "image 1 · missing" }` then the image entry labelled `imageNoteLabel(2, b)`.
7. [unit] `sentEntries("look", [a, b], [2])` returns the user entry `"look"`, the image entry labelled `imageNoteLabel(1, a)`, `{ kind: "image", label: "image 2 · missing" }`, then the image entry labelled `imageNoteLabel(3, b)`.
8. [unit] `sentEntries("look", [a])` with no `missing` argument returns the same entries as today: the user entry, then the image entry labelled `imageNoteLabel(1, a)`.
9. [unit] `replayHistory` of a stored user message whose content is a mention envelope with one `image`-status record and whose content ends `"\n[image missing #1]"`, with no stored images, returns exactly the envelope's mention entries: the one slot is in the mention region, so no image row is added.
10. [integration] Saving a schemaVersion 2 transcript through `createFileTranscriptStore` (from `@nathapp/nax-agent`) whose user message `"[Image #1] and [Image #2]"` carries two different PNG images (a 2×3 and a 4×5, so their content-addressed files differ), deleting the file named by the second stored image's `ref` from the transcript's `.images` folder, loading it again and passing the loaded history to `replayHistory` returns the user entry, the image entry labelled `imageNoteLabel(1, first)`, then `{ kind: "image", label: "image 2 · missing" }`.
11. [unit] `sentEntries` of a skill invocation message with images `[a]` and `missing` `[1]` returns the skill entry, then `{ kind: "image", label: "image 1 · missing" }`, then the image entry labelled `imageNoteLabel(2, a)`.

### US-005

1. [unit] `splitLeadingPlaceholders("[Image #1] /image b.png")` returns `{ lead: "[Image #1] ", rest: "/image b.png" }`.
2. [unit] `splitLeadingPlaceholders("[Image #1]/image b.png")` returns `{ lead: "[Image #1]", rest: "/image b.png" }`.
3. [unit] `splitLeadingPlaceholders(" [Image #1] [Image #2] /model x")` returns `{ lead: " [Image #1] [Image #2] ", rest: "/model x" }`.
4. [unit] `splitLeadingPlaceholders("/image b.png")` returns `undefined`.
5. [unit] `splitLeadingPlaceholders("look [Image #1] /image b.png")` returns `undefined`, because text other than placeholders comes before the slash.
6. [unit] `splitLeadingPlaceholders("[Image #1] hello")` returns `undefined`.
7. [integration] In the mounted chat screen, after `/image red.png` attaches (the prompt then reads `"[Image #1]"`), typing `/image green.png` after the placeholder and pressing return attaches a second image: the prompt reads `"[Image #1][Image #2]"` and nothing is sent to `host.send`.
8. [integration] In the mounted chat screen with one attached image, submitting `"[Image #1] /model other-model"` calls the host's model switch with `"other-model"`; typing `describe` and pressing return afterwards calls `host.send` with the message `"[Image #1] describe"` and that one image, because the placeholder and the image draft were kept.
9. [integration] In the mounted chat screen with one attached image, submitting `"[Image #1] /model x [Image #1]"` runs no command, appends the `IMAGES_PLAIN_ONLY` notice and writes the whole line back to the prompt.
10. [integration] In the mounted chat screen with one attached image, submitting `"[Image #1] /quit"` closes the chat as `/quit` does.

### US-006

1. [unit] `topEscLayer({ ask: "question", askFromSession: true, picker: "jobs", mentionShown: true, menuShown: true, turnRunning: true })` returns `{ kind: "question", stops: true }`, because a card is drawn over everything else.
2. [unit] `topEscLayer({ ask: "question", askFromSession: true, mentionShown: false, menuShown: false, turnRunning: false })` returns `{ kind: "question", stops: false }`.
3. [unit] `topEscLayer({ ask: "question", askFromSession: false, mentionShown: false, menuShown: false, turnRunning: true })` (a host question during a turn) returns `{ kind: "question", stops: false }`.
4. [unit] `topEscLayer` with `ask: "approval"` returns `{ kind: "approval" }`, and with `ask: "choice"` returns `{ kind: "choice" }`.
5. [unit] `topEscLayer({ picker: "jobs", mentionShown: true, menuShown: true, turnRunning: true })` returns `{ kind: "picker", picker: "jobs" }`.
6. [unit] `topEscLayer({ mentionShown: true, menuShown: false, turnRunning: true })` returns `{ kind: "menu" }`, and so does `topEscLayer({ mentionShown: false, menuShown: true, turnRunning: false })`.
7. [unit] `topEscLayer({ mentionShown: false, menuShown: false, turnRunning: true })` returns `{ kind: "turn" }`, and with `turnRunning: false` returns `{ kind: "none" }`.
8. [unit] `escHintText({ kind: "question", stops: true })` returns `"esc to close and stop"` and `escHintText({ kind: "question", stops: false })` returns `"esc to close"`.
9. [unit] `escHintText({ kind: "approval" })` returns `"esc to deny"` and `escHintText({ kind: "choice" })` returns `"esc to cancel"`.
10. [unit] `escHintText` for picker `"model"`, `"resume"`, `"mode"`, `"effort"` and `"jobs"` returns `"esc to close model picker"`, `"esc to close sessions"`, `"esc to close mode picker"`, `"esc to close effort picker"` and `"esc to close jobs"`.
11. [unit] `escHintText({ kind: "menu" })` returns `"esc to close menu"`; for `{ kind: "turn" }` and `{ kind: "none" }` it returns `undefined`.
12. [unit] `footerHint({ quitArmed: false, clearArmed: false, busy: true, expanded: false, backgroundable: true, tmux: false, layer: true })` returns `"layer"`.
13. [unit] `footerHint` with `quitArmed: true` and `layer: true` returns `"quit"`, and with `clearArmed: true` and `layer: true` returns `"clear"`.
14. [unit] `footerModel({ ..., hint: "layer", layerHint: "esc to close jobs" })` draws a left line whose hint text is `"esc to close jobs"` after the mode label.
15. [unit] `workingLine(runningStatus, nowMs, glyphs, "esc to close and stop")` returns a line whose muted detail ends `"esc to close and stop)"`, the escape hint taking the place of `esc to interrupt`.
16. [unit] `workingLine(runningStatus, nowMs, glyphs)` with no `escHint` returns the same detail as today, ending `"esc to interrupt)"`.

### US-007

1. [unit] On a controller holding a host question opened with `requestHostQuestion({ text: "Use that feature?" })`, `declineQuestion(requestId)` resolves that request's promise with `null` and `pending()` no longer lists it.
2. [unit] On a controller that received a session `question` event, `declineQuestion(requestId)` calls the controller's `answer` option once with `(requestId, { text: QUESTION_DECLINED_REPLY })` and `pending()` no longer lists it.
3. [unit] `QUESTION_DECLINED_REPLY` is importable from `@/chat` and equals `"The user closed the question without answering."`.
4. [unit] `declineQuestion` with the id of an open approval leaves the approval in `pending()` and calls no `answer`.
5. [unit] `declineQuestion` with an unknown id calls no `answer` and changes nothing in `pending()`.
6. [unit] A listener registered with `onChange` is called once when `declineQuestion` removes an open question.

### US-008

1. [integration] Rendering an active, not-busy `ChatInput` with an empty draft draws the placeholder's first character as the inverse cell (inside the SGR 7 / SGR 27 pair) and the rest of the placeholder outside it.
2. [integration] Rendering an inactive (`active: false`) `ChatInput` with an empty draft draws no inverse cell.
3. [integration] Rendering an active `ChatInput` with an empty draft and `busy: true` draws no inverse cell and no placeholder, as today.
4. [integration] Rendering an active `ChatInput` with an empty draft and `hint: "esc again to clear"` draws the hint's first character `e` as the inverse cell.
5. [integration] Rendering an active `ChatInput` with draft `"abc"` and the cursor at 1 still draws `b` as the inverse cell.
6. [integration] A `ChatInput` rendered with `onEscape` set and draft `"abc"` calls `onEscape` once when esc is written to stdin, and the draft is still `"abc"` after a second esc within the double-press window (no clear).
7. [integration] A `ChatInput` rendered with `onEscape` set and an empty draft calls `onEscape` once when esc is written to stdin.
8. [integration] A `ChatInput` rendered without `onEscape` and draft `"abc"` still clears the draft on two esc presses within the double-press window, as today.

### US-009

1. [integration] In the mounted chat screen with a running turn and an open session question (a `question` event from the session), writing esc to stdin calls `host.asks.declineQuestion` with the question's request id and then `host.cancel()` once.
2. [integration] In the mounted chat screen with no running turn and an open host question, writing esc calls `host.asks.declineQuestion` with its request id and does not call `host.cancel()`.
3. [integration] In the mounted chat screen with a running turn and an open host question (`sessionId` `"host"`), the footer's hint ends with `esc to close` and is not `esc to close and stop`, and writing esc calls `host.asks.declineQuestion` with its request id and does not call `host.cancel()`.
4. [integration] In the mounted chat screen with a running turn and the `@` mention picker showing only its no-git diagnostic line (no file rows), the footer shows `esc to interrupt`, and writing esc calls `host.cancel()` once.
5. [integration] In the mounted chat screen with an open choice card, the footer shows `esc to cancel`, and writing esc resolves the card with its fallback choice as today.
6. [integration] In the mounted chat screen with a typed answer `"yes"` in an open question card, writing esc declines the question (no `answerQuestion` call) instead of arming the clear.
7. [integration] In the mounted chat screen with an open question card and no typed answer, the card's input row reads `type your answer · enter to send`.
8. [integration] In the mounted chat screen with a running turn and an open question card, the footer's last row shows the hint `esc to close and stop` in the place where `esc to interrupt` is drawn when nothing is open.
9. [integration] In the mounted chat screen with a running turn and an open question card, the working line's detail ends with `esc to close and stop)` in place of `esc to interrupt)`.
10. [integration] In the mounted chat screen with no running turn and an open question card, the footer's hint ends with `esc to close` and is not `esc to close and stop`.
11. [integration] In the mounted chat screen with an open approval card, the footer contains `esc to deny`, and writing esc denies the approval as today.
12. [integration] In the mounted chat screen with the jobs picker open (ctrl+g), the footer contains `esc to close jobs`; writing esc closes the picker and the footer no longer contains it.
13. [integration] In the mounted chat screen with the model picker open (`/model`), the footer contains `esc to close model picker`.
14. [integration] In the mounted chat screen with the slash menu open (prompt `"/mo"`), the footer contains `esc to close menu`.
15. [integration] In the mounted chat screen with a running turn and nothing open, the footer contains `esc to interrupt`, and writing esc calls `host.cancel()` once, as today.
16. [integration] In the mounted chat screen with a running turn and the jobs picker open, writing esc closes the picker and does not call `host.cancel()`.

### US-010

1. [unit] `summarizeBackgroundNotice` of `buildBackgroundTaskNotice` for three tasks that all ended `succeeded` returns `"3 background commands ended · 3 succeeded"`.
2. [unit] `summarizeBackgroundNotice` of `buildBackgroundTaskNotice` for one task that ended `failed` returns `"1 background command ended · 1 failed"`.
3. [unit] `summarizeBackgroundNotice` of `buildBackgroundTaskNotice` for two tasks, the first `succeeded` and the second `failed`, returns `"2 background commands ended · 1 succeeded · 1 failed"`, counts in first-seen order.
4. [unit] `summarizeBackgroundNotice` of `buildJobNotice` for job kind `run`, target `chat-x` and state `succeeded` returns `"nax job run chat-x ended · succeeded"`.
5. [unit] `summarizeBackgroundNotice` of `buildJobNotice` for job kind `plan`, target `chat-y`, state `failed` and a `chainId` (which adds the chain line) returns `"nax job plan chat-y ended · failed"`.
6. [unit] `summarizeBackgroundNotice` of `buildRunAskNotice("ask-7", request)` returns `"run ask ask-7 sent to the agent"`.
7. [unit] `summarizeBackgroundNotice("hello")` returns `undefined`.
8. [unit] `summarizeBackgroundNotice("[nax-tasks] something else")` returns `undefined`, because no line matches a known notice line.
9. [unit] `summarizeBackgroundNotice` is importable from `@/prompts`.

### US-011

1. [unit] `sentEntries` of a `buildBackgroundTaskNotice` text for three succeeded tasks returns exactly `[{ kind: "background", summary: "3 background commands ended · 3 succeeded", text }]`, `text` the whole notice.
2. [unit] `sentEntries("hello")` still returns `[{ kind: "user", text: "hello" }]`.
3. [unit] `backgroundLines` of a collapsed `background` entry (`open` absent, layout `expanded: false`) returns one muted row behind the result prefix reading `<summary> (ctrl+o to show)`.
4. [unit] `backgroundLines` of a `background` entry laid out with `expanded: true` returns the summary row ending `(ctrl+o to hide)` followed by one indented muted row per notice line.
5. [unit] `layoutTranscript` of a `background` entry with `open: true` and layout `expanded: false` draws the open form, and with `open: false` and `expanded: true` draws the collapsed form.
6. [unit] `toggleTranscriptLine` on the summary row of a collapsed `background` entry returns entries where that entry has `open: true`; on an open entry's notice-line row it returns the entries unchanged.
7. [unit] `replayHistory` of a stored user message whose content is the `buildJobNotice` text for kind `run`, target `chat-x` and state `succeeded` returns one `background` entry with summary `"nax job run chat-x ended · succeeded"` and no `user` entry.
8. [integration] In the mounted chat screen, a background task that ends while the chat is idle delivers its notice: `host.send` receives the full notice text, and the transcript shows the collapsed row `1 background command ended · 1 succeeded (ctrl+o to show)` and none of the notice's `[nax-tasks]` lines.
9. [integration] In the mounted chat screen after that delivery, ctrl+o shows the notice's `[nax-tasks] background command ...` line in the transcript.

### US-012

1. [unit] `listingLines` of `{ kind: "listing", title: "bash-1 · succeeded", text: "a\nb\nc", collapsible: true }` laid out with `expanded: false` returns the bold title row and one muted row behind the result prefix reading `3 lines (ctrl+o to show)`.
2. [unit] `listingLines` of the same entry laid out with `expanded: true` returns the title row, the muted row `3 lines (ctrl+o to hide)`, and the rows `a`, `b` and `c`.
3. [unit] `listingLines` of a listing with one text line and `collapsible: true`, collapsed, returns the title row and `1 line (ctrl+o to show)`.
4. [unit] `listingLines` of a listing without `collapsible`, laid out with `expanded: false`, returns the title row and every text line, as today.
5. [unit] `toggleTranscriptLine` on the title row of a collapsed collapsible listing returns entries where that listing has `open: true`; on the title row of a listing without `collapsible` it returns the entries unchanged.
6. [unit] `layoutTranscript` of a collapsible listing with `open: true` and layout `expanded: false` draws every text line.
7. [integration] In the mounted chat screen, choosing a finished task in the jobs picker with enter adds a listing whose title row reads `<label> · <state>` and whose next row reads `<n> lines (ctrl+o to show)`, and none of the task's output lines are drawn.
8. [integration] In the mounted chat screen after that, ctrl+o draws the task's output lines.

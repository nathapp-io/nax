# nax chat TUI: esc layers, focus, collapsed notices, image follow-ups

Date: 2026-11-01. Status: DRAFT for user approval.
Source: user screenshots `tui-01.png` (finish run, background commands) and `tui-02.png`
(question card, canary.10), plus the image-attachments live smoke of 2026-11-01. Root causes
checked on main `c5ecc4cff`.

## 1. Problems

| # | What the user sees | Cause (main `c5ecc4cff`) |
|---|---|---|
| T1 | No sign the input has focus | An empty editor draws only the muted placeholder, no cursor cell (`ChatInput.tsx` `emptyRows`); `borderFocus` and `border` are close in colour |
| T2 | `[nax-tasks] ... ended` notices fill the transcript as a highlighted user message | `useJobs` delivers every background notice through `sendTurn({ message })` (`ChatApp.tsx:589`), so it is laid out as a `user` entry; replay does the same from the stored user message |
| T4 | A question card shows no choices; its answer box looks like the main input; esc does nothing | A `question` ask is free text by design. Its inner `ChatInput` has no label. `AskCard` `useInput` returns early for a question, so esc is ignored |
| T5 | Footer says `esc to interrupt` while a card is up | `footerHint` knows nothing about cards, pickers or menus; `ChatApp.tsx:318` ignores esc whenever one is shown |
| T6 | No visible way to close a picker or card | Esc closes pickers (verified live on the jobs picker) and denies approvals, but no picker header and no footer says so; approvals mention esc only inside the "No" option |
| T7 | A job's output opened from the jobs picker cannot be put away | Enter appends a `listing` entry with the status and last 40 lines (`useChatPicker.ts:170`); `listing` has no `open` state |
| F1 | A second `/image` in one message is impossible | After `/image a.png` the prompt holds `[Image #1]`, so `/image b.png` typed after it is not a slash line and is sent to the model as text |
| F2 | Replay after a missing image renumbers the survivors | The loader appends a bare `[image missing]` line per missing image (`transcript-images.ts:198`), losing its position; replay appends `image · missing` rows last |
| F3 | A 178-byte image is labelled `1 KB` | `imageSizeLabel` floors to at least 1 KB (`image-file.ts:57`) |
| F4 | Several backspaces in one terminal write delete one character | ink parses a chunk as one keypress; only a lone `\x7f` is `backspace`. Whether the rest is dropped or inserted as invisible control bytes is to be confirmed by the spec writer |
| F5 | Session title keeps `[Image #1] ...` | The title is the submitted text (`ChatApp.tsx` `sendTurn` `title = composed.message`) |

Out of scope, deferred to the next spec by user ruling: **markdown tables (T3)**.

## 2. Esc: one rule, top layer first

Esc acts on the top layer only, in this order:

1. mention menu: close it (unchanged)
2. slash menu: close it (unchanged)
3. picker: close it (unchanged behaviour, now hinted)
4. ask card:
   - **question**: close the card **and stop the turn** (user ruling 2026-11-01). The question is
     settled as declined: a host question settles `null` (today's timeout result); a session
     question is answered with a fixed decline text and removed; then `host.cancel()` when a
     turn is running.
   - **approval**: deny (unchanged)
   - **choice**: the card's fallback choice (unchanged)
5. running turn: interrupt (unchanged)
6. idle with a draft: the existing two-press clear (unchanged)

The footer always names what esc does now. `FooterHint` gains `menu` (`esc to close`),
`picker` (`esc to close <picker name>`), `question` (`esc to close and stop`), `approval`
(`esc to deny`) and `choice` (`esc to <fallback label>`). Precedence: `copied` > `quit` >
`clear` > the top layer's hint > `busy`/`background` > `expanded` > `idle`. The decision moves
out of `ChatApp.tsx` (790 lines, grandfathered over the 600 cap; it must not grow) into a pure
`esc-layer.ts`: `topLayer(state)` and `escHint(layer)`, used both by the footer and by the esc
handler, so the hint and the action can never disagree.

Picker headers gain `esc close` beside their other keys (e.g.
`Jobs and tasks · enter output · ctrl+x stop · esc close`).

## 3. Focus (T1, T4)

- Empty, active, not busy input: the first placeholder cell is drawn as the inverse cursor
  (Claude Code's look). Inactive input: no cursor cell, muted border. Busy: unchanged.
- The question card's answer box gets a muted label row above it:
  `your answer · enter to send · esc to close and stop`. The card's title row stays
  `nax asks`, so the box can no longer be mistaken for the chat input.

## 4. Background notices collapse (T2, T7)

- New transcript entry `{ kind: "background"; summary: string; text: string; open?: boolean }`,
  collapsed by default. Collapsed: one muted row, e.g.
  `⎿ 3 background commands ended · 3 succeeded (ctrl+o to show)`; a job notice reads
  `1 nax job ended · run chat-x · succeeded`. Open: the full notice text.
  Click on the row toggles it (existing `toggleTranscriptLine`), ctrl+o expands all (existing).
- `useJobs` delivery sends the same text to the model (unchanged) but `sendTurn` records the
  `background` entry instead of the `user` entry. One option on `ComposedSend`
  (`display: "background"`), no new send path.
- The summary is derived from the notice lines by a pure parser that lives beside the
  builders that write them (`src/prompts/builders/`), so the format has one owner:
  `parseBackgroundNotice(text)` returns `undefined` for anything that is not a notice.
- Replay: a stored user message for which `parseBackgroundNotice` succeeds replays as the same
  collapsed entry. (**Claude** call: a user typing a message that starts `[nax-tasks]` would
  replay collapsed; acceptable.)
- `listing` gains `open?: boolean`. The jobs picker's output listing starts collapsed
  (`⎿ bash-940f13f5 · succeeded · 40 lines (ctrl+o to show)`); slash-command listings
  (`/jobs`, `/agents`, ...) keep today's always-open rows.

## 5. Image follow-ups (F1-F5)

- **F1** A slash line may follow image placeholders: when the prompt is only
  `[Image #N]` placeholders and whitespace followed by `/command ...`, the command runs and the
  placeholders are written back to the prompt afterwards. `/image` also takes several paths
  (`/image a.png "b c.png"`), each attached in order. (**Claude** call: leading placeholders are
  allowed for every command, not only `/image`, so `/model` mid-draft no longer drops images.)
- **F2** nax-agent's loader writes `[image missing #<n>]`, `<n>` = the image's 1-based position
  in the stored message. Replay strips both forms (the old bare `[image missing]` still
  appends last, for transcripts loaded by older builds) and draws each image row at its
  original number. This is the only nax-agent change.
- **F3** `imageSizeLabel` below 1 KiB prints bytes: `178 B`.
- **F4** The line editor treats an input chunk made only of DEL/BS bytes as that many
  backspaces, and never inserts C0 or DEL control bytes as text.
- **F5** The session title drops image placeholders and collapses whitespace; a message of only
  placeholders is titled `image`.

## 6. Non-goals

- Markdown tables (next spec).
- Changing what approval or choice cards do on esc.
- A dismiss key for notices other than background ones.
- Any change to what the model receives in a background notice.

## 7. Delivery

One feature, `chat-tui-esc-focus`, all in `packages/nax` except the F2 loader line in
`packages/nax-agent`. Expected split at spec time (24-AC gate): esc-layer model + footer hints;
esc handler + question close-and-stop; focus cursor + answer label; background entry + send
option + replay; listing collapse; image F1; image F2-F5. Spec next via spec-writing, two
spec-review passes, then `nax plan` (needs approval).

## 8. Decision log

- 2026-11-01 user: fold image findings in; tables deferred to the next spec; question card esc =
  close and stop the turn, footer `esc to close and stop`.
- Claude calls: approval/choice esc unchanged; placeholders allowed before any slash command;
  replay collapses any stored user message that parses as a background notice; F2 changes the
  missing-image marker to carry its position.

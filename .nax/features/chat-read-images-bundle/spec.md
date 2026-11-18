# SPEC: chat-read-images-bundle — Read returns images to vision models, chat auto-wake has no limit by default, the Bash tool says the notice wakes the agent, and the footer strip looks clickable

## Summary

Four chat improvements in one bundle. (1) The native agent's `Read` tool returns a PNG, JPEG, GIF or WebP file as an image in its tool result, so a model that accepts image input sees the picture; a text-only model gets a one-line note instead. The image travels through the tool runtime, the turn loop, the request image cap, compaction estimates, the saved transcript and the nax-ai wire mapping, none of which carry an image on a tool result today. The magic-byte sniffer moves from `packages/nax` into `packages/nax-agent` so `Read` can use it, and `packages/nax` re-exports it. `nax run` and hop agents get the same images through their interaction handler. (2) `interaction.defaults.chatTaskNoticeTurns` defaults to `0`, and `0` now means no limit: ended background tasks keep waking the chat agent until the user stops it; a positive value is still a cap. (3) The native `Bash` tool's background sentence adds the fact that the end notice wakes the agent, so it has no need to wait or poll. (4) The footer's job and task strip (`1 shell`, `1 agent`, `run <feature> 2/5`) is drawn underlined in the accent colour, so it reads as clickable.

## Motivation

Seen in `nax chat` on 0.92.7 (screenshots, 2026-11-18):

1. **The agent cannot look at an image.** Asked to check a screenshot, a vision-capable model answered that no tool feeds an image into its input and fell back to computing pixel statistics with Bash. `Read` (`packages/nax-agent/src/tools/read.ts`) reads UTF-8 text only. The image-attachments work (#2758, #2759) lets the user attach images to a user message; nothing lets the agent read one itself. pi-ai 1.5.0 (the version nax-ai pins) already accepts `ImageContent` in a `toolResult` message (`ToolResultMessage.content: (TextContent | ImageContent)[]`), and its OpenAI completions, OpenAI responses and Google providers already route tool-result images on vision models; nax's own types drop the image at every seam before it gets there.
2. **Auto-wake pauses after three task turns.** `useJobs` (`packages/nax/src/tui/chat/use-jobs.ts`) holds an ended task's notice after `MAX_CONSECUTIVE_TASK_NOTICE_TURNS` (3) task-woken turns in a row without a user message, and prints `background task ended · auto-wake paused after 3 task turns in a row · send a message to continue`. The guard came from the chat-effort-and-background spec (#2735) as a stated rule with no recorded incident behind it; #2816 made it visible and configurable. An agent working through a chain of background tasks the user approved stops at the fourth. User ruling (2026-11-18): no limit by default, and `0` means no limit.
3. **The agent polls a background command with `sleep`.** Running `nax bot review` in the background, the model then ran `sleep 285; echo waited` in the foreground, repeatedly, for over an hour. The Bash tool already says `a notice arrives when the command ends`, but not that the notice wakes the agent, so it waited by hand. User ruling: state the fact in the tool description (agent-neutral wording in the `nax-finish` skill is a separate change in the skills repo).
4. **The footer strip does not look clickable.** A left click on the strip already opens the lone shell's output or the jobs picker (#2952, `footerStripHit` in `tui/chat/use-jobs-opener.ts`), but the strip is drawn as plain text, the same as the model name beside it. User ruling: underline and a different colour.

## Design

### Approach

**US-001 — nax-ai: a tool result can carry images.** The `tool-result` variant of `ConversationMessage` (`packages/nax-ai/src/protocols/types.ts`) gains `readonly images?: readonly ImageAttachment[]`, the type user messages already use. `toPiMessages` (`packages/nax-ai/src/protocols/pi-client.ts`, reached through `toPiContext(req, model)`, which the module exports and tests import by path) maps a tool result with a non-empty `images` list to pi-ai content `[{ type: "text", text: content }, ...images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))]` when `model.input` includes `"image"`. When the model does not accept image input, the images are left out and one note line per image is appended to the text: `[image not shown: this model does not accept image input (image/png 1280x720)]`, or `(image/png)` when width or height is absent. Only `type`, `data` and `mimeType` reach the wire; `width`, `height` and `source` never do. A result with no images, or `images: []`, maps exactly as today. This is the one place nax decides vision support for a tool-result image, so a session that switches to a text-only model mid-conversation degrades the same way.

**US-002 — nax-agent: tool-result images reach the request.** Each seam that today copies only `content` carries `images` too:

- `ToolResult` (`tools/registry.ts`) gains `readonly images?: readonly ImageAttachment[]`.
- `CodingToolOutcome`'s `ok` / `error` arm (`tools/runtime.ts`) gains `readonly images?: readonly ImageAttachment[]`. `callTool`'s success path puts `result.images` on the outcome when `kind` is `"ok"` and the list is non-empty, on both the immediate and the `deferModelTruncation` return. An `"error"` outcome never carries images. `runtime.ts` is 599 lines against the 600-line source cap, and `runTool` is baselined at complexity 24 in `packages/nax-agent/scripts/baselines/complexity-baseline.json` (strict limit 20): the story moves the outcome assembly into a helper module and puts the images conditional there, so neither the file nor `runTool` grows; if the extraction lowers `runTool`'s score, the baseline entry is lowered to match.
- `AdapterInteractionResponse` (`session/interaction-handler.ts`) gains `images?: readonly ImageAttachment[]`; `answerFor` (`session/session-interaction.ts`) copies a non-empty `outcome.images`.
- In `turn-tool-batch.ts` the `after_tool` event still shapes `content` only (its patch whitelist stays `["content", "isError"]`); the images ride beside it: `buildToolResult` gains `images?` and spreads it in only when non-empty, the same absent-stays-absent rule `isError` follows. `ToolResultMessage` and the second `tool-result` arm of `TranscriptMessage` (`native/session/compaction.ts`) gain `readonly images?: readonly ImageAttachment[]`. The error path (`catch`) builds its result without images.
- `capRequestImages` (`native/session/image-context.ts`) counts tool-result images with user images in one newest-first pass against `MAX_REQUEST_IMAGES` and `MAX_REQUEST_IMAGE_BASE64_CHARS`; a dropped tool-result image becomes the note `[image from an earlier turn dropped from context: <mimeType>]` appended to that tool result's content, as for a user image.
- `imagesAsNotes` turns tool-result images into `[image: <mimeType> <w>x<h>]` lines appended to the tool result's content, as it does for user images.
- `estimateTokens` (`compaction.ts`) counts a tool result's images with the same per-image estimate it uses for a user message, through one `imageTokens(images)` helper both arms call (it scores 14 today; copying the loop would push it near the limit).
- `capRequestImages` scores 17 against the strict limit of 20: its per-message keep/drop step moves into a helper shared by the user and tool-result arms. Every new helper scores 20 or less, and no new complexity-baseline entry is created for `image-context.ts` or `compaction.ts`.

Embedder tools (`runEmbedderTool`) keep answering `{ answer: result.content }`.

**US-003 — nax-agent: tool-result images persist.** `splitTranscriptImages` and `rehydrateTranscriptImages` (`native/session/transcript-images.ts`) visit `tool-result` messages as well as `user` messages: a tool result's images are published to the same `<file>.images/` sidecar by content hash and stored as refs, the document is written with `schemaVersion: 2`, and loading rehydrates them inline. A document whose only images are on tool results is still split. A tool-result image whose sidecar file is missing is dropped on load and the same numbered line user messages get, `[image missing #<n>]`, is appended to that tool result's content, numbered by the existing `notedSlots` / `slotOf` logic; the tool-result stored arm goes through the same rehydrate loop as the user arm. `rehydrateTranscriptImages` scores exactly 20 (the strict limit) and has no baseline entry, so the per-message hydrate body (building `images`, the `notedSlots` / `slotOf` marker) moves into a helper scoring 20 or less, leaving `rehydrateTranscriptImages` no higher than today; no baseline entry is created for `transcript-images.ts`. A document with no images on any message is written unchanged, as today.

**US-004 — nax-agent: `Read` returns images; the sniffer moves; the Bash sentence.**

- New `packages/nax-agent/src/session/image-sniff.ts` holds `sniffImage`, `SniffedImage` and `ImageFormat` exactly as `packages/nax/src/chat/images/image-sniff.ts` defines them today (moved, not rewritten), exported from the `@nathapp/nax-agent` root beside the `image-input` constants.
- `Read` checks the file's leading bytes before its text path. When they match an image signature it returns an image result instead of text; any other file is read exactly as today. The decision is by bytes, never by file name. `readPrefix` decodes UTF-8 and cannot carry image bytes, so `packages/nax-agent/src/internal/bounded-io.ts` gains `readBytesPrefix(path, maxBytes): Promise<{ bytes: Uint8Array; size: number }>`: the same non-blocking open and regular-file check as `readPrefix` (a FIFO or a directory fails with `READ_NOT_REGULAR_FILE` as today), at most `maxBytes` bytes read, and `size` taken from the open handle's `stat`. The module's header comment, which says both helpers return up to `maxBytes + 1` bytes, is updated to describe `readBytesPrefix`, which returns at most `maxBytes`. The image branch lives in a new `packages/nax-agent/src/tools/read-image.ts` as `readImageResult(target, input, hasOffset, hasLimit): Promise<ToolResult | undefined>`, which never throws: a header or file read error (including `READ_NOT_REGULAR_FILE`) is returned as an `isError` result carrying the error's message. `readTool.run` scores 19 against the strict cognitive-complexity limit of 20, so its single call (`const image = await readImageResult(...); if (image !== undefined) return image;`) sits outside its `try`, after the credential refusal and after `parseRange` (an unsupported range alias such as `start_line` is still rejected first, image or not), and before the text branches; `readImageResult` itself stays at or under 20. Procedure: read a header of `IMAGE_HEADER_BYTES` (65,536) with `readBytesPrefix` and run `sniffImage` on it; no match means the text path. On a match, refuse when `size` is over 3,932,160; otherwise read the whole file (`readBytesPrefix(path, size)`) and run `sniffImage` on all of it for the dimensions. The image branch does not apply `ctx.maxFileBytes` (2,000,000 by default) or `readCeiling`; the image limit replaces them. Dimensions are kept only when both width and height are positive integers. An image result:
  - content `[image: <mimeType> <w>x<h>, <n> bytes]`, where `<n>` is the length of the whole-file read (the bytes that are base64-encoded), (`[image: <mimeType>, <n> bytes]` when the header gives no size, or a width or height that is not a positive integer, in which case the image entry has no `width` or `height`), `images: [{ mimeType, data: <base64 of the whole file>, width?, height?, source: <the path as given> }]`, not an error;
  - a file larger than `(MAX_IMAGE_BASE64_CHARS / 4) * 3` bytes (3,932,160) is an error with content `image too large to view: <n> bytes (limit 3932160)` and no images;
  - `offset` or `limit` on an image is an error with content `offset/limit apply to text files; "<path>" is an <mimeType> image`.
  - The credential read refusal still runs first, unchanged.
- `Read`'s description gains the sentence `PNG, JPEG, GIF and WebP files are returned as images.`, inserted immediately before its closing `Output is capped at ...` sentence, so it still starts with `Read a UTF-8 text file from the repository.` and still ends with `Output is capped at 1000 lines or 40000 bytes.`
- `withBackgroundSentence` (`tools/bash-background.ts`) appends `Set "runInBackground": true to return at once with a task id; when the command ends, a notice wakes you with its result, so there is no need to wait or poll.` in place of today's sentence.

**US-005 — nax: auto-wake has no limit by default.** `chatTaskNoticeTurns` keeps its schema range (integer 0–100) and changes its default from 3 to 0 in `InteractionConfigSchema` (`config/schemas-infra.ts`) and in the `interaction` default object (`config/schemas.ts`). `MAX_CONSECUTIVE_TASK_NOTICE_TURNS` becomes 0. In `useJobs`, a limit of 0 never holds a task notice; a positive limit holds as today. `taskNoticeHeldLine(limit)` keeps only its `auto-wake paused after <limit> task turns in a row` form; the `auto-wake is off` form is removed, because no setting turns auto-wake off any more. The field description becomes `Ended background-task notices that may wake the chat agent in a row before the user sends a message (0 = no limit)`.

**US-006 — nax: the strip looks clickable.** `Span` (`tui/chat/styled-line.tsx`) gains `readonly underline?: boolean`, and `spanProps` passes it to Ink's `Text` `underline` prop. The strip's span is drawn `{ text, color: "accent", underline: true }` in every place it is built: `rightSegments` (`tui/chat/footer-segments.ts`), the summarised replacement in `summarised` (`tui/chat/status-layout.ts`, text `<n> active (ctrl+g)`) and `footerModel` (`tui/chat/chat-status.ts`). The separator after the strip and every other footer span keep their style. The strip's text and width do not change, so `stripWidth` and the click hit-test are unaffected. `sameStyle` and `styleOf` in `tui/chat/wrap.ts` enumerate the style keys; both gain `underline`, so a span that is wrapped, cut or merged keeps it.

**US-007 — nax: `nax run` and hop agents pass the images on.** `buildRunInteractionHandler` (`packages/nax/src/agents/run-interaction-handler.ts`) maps a `CodingToolOutcome` to `{ answer: outcome.content, finalizeAudit? }`; it also copies a non-empty `outcome.images` onto the response through a helper `imagesField(outcome)` in the same file (`{ images }` when non-empty, `{}` otherwise; scoring 20 or less), so the call site gains only `...imagesField(outcome)`. `onInteraction` is baselined at 52 in `packages/nax/scripts/baselines/complexity-baseline.json`, and the helper keeps it from growing, so a `Read` of an image in a `nax run` story or a hop session reaches the model the same way it does in chat.

**US-008 — nax: one sniffer.** `packages/nax/src/chat/images/index.ts` re-exports `sniffImage`, `SniffedImage` and `ImageFormat` from `@nathapp/nax-agent`; `image-file.ts` imports `sniffImage` from `@nathapp/nax-agent`; `packages/nax/src/chat/images/image-sniff.ts` and its test file are deleted (the test cases moved to nax-agent in US-004). `@/chat`'s exports keep their names, so `use-image-attach.ts` and `mention-expand.ts` are unchanged.

### Test placement

- nax-ai: `packages/nax-ai/test/protocols/pi-client-images.test.ts` (existing, user-image mapping) takes the tool-result cases.
- nax-agent: `packages/nax-agent/test/unit/native/session/image-context.test.ts`, `image-compaction.test.ts`, `transcript-images-write.test.ts`, `transcript-images-read.test.ts`, `turn-tool-batch.test.ts` and `packages/nax-agent/test/unit/tools/runtime.test.ts` (existing) take the US-002 and US-003 cases, and new `packages/nax-agent/test/unit/native/session-adapter-tool-images.test.ts` takes US-002's turn-level cases; new `packages/nax-agent/test/unit/tools/read-image.test.ts` and `packages/nax-agent/test/unit/session/image-sniff.test.ts` take US-004's.
- nax: `packages/nax/test/ui/chat/task-notices.test.tsx`, `packages/nax/test/unit/config/schemas-infra.test.ts`, `packages/nax/test/unit/tui/chat/footer-segments.test.ts`, `status-layout.test.ts`, `chat-status-tasks.test.ts` and `packages/nax/test/unit/agents/run-interaction-handler.test.ts` (existing).

### Integration

Symbols this feature only reads:

- `IMAGE_MIME_TYPES`, `MAX_IMAGE_BASE64_CHARS` (5,242,880), `MAX_REQUEST_IMAGES` (20), `MAX_REQUEST_IMAGE_BASE64_CHARS` (20,971,520), `IMAGE_TOKEN_ESTIMATE` — `packages/nax-agent/src/session/image-input.ts`, exported from `@nathapp/nax-agent`.
- `ImageAttachment { mimeType; data; width?; height?; source? }` — `packages/nax-ai/src/protocols/types.ts:123`, re-exported by nax-agent as a type.
- `credentialReadRefusal`, `readPrefix` — used by `Read` today.
- `footerStripHit`, `stripWidthOf` — the click hit-test, unchanged.

Symbols this feature changes. Each baseline exists only to locate the code; the target is the interface to implement.

- `ConversationMessage` tool-result arm. Baseline: `{ role: "tool-result"; toolCallId: string; content: string; isError?: boolean }`. Target: adds `readonly images?: readonly ImageAttachment[]`.
- `ToolResult` (`packages/nax-agent/src/tools/registry.ts:21`). Baseline: `{ content; isError?; audit?; resultBytesPreTruncation?; truncated? }`. Target: adds `readonly images?: readonly ImageAttachment[]`.
- `CodingToolOutcome` ok/error arm (`tools/runtime.ts:64`). Baseline: `{ kind: "ok" | "error"; content; sandbox?; finalizeAudit? }`. Target: adds `readonly images?: readonly ImageAttachment[]`, set only on `"ok"`.
- `AdapterInteractionResponse` (`session/interaction-handler.ts:35`). Target: adds `images?: readonly ImageAttachment[]`.
- `ToolResultMessage`, `BuildToolResultArgs`, `buildToolResult` (`native/session/tool-result.ts`). Target: both types add `images?`; `buildToolResult` spreads `images` only when non-empty.
- `TranscriptMessage` second arm (`native/session/compaction.ts:24`). Target: adds `readonly images?: readonly ImageAttachment[]`.
- `capRequestImages`, `imagesAsNotes` (`native/session/image-context.ts`), `estimateTokens` (`compaction.ts`). Target: also read `tool-result` images.
- `splitTranscriptImages`, `rehydrateTranscriptImages` (`native/session/transcript-images.ts`). Target: also visit `tool-result` messages; `StoredMessage` gains a tool-result arm with `images?: readonly StoredImage[]`.
- `readTool.description`, `readTool.run` (`tools/read.ts`). Target: image branch as above, through `read-image.ts`.
- `bounded-io.ts`. Target: adds `readBytesPrefix`; `readPrefix` is unchanged.
- `buildRunInteractionHandler` (`packages/nax/src/agents/run-interaction-handler.ts`). Target: copies a non-empty `outcome.images`.
- `withBackgroundSentence` (`tools/bash-background.ts:172`). Target: the new sentence.
- `MAX_CONSECUTIVE_TASK_NOTICE_TURNS`, `taskNoticeHeldLine`, `useJobs` (`packages/nax/src/tui/chat/use-jobs.ts`). Target: constant 0; held line has one form; limit 0 never holds.
- `chatTaskNoticeTurns` default (`config/schemas-infra.ts:117`, `config/schemas.ts:318`), `FIELD_DESCRIPTIONS["interaction.defaults.chatTaskNoticeTurns"]` (`cli/config-descriptions.ts:285`).
- `Span`, `spanProps` (`tui/chat/styled-line.tsx`); `rightSegments` (`footer-segments.ts`); `summarised` (`status-layout.ts`); `footerModel` (`chat-status.ts`, near line 300).

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Image file over 3,932,160 bytes | `Read` error `image too large to view: <n> bytes (limit 3932160)`, no images. |
| `offset`/`limit` on an image | `Read` error `offset/limit apply to text files; "<path>" is an <mimeType> image`. |
| Model does not accept image input | nax-ai sends the text plus one `[image not shown: ...]` note per image; no image part. |
| Too many images in one request | `capRequestImages` drops the oldest, tool-result or user, with a dropped-from-context note. |
| Sidecar image missing on load | Image dropped, `[image missing #<n>]` appended to that tool result. |
| FIFO or directory passed to `Read` | `READ_NOT_REGULAR_FILE` error, as today, from the header read. |
| Header gives a zero or missing dimension | Image result without `width`/`height`; content omits the size. |
| Tool run throws or returns `isError` | Result carries no images. |

## Out of Scope

- ACP sessions (Claude Code, Codex, opencode through nax): they read images with their own tools; nothing in `packages/nax-agent-acp` changes.
- Images from tools other than `Read` (Bash output, MCP tool results, embedder tools): only `Read` produces tool-result images.
- Resizing or re-encoding an image that is over the size limit: it is refused with an error, not shrunk.
- PDF, SVG, BMP, TIFF and HEIC files: only PNG, JPEG, GIF and WebP are images to `Read`; other files take the text path as today.
- Showing tool-result images in the chat TUI transcript: the Read card shows the result's text line only.
- A setting that turns chat auto-wake off entirely: `0` now means no limit, and no value means never.
- Live views of a running shell, a background shell or a subagent run (a shell details panel, a full subagent chat view): separate work.
- The Linux srt placeholder files (`.zshrc`, `.profile`, ...): tracked as #2986.
- Reading a transcript that has tool-result images with a build older than this feature: such a build passes the stored tool-result image refs through without `data`; the schema version stays 2.
- The `nax-finish` skill's wording about background commands: changed in the nax-toolkit-skills repo, not in this feature.

## Stories

### US-001 — nax-ai maps tool-result images to the wire

Workdir: packages/nax-ai. No dependencies.

Add `images?` to the `tool-result` arm of `ConversationMessage` and map it in `toPiMessages`: image parts after the text on a model whose `input` includes `"image"`, one `[image not shown: ...]` note line per image otherwise.

### US-002 — nax-agent carries tool-result images from the tool to the request

Workdir: packages/nax-agent. Depends on US-001.

Add `images?` to `ToolResult`, the `CodingToolOutcome` ok arm, `AdapterInteractionResponse`, `ToolResultMessage` / `buildToolResult` and the `TranscriptMessage` tool-result arm, and copy it at each seam; count tool-result images in `capRequestImages`, `imagesAsNotes` and `estimateTokens`. Keep `tools/runtime.ts` at or under 600 lines and `runTool` at or under its complexity baseline.

### US-003 — nax-agent saves and loads tool-result images

Workdir: packages/nax-agent. Depends on US-002.

Extend `splitTranscriptImages` and `rehydrateTranscriptImages` to tool-result messages, sharing the existing sidecar and schema version.

### US-004 — nax-agent Read returns images, the sniffer moves in, and the Bash sentence names the wake

Workdir: packages/nax-agent. Depends on US-002.

Move `sniffImage` into `src/session/image-sniff.ts` and export it from the package root; add `readBytesPrefix` and `Read`'s image branch in `tools/read-image.ts`, and the description sentence; replace `withBackgroundSentence`'s sentence.

### US-005 — chat auto-wake has no limit by default

Workdir: packages/nax. No dependencies.

Default `chatTaskNoticeTurns` and `MAX_CONSECUTIVE_TASK_NOTICE_TURNS` to 0, make 0 mean no limit in `useJobs`, drop the `auto-wake is off` held line, and update the field description.

### US-006 — the footer strip is drawn underlined in the accent colour

Workdir: packages/nax. No dependencies.

Add `underline` to `Span`, Ink rendering and the `wrap.ts` style helpers, and draw the strip span `color: "accent", underline: true` in `rightSegments`, `summarised` and `footerModel`.

### US-007 — `nax run` and hop agents pass tool-result images on

Workdir: packages/nax. Depends on US-002.

Copy a non-empty `outcome.images` onto the response in `buildRunInteractionHandler`.

### US-008 — packages/nax uses the nax-agent sniffer

Workdir: packages/nax. Depends on US-004.

Re-export the sniffer from `@nathapp/nax-agent` in `chat/images/index.ts`, import it in `image-file.ts`, and delete `chat/images/image-sniff.ts` and its test. Deletion-only apart from the two import lines; verified by `bun run typecheck` in `packages/nax`.

### Context Files

**US-001**
- `packages/nax-ai/src/protocols/types.ts`
- `packages/nax-ai/src/protocols/pi-client.ts`
- `packages/nax-ai/test/protocols/pi-client-images.test.ts`

**US-002**
- `packages/nax-agent/src/tools/runtime.ts`
- `packages/nax-agent/src/session/session-interaction.ts`
- `packages/nax-agent/src/native/session/turn-tool-batch.ts`
- `packages/nax-agent/src/native/session/image-context.ts`
- `packages/nax-agent/src/native/session/compaction.ts`
- `packages/nax-agent/test/unit/native/session-adapter-abort-reasons.test.ts`

**US-003**
- `packages/nax-agent/src/native/session/transcript-images.ts`
- `packages/nax-agent/src/native/session/transcript-store.ts`
- `packages/nax-agent/test/unit/native/session/transcript-images-write.test.ts`
- `packages/nax-agent/test/unit/native/session/transcript-images-read.test.ts`

**US-004**
- `packages/nax/src/chat/images/image-sniff.ts`
- `packages/nax-agent/src/internal/bounded-io.ts`
- `packages/nax/test/unit/chat/images/image-sniff.test.ts`
- `packages/nax-agent/src/tools/read.ts`
- `packages/nax-agent/src/tools/bash-background.ts`
- `packages/nax-agent/src/index.ts`

**US-005**
- `packages/nax/src/tui/chat/use-jobs.ts`
- `packages/nax/src/config/schemas-infra.ts`
- `packages/nax/src/config/schemas.ts`
- `packages/nax/src/cli/config-descriptions.ts`
- `packages/nax/test/ui/chat/task-notices.test.tsx`

**US-006**
- `packages/nax/src/tui/chat/styled-line.tsx`
- `packages/nax/src/tui/chat/footer-segments.ts`
- `packages/nax/src/tui/chat/status-layout.ts`
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/src/tui/chat/wrap.ts`

**US-007**
- `packages/nax/src/agents/run-interaction-handler.ts`
- `packages/nax/test/unit/agents/run-interaction-handler.test.ts`

**US-008**
- `packages/nax/src/chat/images/index.ts`
- `packages/nax/src/chat/images/image-file.ts`

### Creates

**US-002**
- `packages/nax-agent/test/unit/native/session-adapter-tool-images.test.ts`

**US-004**
- `packages/nax-agent/src/tools/read-image.ts`
- `packages/nax-agent/src/session/image-sniff.ts`
- `packages/nax-agent/test/unit/session/image-sniff.test.ts`
- `packages/nax-agent/test/unit/tools/read-image.test.ts`

### Modifies

**US-001**
None. No existing test builds a tool-result message with images, and a tool result without images maps exactly as before.

**US-002**
- `packages/nax-agent/scripts/baselines/complexity-baseline.json` — the `runTool` entry for the tool runtime module is baselined at 24; if moving the outcome assembly into a helper lowers its score, the entry is lowered to the new score (an improved function keeps no slack), and no other entry changes.

**US-003**
None. Existing transcript tests use documents whose tool results carry no images, and those are written and read exactly as before.

**US-004**
- `packages/nax-agent/api/nax-agent.api.txt` — the names-only public snapshot of the `.` entry gains `ImageFormat`, `SniffedImage` and `sniffImage`; regenerated with `bun run api:update` from the nax-agent package directory. `ToolResult`, `CodingToolOutcome` and `AdapterInteractionResponse` appear by name only, so their new fields change nothing else.
- `packages/nax-agent/test/unit/tools/bash-background.test.ts` — the expected sentence constant at line 66 pins `a notice arrives when the command ends.`; it becomes `Set "runInBackground": true to return at once with a task id; when the command ends, a notice wakes you with its result, so there is no need to wait or poll.`, and the assertions that use it are otherwise unchanged.

**US-005**
- `packages/nax/test/ui/chat/task-notices.test.tsx` — the three tests at lines 139-155, 156-172 and 173-184 mount without a `taskNoticeTurns` and expect a fourth notice to be held, relying on the old default of 3; they mount with `taskNoticeTurns` 3 explicitly, and their expectations are unchanged.
- `packages/nax/test/ui/chat/task-notices.test.tsx` — the two tests that mount with `taskNoticeTurns` 0 to mean "hold every notice" ("a taskNoticeTurns of 0 never wakes the agent but still announces the held notice" at lines 194-199, and "a marked output read retires a held notice" at about line 580) now get no limit; each mounts with `taskNoticeTurns` 1 after one task-woken turn so the guard holds, and references to taskNoticeHeldLine(0) in them become taskNoticeHeldLine(1). The steer tests "AC-23/24" and "AC-14" keep `taskNoticeTurns` 0 and still pass; the vacuous taskNoticeHeldLine(0) check in "AC-14" (about line 470) becomes taskNoticeHeldLine(1).
- `packages/nax/test/unit/chat/chat-host.test.ts` — `exposes the configured chat task-notice turn limit (#2816)` expects `host.taskNoticeTurns` 3 from the default config; it expects 0.
- `packages/nax/src/config/runtime-types.ts` — the comment on `chatTaskNoticeTurns` at line 244 says `(default: 3)`; it says `(default: 0 = no limit)`. Comment only.
- `packages/nax/test/unit/config/schemas-infra.test.ts` — the default assertions at lines 148-149 expect `chatTaskNoticeTurns` 3; they expect 0. The range assertions are unchanged.

**US-006**
None. No existing test pins the strip span's style keys; footer tests compare text, roles and widths, which do not change.

**US-007**
None. Existing `run-interaction-handler.test.ts` outcomes carry no images, and the field is spread in only when non-empty.

**US-008**
- `packages/nax/test/unit/chat/images/image-sniff.test.ts` — deleted: it imports the nax copy of the sniffer, which this story deletes, and its cases now live in the nax-agent sniffer test that US-004 creates.

### Seams

- US-001 -> US-002: US-002's request carries `tool-result` messages with `images`, which only reach the wire because US-001 maps them.
- US-002 -> US-004: `Read`'s `images` reach the model only through the outcome, response and tool-result fields US-002 adds.
- US-002 -> US-007: `buildRunInteractionHandler` copies the `images` field US-002 adds to `CodingToolOutcome` and `AdapterInteractionResponse`.
- US-004 -> US-008: `packages/nax` re-exports the `sniffImage` that US-004 exports from `@nathapp/nax-agent`.

## Acceptance Criteria

### US-001

1. [unit] `toPiContext` with a model whose `input` is `["text", "image"]` and messages `[assistant with tool call "c1" named "Read", tool-result for "c1" with content "shot" and images [PNG A (data "AAAA", 2x2), JPEG B (data "BBBB")]]` produces a pi `toolResult` message whose `content` equals `[{ type: "text", text: "shot" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "BBBB", mimeType: "image/jpeg" }]`.
2. [unit] In that mapping, each image part has exactly the keys `type`, `data` and `mimeType`; a source image carrying `width`, `height` and `source` adds none of them to the part.
3. [unit] `toPiContext` with a model whose `input` is `["text"]` and the same tool result with PNG A (2x2) produces `content` equal to `[{ type: "text", text: "shot\n[image not shown: this model does not accept image input (image/png 2x2)]" }]`.
4. [unit] On a text-only model, an image without `width` and `height` yields the note `[image not shown: this model does not accept image input (image/jpeg)]`.
5. [unit] On a text-only model, two images yield two note lines, in the images' order, each on its own line after the content.
6. [unit] A tool result with no `images` key maps to `content` `[{ type: "text", text: "shot" }]` on a vision model.
7. [unit] A tool result with `images: []` maps to `content` `[{ type: "text", text: "shot" }]` on a vision model.
8. [unit] A tool result with `isError: true` and one image maps to a pi `toolResult` with `isError: true` and the image part after the text on a vision model.

### US-002

1. [unit] `runtime.callTool` for a registered tool whose `run` returns `{ content: "x", images: [PNG A] }` resolves to an outcome with `kind: "ok"`, `content: "x"` and `images` equal to `[PNG A]`.
2. [unit] `runtime.callTool` with a context whose `deferModelTruncation` is true, for that tool, resolves to an outcome carrying `images` equal to `[PNG A]` and a `finalizeAudit` function.
3. [unit] `runtime.callTool` for a tool whose `run` returns `{ content: "bad", isError: true, images: [PNG A] }` resolves to an outcome with `kind: "error"` and no `images` key.
4. [unit] `runtime.callTool` for a tool whose `run` returns `{ content: "x", images: [] }` resolves to an outcome with no `images` key.
5. [unit] `buildToolResult({ toolCallId: "c1", content: "x", images: [PNG A] })` returns a message whose `images` equals `[PNG A]`.
6. [unit] `buildToolResult({ toolCallId: "c1", content: "x" })` and `buildToolResult({ toolCallId: "c1", content: "x", images: [] })` both return a message with no `images` key.
7. [integration] A native turn started through `NativeSessionAdapter.sendTurn`, whose `interactionHandler` is the production `createSessionInteractionHandler` over `createCodingToolRuntime({ extraTools: [T] })` (the composition `session-adapter-abort-reasons.test.ts` uses), with a stubbed model whose first response calls tool `T` and whose second response ends the turn, where `T` returns `{ content: "x", images: [PNG A] }`, sends a second model request whose `tool-result` message for that call has `images` equal to `[PNG A]`.
8. [integration] In that same composition, an `after_tool` handler that patches `content` to `"y"` leaves the request's tool-result message with content `"y"` and `images` equal to `[PNG A]`.
9. [integration] In that same composition, a tool `T` that throws produces a tool-result message with no `images` key.
10. [unit] `capRequestImages` on messages `[user with 15 images, tool-result with 10 images]` keeps all 10 tool-result images and the newest 10 user images, and appends five `[image from an earlier turn dropped from context: image/png]` lines to the user message's content.
11. [unit] `capRequestImages` on `[tool-result with 15 images, user with 10 images]` keeps all 10 user images and the newest 10 tool-result images, and appends five dropped-from-context lines to the tool result's content.
12. [unit] `capRequestImages` keeps the total base64 length of kept images, across user and tool-result messages, at or under `MAX_REQUEST_IMAGE_BASE64_CHARS`.
13. [unit] `capRequestImages` returns the same array instance when no message is over either limit and some tool results carry images.
14. [unit] `imagesAsNotes` on a tool result with content "x" and a 640x480 PNG returns that message with no `images` key and content `x\n[image: image/png 640x480]`.
15. [unit] `estimateTokens` of a tool result with content of 400 characters and one image without dimensions equals `estimateTokens` of the same tool result without the image plus `IMAGE_TOKEN_ESTIMATE`.

### US-003

1. [unit] `splitTranscriptImages(path, doc)` for a doc whose only image is one PNG on a `tool-result` message writes that image under `transcriptImagesPath(path)` and returns a stored doc with `schemaVersion` 2 whose tool-result message holds one image ref and no `data`.
2. [unit] `rehydrateTranscriptImages(path, stored)` for that stored doc returns a doc whose tool-result message has `images` equal to the original `[PNG A]`, including `data`.
3. [unit] The same image bytes on a user message and on a tool-result message are written to the sidecar once.
4. [unit] Rehydrating a stored doc whose tool-result image file was deleted returns that tool result with no `images` key and content ending in the line `[image missing #1]`.
5. [unit] `splitTranscriptImages` on a doc where no message carries images returns the doc unchanged, without `schemaVersion` 2.
6. [integration] Saving a session transcript whose tool result carries a PNG through the transcript store and loading it again yields a tool-result message with the same `images`.

### US-004

1. [unit] `sniffImage` imported from `@nathapp/nax-agent` returns `{ format: "png", mimeType: "image/png", width: 100, height: 50 }` for the bytes of a 100x50 PNG.
2. [unit] `sniffImage` returns `format` `"gif"` with width and height for a GIF89a header.
3. [unit] `sniffImage` returns `format` `"jpeg"` with width and height for a JPEG whose first frame marker is SOF0.
4. [unit] `sniffImage` returns `format` `"webp"` with width and height for a VP8X WebP header.
5. [unit] `sniffImage` returns `undefined` for the bytes of the text `hello`.
6. [unit] `readTool.run` on a 100x50 PNG at `shot.png`, with no offset or limit, returns content `[image: image/png 100x50, <file size> bytes]`, no `isError`, and `images` with one entry whose `mimeType` is `image/png`, `width` 100, `height` 50, `source` `shot.png`, and `data` equal to the base64 of the file's bytes.
7. [unit] `readTool.run` on a JPEG returns an image entry with `mimeType` `image/jpeg`.
8. [unit] `readTool.run` on a PNG stored as `data.bin` returns an image result.
9. [unit] `readTool.run` on a text file named `notes.png` returns the text result it returns today (a `[N lines]` header) and no `images` key.
10. [unit] `readTool.run` on a GIF whose header is too short to hold its size returns content `[image: image/gif, <file size> bytes]` and an image entry with no `width` or `height`.
11. [unit] `readTool.run` on a file of 3,932,161 bytes that starts with the PNG signature returns `isError: true`, content `image too large to view: 3932161 bytes (limit 3932160)` and no `images` key.
12. [unit] `readTool.run` on a file of exactly 3,932,160 bytes that starts with the PNG signature returns an image result.
13. [unit] `readTool.run` on a PNG with `offset: 1` returns `isError: true` and content `offset/limit apply to text files; "shot.png" is an image/png image`.
14. [unit] `readTool.run` on a PNG with `limit: 10` returns the same error.
15. [unit] `readTool.run` on a PNG with `start_line: 1` returns the existing unsupported-argument error naming `start_line`, not the image error.
16. [unit] `readTool.run` on a directory returns `isError: true` with the `READ_NOT_REGULAR_FILE` message, as today.
17. [unit] `readTool.description` starts with `Read a UTF-8 text file from the repository.`, ends with `Output is capped at 1000 lines or 40000 bytes.`, and includes the sentence `PNG, JPEG, GIF and WebP files are returned as images.`
18. [unit] `readTool.run` on a PNG whose header declares width 0 returns content `[image: image/png, <file size> bytes]` and an image entry with no `width` or `height`.
19. [unit] `readTool.run` on a 2,500,000-byte PNG with `ctx.maxFileBytes` 2,000,000 returns an image result.
20. [unit] `readBytesPrefix(path, 10)` on a 100-byte file returns 10 bytes and `size` 100; on a directory it rejects with `READ_NOT_REGULAR_FILE`.
21. [integration] `runtime.callTool("Read", { path: "shot.png" })` on a PNG in the policy root resolves to an outcome with `kind: "ok"` and one image whose `mimeType` is `image/png`.
22. [unit] `withBackgroundSentence("Run a command.", port)` returns `Run a command. Set "runInBackground": true to return at once with a task id; when the command ends, a notice wakes you with its result, so there is no need to wait or poll.`
23. [unit] `withBackgroundSentence("Run a command.", undefined)` returns `Run a command.`

### US-005

1. [unit] `NaxConfigSchema.parse({}).interaction.defaults.chatTaskNoticeTurns` equals 0.
2. [unit] `InteractionConfigSchema.parse({ defaults: {} }).defaults.chatTaskNoticeTurns` equals 0.
3. [unit] `FIELD_DESCRIPTIONS["interaction.defaults.chatTaskNoticeTurns"]` equals `Ended background-task notices that may wake the chat agent in a row before the user sends a message (0 = no limit)`.
4. [unit] `MAX_CONSECUTIVE_TASK_NOTICE_TURNS` imported from `@/tui/chat/use-jobs` equals 0.
5. [integration] A chat mounted with `taskNoticeTurns` 0, after one user message, delivers each of six background tasks that end one after another, each after the previous notice turn finished: `send` is called seven times, and no transcript row contains `auto-wake paused`.
6. [integration] A chat whose host has no `taskNoticeTurns` delivers six chained task notices the same way.
7. [integration] A chat mounted with `taskNoticeTurns` 3 delivers three chained task notices, holds the fourth, and draws `background task ended · auto-wake paused after 3 task turns in a row · send a message to continue` exactly once.
8. [integration] With `taskNoticeTurns` 3 and a notice held, a user-typed message whose turn then ends lets the held notice be sent.
9. [unit] `taskNoticeHeldLine(2)` returns `background task ended · auto-wake paused after 2 task turns in a row · send a message to continue`.
10. [integration] With `taskNoticeTurns` 0, a task that ends while a turn is running is steered into that turn and draws its steered row, as with a positive limit.

### US-006

1. [unit] Rendering `StyledLineView` with the line `[{ text: "1 shell", underline: true }]` writes the text with the terminal underline style, and the same line without `underline` writes it without.
2. [unit] `fittedFooterModel` with one running shell task and a wide row returns a `right` line whose span with text `1 shell` has `color` `"accent"` and `underline` true.
3. [unit] `fittedFooterModel` with one running agent task returns the `1 agent` span with `color` `"accent"` and `underline` true.
4. [unit] `fittedFooterModel` with a running `run` job and a shell returns the strip span (text `run <feature> · 1 shell` as today) with `color` `"accent"` and `underline` true.
5. [unit] In that footer, the separator span after the strip has `color` `"muted"` and no `underline`, and the model and cost spans have no `underline`.
6. [unit] `fittedFooterModel` on a row narrow enough that the strip is summarised returns the `<n> active (ctrl+g)` span with `color` `"accent"` and `underline` true.
7. [unit] `fittedFooterModel` with no jobs and no tasks returns no span with `underline` true.
8. [unit] `fittedFooterModel` with one running shell returns the same `stripWidth` it returns today for that footer (the display width of `1 shell`).
9. [unit] `footerModel` (`@/tui/chat/chat-status`) with one running shell returns a `right` line whose `1 shell` span has `color` `"accent"` and `underline` true.

### US-007

1. [unit] The handler from `buildRunInteractionHandler`, for a coding-tool request whose runtime outcome is `{ kind: "ok", content: "x", images: [PNG A] }`, answers `{ answer: "x", images: [PNG A] }`.
2. [unit] For an outcome `{ kind: "ok", content: "x" }` it answers with no `images` key.
3. [unit] `imagesField({ kind: "ok", content: "x", images: [] })` returns `{}`.

### US-008

These two ACs are regression guards for the re-export (both pass before the change); the deletion itself is verified by `bun run typecheck` in `packages/nax`.

1. [unit] `sniffImage` imported from `@/chat` returns `{ format: "png", mimeType: "image/png", width: 100, height: 50 }` for the bytes of a 100x50 PNG.
2. [unit] `imageFromBytes` from `@/chat` on the bytes of a 100x50 PNG returns an attachment with `mimeType` `image/png`, `width` 100 and `height` 50.

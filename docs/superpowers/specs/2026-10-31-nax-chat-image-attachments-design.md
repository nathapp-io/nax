# nax chat: image attachments

Status: DESIGN, 2026-10-31. **APPROVED by the user 2026-10-31**, not yet specced. Next: spec-writing for feature 1 (`image-content-parts`).

## 0. How to read this document

This document stands alone. A fresh session with no memory should be able to
spec from it. Every decision carries a tag:

- **user**: the user said it. Do not re-litigate.
- **Claude**: a default proposed in this draft. The user may change it.
- **builder**: left open for whoever specs and builds it.

Process rules that bind anyone working on this document (standing user
rulings):

- Nothing gets built, scaffolded or installed until the user approves this
  document.
- `nax plan` and `nax run` are billed. Never launch either without explicit
  approval at the launch moment. That includes a re-plan or a re-run.
- Before any push, run the full `bun run check:all` from the repo root. Never
  run a bare `bun test` or `bun run nax`.
- nax never merges a PR and never releases. The user merges, and the user
  starts releases.
- Pipeline mode is FROZEN. Nothing here touches it.
- nax is a PUBLIC repo. Issues and PR text never name private projects.

## 1. Intent

In `nax chat` the user can give the agent a picture, and the model sees it
together with the message. Typical uses are a screenshot of a broken TUI
render, a web page, or an error dialog. The user wants this for parity with
Claude Code and Codex, which already do it (**user**, 2026-10-31). The user
has not used the feature anywhere, so the Claude Code behaviour is the
reference picture (**user** accepted that picture, 2026-10-31).

This is the second half of the roadmap's chat-input item ("`@` file mention /
image paste"). `@` file mentions shipped first (#2756, design
`docs/superpowers/specs/2026-10-31-nax-chat-file-mentions-design.md`), and
images were split off because they need content-part plumbing through every
layer (**user**, 2026-10-31).

## 2. Current state (recon 2026-10-31, main `f3443675d`)

Today a user message is a plain string everywhere:

| Layer | Where | Today |
|---|---|---|
| nax-ai message | `packages/nax-ai/src/protocols/types.ts:124` (`ConversationMessage`), `src/types.ts:22-25` | user `content: string` |
| nax-ai to pi-ai | `packages/nax-ai/src/protocols/pi-client.ts:147-148` (`toPiMessages`), shared by every provider (`:212`) | pushes the string as is |
| pi-ai 1.4.0 | `UserMessage.content: string \| (TextContent \| ImageContent)[]`, `ImageContent = { type: "image", data, mimeType }` | **already serializes images** for anthropic, openai-completions, responses-style and google |
| model capability | pi templates carry `input: ("text"\|"image")[]`; nax-ai `ResolvedModel`/`RawModel` (`providers/types.ts`, `providers/pi-catalog.ts:100-115`) do not expose it; custom models are synthesized `input: ["text"]` (`pi-client.ts:821`) | not visible to nax |
| nax-agent turn | `AgentSession.send(message: string)` (`packages/nax-agent/src/session/agent-session.ts:105`), native `sendTurn(handle, prompt: string)` (`native/session-adapter.ts:182`), seed `{role:"user", content: prompt}` (`native/session/turn-loop.ts:54-58`) | string only |
| transcript | `TranscriptDoc.messages: ConversationMessage[]` (`native/session/transcript-types.ts:39`), whole document rewritten at every turn end to `<dir>/<name>.transcript.json` (`transcript-store.ts:20,69`) | strings |
| compaction | `estimateTokens` counts user `content.length` / 4 (`native/session/compaction.ts:50-53`) | no image estimate |
| chat send | `ChatApp.sendTurn(message, prepare?)` (`packages/nax/src/tui/chat/ChatApp.tsx:382-404`) -> `ChatHost.send(message: string)` (`chat/chat-host.ts:491`) -> `runChatTurn` -> `session.send(message)` (`chat/turn-runner.ts:12,57`) | string |
| `@` mentions | `packages/nax/src/chat/mentions/mention-expand.ts`: NUL byte in first 8000 bytes = binary = path only (`:186,249-252,298-300`) | an `@shot.png` sends only the path |
| transcript view | `sentEntries` / `mentionTranscriptEntries` (`tui/chat/mention-send.ts:57-61`, `mention-entries.ts:28-31`); replay `replayUser(content)` parses the stored string (`tui/chat/history-replay.ts:15-26`) | text and attachment rows |
| ACP brains (client) | `promptOnce` sends `[{ type: "text", text }]` (`packages/nax-agent-acp/src/client/turn.ts:93-96`); `capabilities.ts:59-72` never reads `promptCapabilities` | text only, no image check |
| ACP brain history | ACP turns are copied into the native transcript store (`chat/acp/acp-recorder.ts`, `acp-transcript-append.ts`) | one store for both kinds of brain |
| ACP server | advertises `image: false` (`nax-agent-acp/src/server/capabilities.ts:14`); `flattenPrompt` rejects image blocks (`server/prompt.ts:27-29`) | refuses images |
| clipboard | `tui/chat/clipboard.ts` is write-only (OSC 52 + `pbcopy`) | no read |
| keys | ctrl+v falls to `IGNORED` (`tui/chat/line-editor.ts:137-151`); a paste arrives as one `useInput` chunk inserted whole (`:85-90`); no bracketed-paste handling | ctrl+v free |
| elsewhere | Read tool is text-only (`nax-agent` `read.ts:81`); MCP image results become `[image omitted: <mime>]` (`nax-agent/src/mcp/result-text.ts:28-30`) | no image path at all |

The good news is the bottom layer: pi-ai already does the provider-specific
serialization. The work is to carry image parts from the chat input down to
`toPiMessages`, store them, replay them, and hand them to ACP brains.

## 3. Goals

- G1. **Paste a screenshot.** In the chat input, ctrl+v with an image on the
  clipboard attaches it. The input shows a placeholder `[Image #1]` at the
  cursor. (**Claude**, follows Claude Code, which uses ctrl+v on macOS too)
- G2. **Drag a file in.** Dropping an image file onto the terminal pastes its
  path. When a single paste chunk is exactly one path to an existing image
  file, nax attaches the image and inserts `[Image #N]` instead of the path.
  (**Claude**, follows Claude Code)
- G3. **Mention an image.** `@path/to/shot.png` attaches the image instead of
  the current path-only fallback. (**Claude**)
- G4. **The model sees it.** On send, the images go to the model as image
  content parts with the message, for native brains and for ACP brains
  (Claude Code, Codex, Cursor). (**Claude**)
- G5. **Readable transcript.** The user message shows as typed, with
  `[Image #N]` placeholders, plus one note row per image:
  `image 1 · png · 1280×720 · 342 KB` and its source (clipboard, file path).
  (**Claude**, same style as the mention attachment rows)
- G6. **Survives resume and brain switching.** Images are part of the stored
  message. Resume replays them. Switching to a brain that can take images
  carries them across. (**Claude**)
- G7. **Clear refusals.** When the current model or brain cannot take images,
  the send is refused with a one-line reason and the draft is kept. Images
  are never dropped silently. (**Claude**)

## 4. Non-goals

- Drawing images in the terminal (kitty, iTerm2 or sixel protocols). The note
  row is the only display. (**Claude**)
- Resizing, cropping or re-encoding images. Images go as the bytes on disk or
  on the clipboard, inside the limits in §5.4. This avoids a native image
  dependency. (**Claude**; see §8 Q2)
- Image output from tools: the Read tool returning images, MCP image results
  reaching the model, browser screenshots. Separate feature. (**Claude**)
- PDFs and other documents as content parts.
- `nax run`, `nax plan`, bot prompts, subagent prompts. Chat input only.
- The nax ACP **server** accepting images (`image: false` stays). Once
  `AgentSession.send` takes parts this is a small follow-up, but it is outside
  chat input. (**Claude**; see §8 Q3)
- Images inside slash commands (`/skill foo [Image #1]`). Plain messages only,
  matching the mentions rule. (**Claude**)
- Audio.

## 5. Behaviour

### 5.1 Attaching

- **ctrl+v** reads an image from the system clipboard (**Claude**):
  - macOS: `osascript` reading `«class PNGf»` from the clipboard, written to a
    temp file. No extra install needed.
  - Linux: `wl-paste --type image/png` when `WAYLAND_DISPLAY` is set, else
    `xclip -selection clipboard -t image/png -o`.
  - Windows / anything else: not supported in v1; ctrl+v shows a one-line hint.
  - Clipboard with no image: fall back to a plain text paste of the clipboard
    text if the terminal did not already paste it, otherwise do nothing and
    show `no image on the clipboard`. (**builder**: pick whichever is simpler
    to make reliable; the hint must not appear when a text paste succeeded.)
  - The helper command runs with a timeout (2 s, **Claude**) and its failure
    is a one-line notice, never a crash.
- **Pasted path** (G2): a paste chunk that, after trimming whitespace and
  removing one level of shell quoting or backslash escapes, is a single path
  to an existing file with an image extension. A `file://` URL counts too.
  Anything else is a normal text paste. (**Claude**)
- **`/image [path]`** fallback (**Claude**, builder check): with no argument
  it does what ctrl+v does; with a path it attaches that file. It exists
  because ctrl+v (`\x16`) may never reach nax under tmux or in terminals that
  bind it, and Cmd+V with an image-only clipboard pastes nothing. This is the
  one slash command that adds to the draft instead of sending.
- **`@` mention** (G3): a mentioned file whose magic bytes are an image
  attaches the image. The mention's path rules still apply (inside the repo,
  not ignored, not under `.git`). The `@path` text stays in the draft as
  typed; no `[Image #N]` is inserted. The image still takes the next image
  number, and the mention envelope lists it as an image record (path, format,
  size) with no contents, so the model can match the picture to the path.
  (**Claude**, builder check)
- **Path boundary** (**Claude**): a pasted or dragged path may be anywhere the
  user can read, because the user put it there by hand (screenshots usually
  live on the Desktop or in a temp dir). `@` mentions keep the repo boundary.
- Every attachment gets the next number in the draft, starting at 1.
  `[Image #N]` is inserted at the cursor as plain text.

### 5.2 The draft

- The draft holds the text plus a list of attachments keyed by number.
- Deleting the `[Image #N]` text removes that attachment from the send. On
  send, only attachments whose placeholder is still present in the text go.
  (**Claude**, Claude Code behaviour)
- Asks, pickers and the slash menu keep the attachments, just as they keep
  the draft today.
- Bytes are read and checked when the image is attached, not at send, so the
  user sees a refusal immediately. (**Claude**)
- Up-arrow input history recalls the text only. A recalled `[Image #N]` with
  no attachment behind it is plain text and sends nothing. (**Claude**,
  builder check)

### 5.3 Sending

- Plain chat message only. A message that starts with `/` and has
  attachments is refused with `images can only be sent with a plain message`.
- **Capability gate** (G7): before sending, nax checks that the current brain
  takes images:
  - native brain: the resolved model's `input` includes `"image"`;
  - ACP brain: the agent's `initialize` reply has
    `promptCapabilities.image === true`. A missing field counts as `false`,
    which is the ACP default, so the gate is strict. (**Claude**, builder
    check; the Claude Code ACP adapter advertises `true`. Whether Codex and
    Cursor do is a **builder** fact to record, not a design change.)
  If not: refuse, keep the draft, notice
  `<model or agent> cannot read images; switch model (/model) or remove the image`.
- Part order (**Claude**): image parts first, then the text part (the typed
  text, plus the mention envelope when there are file mentions). Providers
  recommend images before text.
- The placeholders stay in the text the model sees, so "the second image"
  can be resolved.
- The session title is the typed text, as today.

### 5.4 Limits

(**Claude**; the numbers follow the strictest common provider limits.)

| Rule | Value |
|---|---|
| formats | PNG, JPEG, GIF, WebP, detected from magic bytes, not extension |
| per image | 3.75 MiB raw (= 5 MB base64; Anthropic's per-image limit applies to the encoded size) |
| per message | 10 new images |
| per request | at most 20 images in the context sent to the model; at most 20 MB of base64 image data |
| dimensions | longest edge at most 8000 px, read from the header |

A refused image gets a notice with the reason and is not attached.

**Images already in history** (**Claude**, builder check). Every turn resends
the whole conversation, so old images cost tokens and bytes on every later
turn. When a request would exceed the per-request row above, the oldest
images in the context sent to the model become the text note
`[image N from an earlier turn, dropped from context]`, newest kept. This is
done at send time only: the stored transcript keeps every image, so a later
model with a bigger budget or `/compact` sees the same history. A single new
message over the per-request limit on its own is refused at attach time.

### 5.5 Transcript and replay

- New transcript entry kind for an image note (or an extension of the
  attachment entry from mentions; **builder**), rendered as G5.
- Clicking a note row expands it to show the full source path or
  `clipboard`, matching the mention attachment row.
- History replay rebuilds the user text and one note per image from the
  stored message (§6.3). An image whose stored bytes are missing replays as
  `image N · missing` and is not resent.

### 5.6 Brain switching and resume

- Resume: the native brain reloads the stored parts, so earlier images stay
  in context.
- Switching brains: the handoff (`chat/acp/acp-handoff.ts`,
  `acp-handoff-entries.ts`) is text only today, `{ speaker, text }` entries
  under a character budget (`ACP_HANDOFF_MAX_CHARS`). It stays text only.
  Each image in the handed-off history becomes the text note
  `[image N: <format> <w>×<h>, <source>; not carried across the switch]`.
  Re-sending old images on a switch is a non-goal for v1. To show the new
  brain a picture again, the user attaches it again. (**Claude**, builder
  check; this keeps the handoff budget and first-prompt shape unchanged.)
- The handoff is the one place images become text instead of being refused,
  because the user is not sending anything new.
- Switching a native model to one without image input: same placeholder rule
  for old turns; new sends are gated by §5.3.

## 6. Design

### 6.1 Content type (nax-ai)

- Add a user content type:
  `UserContent = string | readonly UserContentPart[]` with
  `UserContentPart = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }`
  (`data` = base64). The shape deliberately matches pi-ai's `TextContent` /
  `ImageContent` so `toPiMessages` maps it one to one. (**Claude**)
- `ConversationMessage` role `user` takes `UserContent`. `string` stays valid
  everywhere, so every existing caller and fixture keeps working.
- `toPiMessages` passes parts through (`pi-client.ts:147-148`).
- Expose `input: readonly ("text" | "image")[]` on the resolved model. Bundled
  models take it from the pi template. Custom models (custom providers,
  strata) default to `["text"]` and gain an optional config field to declare
  image input, for local vision models. (**Claude**; field name is
  **builder**.)
- Every place in nax that reads user `content` as a string (compaction,
  title, ledgers, prompt audit, history replay, prune) gets a single helper
  `userText(content)` that joins text parts. (**builder** finds the full list.)
- Before release: verify each provider path pi-ai uses for nax's providers
  sends user images (recon confirmed anthropic, openai-completions,
  responses-style and google; openai-codex was **not** checked). A provider
  that cannot is treated as text-only by the capability gate. (**builder**)

### 6.2 nax-agent

- `AgentSession.send(message: string | UserContent)` and the native adapter's
  `sendTurn` accept parts. The `string` signature stays, because embedders
  (including an external fleet app that embeds `@nathapp/nax-agent`) call it
  today. (**Claude**)
- Compaction estimate: a fixed 1,600 tokens per image, or
  `ceil(width × height / 750)` capped at 1,600 when dimensions are known.
  (**Claude**; matches the Anthropic sizing guide.)
- Compaction must not summarise an image away silently: when a compacted
  range contains images, the summary input notes `[image: <mime> <w>×<h>]`.
  (**Claude**)

### 6.3 Storage

The transcript document is rewritten whole at every turn end, so inline
base64 would rewrite megabytes per turn and bloat every resume.

- Store image bytes once, content-addressed, beside the transcript:
  `<dir>/<name>.images/<sha256>.<ext>`. (**Claude**)
- In the stored `TranscriptDoc`, an image part is
  `{ type: "image", mimeType, ref: "<sha256>", width?, height?, bytes?, source? }`
  with no `data`. The store fills `data` back in on load. (**Claude**)
- `source` records `clipboard`, the absolute path, or the mention path, for
  the note row. It never reaches the model.
- Deleting or archiving a transcript (`transcript-store.ts:132,140`) deletes
  or moves its images dir too.
- A missing image file on load: the part becomes the text note
  `[image missing]` and replay shows it as in §5.5. It is never fatal.
- The memory transcript store (probes, subagents) keeps inline `data`.
- **Who rehydrates** (**Claude**, builder check): the file store owns it.
  `save` splits image `data` out to the sidecar and writes `ref`; `load`
  reads the sidecar and returns in-memory messages with `data`. The rest of
  nax-agent only ever sees the in-memory shape. A separate stored-part type
  lives inside the store module and is not exported.
- **Schema version**: a transcript that contains at least one image ref is
  written with `schemaVersion: 2`; a transcript without images is written
  exactly as today (no field, read as 1), so text-only sessions stay readable
  by older nax. An older nax that meets `schemaVersion: 2` should fail to load
  that session with a clear "written by a newer nax" error rather than send
  broken parts. Today's loader has no version check, so this protects only
  versions from this feature on. Accept that limit. (**Claude**)
- Embedders that read transcript files directly are not a supported
  interface. They see the new shape only when a session holds images.

### 6.4 ACP client (brains)

- Parse `promptCapabilities.image` in `capabilities.ts` and expose it to the
  chat host.
- `promptOnce` sends an ACP `image` content block
  (`{ type: "image", mimeType, data }`) per image part, then the text block.
- The ACP recorder copies image parts into the native transcript store like
  any other user content, so §6.3 applies to ACP brains too.

### 6.5 Chat (packages/nax)

- Clipboard read lives next to `clipboard.ts`, behind an injectable deps seam
  so tests never touch the real clipboard. (**Claude**)
- The draft model (`InputDraft`) gains attachments. Key handling: ctrl+v in
  `line-editor.ts` becomes an attach request routed to ChatApp (the line
  editor stays pure; ChatApp does the I/O).
- `sendTurn`'s `prepare` step builds `UserContent` from the draft plus the
  mention expansion. `ChatHost.send` and `runChatTurn` accept `UserContent`.
- `@` mention expansion recognises image files (magic bytes) before the
  binary check, and returns an image attachment record.
- Image metadata (format, width, height) is read from file headers with a
  small hand-written reader for the four formats. No new dependency.
  (**Claude**)

## 7. Delivery

Likely two nax features, run in order (**Claude**; final split is up to the
spec's size gate):

1. `image-content-parts`: nax-ai content type, model `input` capability and
   custom-model field, `toPiMessages`, `userText` sweep, nax-agent `send`,
   compaction estimate, image sidecar storage, ACP client image blocks and
   capability. No UI. Testable end to end with a fake provider.
2. `chat-image-attachments`: clipboard read, ctrl+v, pasted-path detection,
   `@` image mentions, draft attachments, capability gate, transcript notes,
   replay, switch placeholders.

## 8. Builder check (2026-10-31)

A fresh reviewer read this document against the code. It confirmed the
cited code facts and found one wrong claim: the brain-switch handoff is
text only. That is now fixed in §5.6. None of its questions needed the user,
so each one was settled as a **Claude** call (marked "builder check" above):

1. Brain switch: images become text notes; old images are not re-sent (§5.6).
2. ACP capability gate: strict; a missing `promptCapabilities.image` = false (§5.3).
3. Transcript: the file store owns the sidecar split and rehydration;
   `schemaVersion: 2` only when images are present (§6.3).
4. Limits on encoded size: 3.75 MiB raw per image, 20 images / 20 MB per
   request (§5.4).
5. Old images in history: dropped oldest-first from what is sent (but kept in
   the store) once a request would pass the per-request limit (§5.4).
6. tmux and bound ctrl+v: `/image [path]` fallback (§5.1).
7. `@` image mentions: the `@path` text stays, no placeholder, an image record
   goes in the envelope (§5.1).
8. Up-arrow recall: text only (§5.2).

Open facts for the builder (not design choices): whether pi-ai's openai-codex
path sends user images, and whether the Codex and Cursor ACP adapters
advertise `promptCapabilities.image`.

## 9. Decision log

- 2026-10-31 **user**: images are a separate feature after `@` mentions.
- 2026-10-31 **user**: the goal is parity with Claude Code and Codex; Claude
  Code's behaviour is the reference.

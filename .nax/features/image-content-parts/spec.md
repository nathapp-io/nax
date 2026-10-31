# SPEC: Image content parts through the model, session and ACP layers

## Summary

Carry images from a session caller down to the model, with no UI. A user message gains an optional `images` list next to its text (`ConversationMessage` role `user` in nax-ai). nax-ai sends them to pi-ai as image parts (images first, then the text), and the resolved model reports whether it reads images (`ResolvedModel.input`). `AgentSession.send(message, { images })` validates them and passes them to the backend through `SendTurnOpts.images`. The native backend seeds them into the turn, refuses them on a model without image input, keeps a request under a per-request image budget, estimates their tokens for compaction, and turns them into short text notes for the compaction summary. The file transcript store writes image bytes once to a content-addressed folder beside the transcript and reads them back on load. The ACP client reads the agent's `promptCapabilities.image` and sends ACP image blocks. `AgentSession.acceptsImages()` lets a caller ask before sending. A custom-provider model can declare image input in nax config.

This is feature 1 of 2 in the approved design `docs/superpowers/specs/2026-10-31-nax-chat-image-attachments-design.md` (§7 item 1). Feature 2, `chat-image-attachments`, builds the `nax chat` side on top of it. It is one capability (image input plumbing) across four packages; the ten stories come from the one-package-per-story rule and the 24-assertion story gate.

## Motivation

- The coding-agent roadmap's chat-input item is "`@` file mention / image paste". `@` mentions shipped (#2756). The user wants image attachments next, for parity with Claude Code and Codex (user, 2026-10-31).
- Today a user message is a plain string at every layer: nax-ai `ConversationMessage` role `user` has `content: string` (`packages/nax-ai/src/protocols/types.ts`), `toPiMessages` pushes that string (`packages/nax-ai/src/protocols/pi-client.ts`), `AgentSession.send(message: string)` (`packages/nax-agent/src/session/agent-session-types.ts`), and the ACP client sends one text block (`packages/nax-agent-acp/src/client/turn.ts` `promptOnce`). Nothing can carry a picture.
- pi-ai 1.4.0 already serializes `ImageContent` (`{ type: "image", data, mimeType }`) inside `UserMessage.content`, so the provider-specific work is done. Only nax's own layers need the plumbing.
- The chat UI (feature 2) needs a stable layer to build on: a way to send images, a way to ask whether the current brain reads them, and storage that survives resume.

## Design

### Approach

Images ride **beside** the text, not instead of it: role `user` keeps `content: string` and gains optional `images`. Every existing reader of user `content` (titles, ledgers, prompt audit, the ACP handoff, history replay) keeps working unchanged, and only the layers that talk to a model or to disk learn about images. (The design doc §6.1 proposed a `string | parts[]` union with a `userText` sweep; this side field reaches the same wire shape with no sweep. Recorded in the design doc's decision log.)

The single image type is nax-ai's `ImageAttachment`:

```ts
export interface ImageAttachment {
  /** One of IMAGE_MIME_TYPES (nax-agent). */
  readonly mimeType: string;
  /** Base64 of the raw image bytes. */
  readonly data: string;
  readonly width?: number;
  readonly height?: number;
  /** Where the image came from ("clipboard", an absolute path, a repo path). Display only; never sent to a model. */
  readonly source?: string;
}

export type ConversationMessage =
  | { readonly role: "user"; readonly content: string; readonly images?: readonly ImageAttachment[] }
  | /* assistant and tool-result members unchanged */;
```

### Limits and validation

Limits live in nax-agent (`packages/nax-agent/src/session/image-input.ts`, exported from `.`), so feature 2 uses the same numbers:

| Constant | Value | Meaning |
|---|---|---|
| `IMAGE_MIME_TYPES` | `["image/png", "image/jpeg", "image/gif", "image/webp"]` | accepted `mimeType` values |
| `MAX_IMAGES_PER_MESSAGE` | `10` | images on one `send` |
| `MAX_IMAGE_BASE64_CHARS` | `5_242_880` | per image, base64 length (5 MiB encoded = 3.75 MiB raw) |
| `MAX_REQUEST_IMAGES` | `20` | images in one model request (whole history) |
| `MAX_REQUEST_IMAGE_BASE64_CHARS` | `20_971_520` | base64 chars of images in one model request, and of one `send` |
| `IMAGE_TOKEN_ESTIMATE` | `1_600` | compaction estimate per image |

`validateImageAttachments(images: readonly ImageAttachment[]): string | undefined` returns `undefined` for a valid list, otherwise a one-line reason. Checks run in this order and the first failure wins:

1. the list length is over `MAX_IMAGES_PER_MESSAGE`;
2. per image, in list order: `mimeType` not in `IMAGE_MIME_TYPES`; `data` empty; `data` not matching `^[A-Za-z0-9+/]*={0,2}$` or its length not a multiple of 4; `data.length` over `MAX_IMAGE_BASE64_CHARS`; `width` or `height` present and not a positive integer;
3. the sum of `data.length` over the list is over `MAX_REQUEST_IMAGE_BASE64_CHARS`.

Because one valid `send` holds at most `MAX_IMAGES_PER_MESSAGE` (10, below `MAX_REQUEST_IMAGES`) images totalling at most `MAX_REQUEST_IMAGE_BASE64_CHARS`, the request budget below never drops an image of the turn being sent. Pixel dimensions are not read from bytes here (feature 2 reads file headers).

`SendInput = { readonly images?: readonly ImageAttachment[] }` is declared in `image-input.ts`.

### Note lines

Every note line this feature appends to a user message's `content` (`[image from an earlier turn dropped from context: ...]`, `[image: ...]`, `[image missing]`) is appended once per image, in image order, joined to the existing `content` with `\n`; when `content` is empty the first line is used with no leading `\n`.

### Request image budget (native)

`capRequestImages(messages)` shapes the wire copy only. When no image needs dropping it returns **the input array itself** (same reference), so the existing "no clone when dormant" identity in `test/unit/native/session/loop-events/transform-context.test.ts` still holds. Otherwise it returns a new array and never changes the input array or its messages, so the saved transcript keeps every image.

It walks images from the newest message to the oldest, and within a message from last to first. It keeps an image when the kept count is below `MAX_REQUEST_IMAGES` **and** the kept base64 total plus this image's `data.length` is at most `MAX_REQUEST_IMAGE_BASE64_CHARS`; otherwise it drops it. Count and size are checked together per image, so a dropped large image does not stop a later smaller one from being kept. A dropped image is removed from that message's `images` and the line `[image from an earlier turn dropped from context: <mimeType>]` is appended to that message's `content` (joined with `\n`). A message left with no images loses its `images` key.

It runs inside the native `request` wrapper in `turn-complete-step.ts` (reached through `completeWithRecovery`), on `wire.messages` from `applyHistoryPatch`, immediately before `deps.complete`; so it also bounds a `transform_context` handler's patch. Dropping an old image changes the request's prefix, so a prompt-cache prefix and the compaction anchor's `promptTokens` can be stale for that request; this is accepted (the anchor is an estimate already).

### Compaction

- `estimateTokens` adds, per image of a user message, `min(IMAGE_TOKEN_ESTIMATE, ceil(width * height / 750))` when both `width` and `height` are present, else `IMAGE_TOKEN_ESTIMATE`.
- The summarizer never receives image bytes: `imagesAsNotes(messages)` returns messages in which every image of every user message is replaced by the appended line `[image: <mimeType> <width>x<height>]` (or `[image: <mimeType>]` without both dimensions) and `images` is removed. `summarizeAndApply` in `turn-compaction-step.ts` calls `deps.summarize(imagesAsNotes(plan.toSummarize), plan.previousSummary)`.

### Storage (file transcript store)

The image folder for a transcript file is that file's name with the trailing `.json` replaced by `.images`: the live `<dir>/<session>.transcript.json` uses `<dir>/<session>.transcript.images/`, and a retained `<session>.transcript.failed-<stamp>.json` uses `<session>.transcript.failed-<stamp>.images/`.

The extension table is closed: `image/png` → `png`, `image/jpeg` → `jpg`, `image/gif` → `gif`, `image/webp` → `webp`.

- **Write** (the store's `save` and `markTurn`, and `saveTranscript`): every user-message image is written once to `<folder>/<sha256-hex-of-raw-bytes>.<ext>` (an existing file is not rewritten), atomically (a staged temp file in the folder renamed into place, as `writeFileAtomic` in `#src/internal/atomic-write` does for text; widening that helper to bytes is fine), before the JSON document. In the JSON document that image becomes `{ mimeType, ref, width?, height?, source? }` with no `data`. The on-disk `schemaVersion` is `2` when the document holds at least one image; otherwise the document's own `schemaVersion` is written as given (absent stays absent, `1` stays `1`), so an image-free document is written exactly as today and no folder is created. An image whose `mimeType` is not in the extension table makes the write reject with `NaxError` code `TRANSCRIPT_IMAGE_TYPE_UNSUPPORTED` (context `stage: "native-session"`) and nothing is written.
- **Read** (`readTranscriptDoc`, so the store's `load` and `markTurn`): an on-disk `schemaVersion` above 2 throws `NaxError` code `TRANSCRIPT_SCHEMA_UNSUPPORTED` (context `stage: "native-session"`, the code the turn loop already uses). For a document with `schemaVersion: 2`, every stored image whose `ref` is 64 lowercase hex characters, whose `mimeType` is in the extension table, and whose file exists in the folder is returned with `data` (base64 of the file) and without `ref`; any other stored image is dropped from `images` and the line `[image missing]` is appended to that message's `content`. A document stored with `schemaVersion: 2` is returned with **no `schemaVersion` key**, and a stored `1` (or absent) is returned as stored: version 2 is a disk-format detail of the file store, so the three existing doc-level readers (`historyFromTranscript` in `transcript-identity.ts`, `instruction-session.ts`, `agent-session-resume.ts`), which accept only 1 or absent, need no change.
- **Lifecycle**: `deleteTranscript` also removes the live folder; `retainTranscript` renames it to the retained folder name with the same stamp; `pruneRetainedTranscripts` removes the folder of each transcript file it deletes.
- `markTurn` goes through the same read and write, so it re-reads image files and re-hashes them on each call; with content-addressed names nothing is rewritten. The extra reads are accepted.
- The memory transcript store keeps images inline, unchanged.
- The stored image shape is private to the store module; the rest of nax-agent only sees `ImageAttachment` with `data`.
- Image files of messages that compaction later removes stay in the folder until the transcript is deleted (see Out of Scope).

### Capability

- nax-ai `ResolvedModel` and `RawModel` gain `input?: readonly ("text" | "image")[]` (absent = unknown, treated as text only). `defaultProviders()` copies pi-ai's `model.input`. `normaliseCatalog` copies `RawModel.input`; when a `ProviderOverride` model declares no `input` and replaces an entry that already has one (same provider and id), the override's resolved model keeps that entry's `input`. A pi model synthesised from an override uses the override's `input` when declared, else today's behaviour (the template's `input` on the bundled-provider path, `["text"]` on the introduced-provider path).
- `NativeSessionAdapter.imageInput(handle): Promise<boolean>` resolves the handle's model exactly as `sendTurn` does and returns whether its `input` includes `"image"`.
- ACP `CapabilityRecord` gains `image: boolean` = `init.agentCapabilities?.promptCapabilities?.image === true` (a missing field is `false`, the ACP default).
- `OpenedBackend` gains optional `acceptsImages?(): Promise<boolean>`. Native: `() => adapter.imageInput(handle)`. ACP: reads `s.live.acp.record.image` at call time. A reconnect replaces `s.live` only through `liveFor` (called by `sendTurn` and `configure`); `acceptsImages()` never reconnects, so after the agent process dies it reports the new process's record only once a turn (or a configure) has reconnected.
- `AgentSession` gains **optional** `acceptsImages?(): Promise<boolean>` (optional like `configure?` and `runCommand?`, so the existing hand-built `AgentSession` objects in nax source and tests still typecheck). The facade (`FacadeAgentSession`) always implements it: rejects with `AgentSessionError` `AGENT_SESSION_CLOSED` on a closed session; resolves `false` when the backend has no `acceptsImages`; otherwise resolves the backend's answer.

### Sending

- `AgentSession.send(message: string, input?: SendInput)`. Refusals are thrown synchronously, before a turn is claimed, in this order: the existing closed / busy / configuring checks; then `validateImageAttachments` failing → `AgentSessionError` code `AGENT_SESSION_INVALID_INPUT` with the reason as message; then a non-empty `images` on a backend with no `acceptsImages` → `AGENT_SESSION_CAPABILITY_UNSUPPORTED` with context `{ capability: "images" }`.
- `claimTurn` carries the images to `ctx.adapter.sendTurn(handle, message, { ...opts, images })`. `SendTurnOpts` gains `images?: readonly ImageAttachment[]`; the key is present only when the list is non-empty.
- Native `sendTurn` with non-empty `opts.images` on a model whose `input` lacks `"image"` throws `NaxError` code `NATIVE_IMAGE_INPUT_UNSUPPORTED` (context `stage: "native-session"`) before any model call and before any transcript save. Otherwise the turn seed is `{ role: "user", content: prompt, images }`. A `before_turn` handler's seed patch still replaces the whole seed (images included), as it does for the prompt today.
- ACP `sendTurn` calls `liveFor` first, then reads the (possibly reconnected) record: with non-empty `opts.images` and `record.image === false` it throws `NaxError` code `ACP_IMAGE_INPUT_UNSUPPORTED` (context `stage: "acp"`, as every error in `nax-agent-acp/src/client/errors.ts`) before any `session/prompt`. Otherwise `runPromptTurn` gets `images` in its `TurnInput`, and `promptOnce` sends `[...images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data })), { type: "text", text }]` on the first `session/prompt` of the turn only; a denied-continuation re-prompt (`MAX_DENIED_CONTINUATIONS`) sends text only.

### Wire shape (nax-ai)

`toPiMessages` maps a user message with a non-empty `images` to `{ role: "user", content: [...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })), ...(content === "" ? [] : [{ type: "text", text: content }])], timestamp }`. `width`, `height` and `source` never reach pi-ai. A user message with no `images`, or an empty one, maps exactly as today (`content` as a string).

### Config (nax)

`agent.native.catalogOverrides[].models[]` (`CatalogModelOverrideSchema`, `packages/nax/src/config/schemas-model.ts`) gains `input: z.array(z.enum(["text", "image"])).min(1).optional()`. nax-agent's `CatalogModelOverride` gains `input?: ("text" | "image")[]`, and `toProviderOverrides` (`packages/nax-agent/src/native/models.ts`) forwards it only when declared. nax's runtime config type (`runtime-types-agent.ts` `catalogOverrides?: ProviderCatalogOverride[]`) already takes nax-agent's type, so it gains the field with no edit.

### Integration

Read-only symbols (verified 2026-10-31 on main `f3443675d`):

- `packages/nax-ai/src/protocols/pi-client.ts`: `toPiContext(request, model)` (exported; tests read `context.messages`), `synthesiseModel(base, model)`, `pickTemplate(...)`; the introduced-provider model literal sets `input: ["text"]`.
- `packages/nax-ai/src/providers/catalog.ts`: `normaliseCatalog(raw, overrides)`; its override loop calls `setModel(override.provider, model)`, replacing a same-id entry.
- `packages/nax-ai/src/providers/pi-catalog.ts`: `defaultProviders()` builds `RawModel` entries from pi-ai models.
- `packages/nax-agent/src/session/agent-session-turn.ts`: `claimTurn(ctx, message, hooks)`; private `sendTurn(ctx, live, message)` calls `ctx.adapter.sendTurn(ctx.handle, message, { ...ctx.turnOpts(), maxInteractions, turnId, signal, onTurnEvent })`.
- `packages/nax-agent/src/native/session/turn-loop.ts`: `runNativeTurn(handle, prompt, opts, deps)`; `beforeTurnSeed(patch, prompt)`.
- `packages/nax-agent/src/native/session/turn-complete-step.ts`: `completeWithRecovery(args)`; its `request` wrapper computes `wire = applyHistoryPatch(...)` and returns `deps.complete(wire.messages, tools, options, sink)`.
- `packages/nax-agent/src/native/session/turn-compaction-step.ts`: `summarizeAndApply(messages, plan, ...)` calls `deps.summarize(plan.toSummarize, plan.previousSummary)`.
- `packages/nax-agent/src/native/session-adapter.ts`: `NativeSessionAdapter.sendTurn(handle, prompt, opts)` resolves `client.model(provider, model)` from `parseNativeModel(handle.modelDef?.model ?? "")`; the client comes from `_clientDeps.build` (the existing test seam, see `test/unit/native/session-adapter-client.test.ts`).
- `packages/nax-agent/src/session/native-backend.ts`: `openNative` returns `{ adapter, handle, runCommand, info, turnOpts, close }` (no `configure`); `createAdapter(raw)` returns the `NativeSessionAdapter`.
- `packages/nax-agent/src/native/session/transcript-identity.ts` `historyFromTranscript`, `instruction-session.ts`, `packages/nax-agent/src/session/agent-session-resume.ts`: accept `schemaVersion` absent or 1 only. Unchanged.
- `packages/nax-agent-acp/src/client/backend.ts`: `assemble(s)` builds the `OpenedBackend`; `infoOf(s)` reads `s.live.acp.record`; `liveFor(s, signal)` reconnects; `sendTurn(s, prompt, opts)` calls `runPromptTurn(live.state, { text, signal, collector })`.
- `packages/nax-agent-acp/src/client/turn.ts`: `runPromptTurn(state, input)`; `promptOnce(state, input, text, carried)` calls `state.link.prompt({ sessionId, prompt: [{ type: "text", text }] })`.

Symbols this feature changes. The baseline exists only to locate the code; implement the target.

- `ConversationMessage` (`packages/nax-ai/src/protocols/types.ts`)
  - Baseline: `{ readonly role: "user"; readonly content: string }`
  - Target: `{ readonly role: "user"; readonly content: string; readonly images?: readonly ImageAttachment[] }`
- `ResolvedModel` (`packages/nax-ai/src/providers/types.ts`) and `RawModel` (`packages/nax-ai/src/providers/catalog.ts`)
  - Target: both gain `readonly input?: readonly ("text" | "image")[]`.
- `AgentSession` (`packages/nax-agent/src/session/agent-session-types.ts`)
  - Baseline: `send(message: string): AsyncIterable<SessionEvent>`
  - Target: `send(message: string, input?: SendInput): AsyncIterable<SessionEvent>`; plus optional `acceptsImages?(): Promise<boolean>`.
- `SendTurnOpts` (`packages/nax-agent/src/session/session-types.ts`)
  - Target: gains `images?: readonly ImageAttachment[]`.
- `OpenedBackend` (`packages/nax-agent/src/session/session-backend.ts`)
  - Target: gains `acceptsImages?(): Promise<boolean>`.
- `AgentSessionErrorCode` (`packages/nax-agent/src/session/agent-session-errors.ts`)
  - Target: gains `"AGENT_SESSION_INVALID_INPUT"`.
- `estimateTokens(message)` (`packages/nax-agent/src/native/session/compaction.ts`)
  - Target: user branch adds the per-image estimate.
- `CapabilityRecord` / `buildCapabilityRecord(init, entry)` (`packages/nax-agent-acp/src/client/capabilities.ts`)
  - Target: record gains `image: boolean`.
- `TurnInput` (`packages/nax-agent-acp/src/client/turn.ts`)
  - Target: gains `images?: readonly ImageAttachment[]`.
- `CatalogModelOverride` (`packages/nax-agent/src/config/catalog-overrides.ts`) and `CatalogModelOverrideSchema` (`packages/nax/src/config/schemas-model.ts`)
  - Target: both gain optional `input`.

`TranscriptDoc.schemaVersion` stays `?: 1` in memory: the on-disk `2` never leaves the file store.

Re-exports: `ImageAttachment` is exported from nax-ai's root `src/index.ts`; nax-agent re-exports it as a type through `src/cost/standard-types.ts` (the allow-listed nax-ai site) and from `.`, together with `SendInput`, `validateImageAttachments`, `IMAGE_MIME_TYPES`, `MAX_IMAGES_PER_MESSAGE`, `MAX_IMAGE_BASE64_CHARS`, `MAX_REQUEST_IMAGES`, `MAX_REQUEST_IMAGE_BASE64_CHARS` and `IMAGE_TOKEN_ESTIMATE`. `api/nax-agent.api.txt` is regenerated with `bun run api:update` from `packages/nax-agent`; `packages/nax-agent-acp` runs `bun run api:update` if its `./client` surface changes.

Patterns to follow: nax-agent-acp `src/` may import only `@nathapp/nax-agent` (public entry), the ACP SDK, the MCP SDK, zod and `node:` builtins; nax-agent shipped source uses no Bun API (`node:fs/promises`, `node:crypto` for SHA-256); `#src/` imports and `.ts` extensions on relative imports in nax-agent `src/`; every new `NaxError` carries `stage` in its context. `packages/nax-ai/test/protocols/pi-client.test.ts` is 984 lines, so new nax-ai image tests go in a new file.

### Failure Handling

| Case | Behaviour |
|---|---|
| `send` with an invalid image list | throws `AGENT_SESSION_INVALID_INPUT` synchronously; no turn claimed; session stays usable |
| `send` with images on a backend without `acceptsImages` | throws `AGENT_SESSION_CAPABILITY_UNSUPPORTED` `{ capability: "images" }` synchronously |
| native turn with images on a text-only model | the turn fails with `NATIVE_IMAGE_INPUT_UNSUPPORTED`; no model call; no transcript save |
| ACP turn with images on an agent without `promptCapabilities.image` | the turn fails with `ACP_IMAGE_INPUT_UNSUPPORTED`; no `session/prompt` |
| request over the image budget | oldest images from earlier turns dropped from the wire copy only, with a text note; never an error |
| stored image file missing, `ref` not 64 lowercase hex, or stored `mimeType` outside the table | image dropped on load, `[image missing]` appended; never an error; never a read outside the folder |
| on-disk `schemaVersion` above 2 | load throws `TRANSCRIPT_SCHEMA_UNSUPPORTED` |
| write of an image whose `mimeType` is outside the table | write rejects with `TRANSCRIPT_IMAGE_TYPE_UNSUPPORTED`; nothing written |
| image file write fails | the save rejects with the underlying error; the transcript file keeps its previous content; no partial image file is left under its final name |

## Out of Scope

- Any `nax chat` change: clipboard, ctrl+v, pasted paths, `@` image mentions, `/image`, the capability gate in the UI, transcript notes, replay, brain-switch notes. That is feature 2, `chat-image-attachments`.
- Copying image parts in the chat ACP recorder (`packages/nax/src/chat/acp/acp-recorder.ts`, `acp-transcript-append.ts`) and the brain-switch handoff (`acp-handoff-entries.ts`). Feature 2.
- The nax ACP server accepting images: `packages/nax-agent-acp/src/server/` keeps `image: false` and keeps rejecting image blocks.
- Resizing, cropping or re-encoding images, and reading pixel dimensions from image bytes (feature 2 reads headers).
- Image output from tools: the Read tool, MCP image results (still `[image omitted: <mime>]`), screenshots.
- `nax run`, `nax plan`, bot and subagent prompts sending images.
- Verifying that pi-ai's openai-codex path sends user images; a provider whose catalog `input` includes `"image"` is trusted.
- History images after a native switch to a text-only model under `carryHistoryAcrossModels`: pi-ai itself replaces them with the text "(image omitted: model does not support images)"; nax adds nothing. Feature 2 shows its own notes.
- Removing image files of messages that compaction dropped; they stay until the transcript is deleted.
- `ResolvedModel.input` for a new model id introduced on a bundled provider by a `ProviderOverride` that declares no `input`: the resolved model has no `input` (so `imageInput` reports `false`) even though pi model synthesis inherits the template's `input`. Such a model must declare `input` to accept images.
- A version check in older nax releases: a nax without this feature cannot recognise an on-disk `schemaVersion: 2`. Accepted.

## Stories

**US-001: Image parts and image input in nax-ai.** No dependencies. Workdir: `packages/nax-ai`. Add `ImageAttachment` and the user `images` field, map images in `toPiMessages`, add `input` to `RawModel` and `ResolvedModel`, copy pi-ai's `input` in `defaultProviders()`, carry it through `normaliseCatalog` (keeping a replaced entry's `input` when an override declares none), and honour a declared override `input` in pi model synthesis on both the bundled-provider and introduced-provider paths.

**US-002: Image limits and validation.** Depends on US-001. Workdir: `packages/nax-agent`. Add `src/session/image-input.ts` with the six constants, `SendInput` and `validateImageAttachments`; re-export `ImageAttachment` through `src/cost/standard-types.ts`; export all of them from `.` and regenerate the API snapshot.

**US-003: Image input on the session facade.** Depends on US-002. Workdir: `packages/nax-agent`. Add `AgentSession.send(message, input?)`, optional `AgentSession.acceptsImages?`, `OpenedBackend.acceptsImages?`, `SendTurnOpts.images`, the `claimTurn` hand-off, the `AGENT_SESSION_INVALID_INPUT` code, and the facade's implementation of both members.

**US-004: Native turns send images.** Depends on US-003. Workdir: `packages/nax-agent`. Add `NativeSessionAdapter.imageInput(handle)`, the native backend's `acceptsImages`, the `NATIVE_IMAGE_INPUT_UNSUPPORTED` refusal and the image-carrying turn seed, and forward `CatalogModelOverride.input` in `toProviderOverrides`.

**US-005: Native request image budget.** Depends on US-004. Workdir: `packages/nax-agent`. Add `capRequestImages` in a new `src/native/session/image-context.ts` and call it in the `turn-complete-step.ts` request wrapper.

**US-006: Images in compaction.** Depends on US-005. Workdir: `packages/nax-agent`. Add `imagesAsNotes` to `src/native/session/image-context.ts` (created by US-005), call it in `summarizeAndApply`, and extend `estimateTokens`.

**US-007: Write images to the transcript sidecar.** Depends on US-002. Workdir: `packages/nax-agent`. Add `src/native/session/transcript-images.ts` with the write-side split (folder naming, closed extension table, content-addressed files, stored shape, recomputed on-disk `schemaVersion`) and wire it into the file store's write path.

**US-008: Read images back and manage the folder.** Depends on US-007. Workdir: `packages/nax-agent`. Add the read-side rehydration to `transcript-images.ts`, wire it into `readTranscriptDoc` (version check, `[image missing]`, no `schemaVersion` in the returned doc), and extend `deleteTranscript`, `retainTranscript` and `pruneRetainedTranscripts` to the folder.

**US-009: ACP client sends images.** Depends on US-003. Workdir: `packages/nax-agent-acp`. Add `image` to `CapabilityRecord`, the backend's `acceptsImages`, the post-`liveFor` `ACP_IMAGE_INPUT_UNSUPPORTED` refusal, `TurnInput.images`, and image blocks on the first `session/prompt` of a turn.

**US-010: Declare image input for a custom model.** Depends on US-004. Workdir: `packages/nax`. Add `input` to `CatalogModelOverrideSchema` and its `agent.native.catalogOverrides.input` description in `src/cli/config-descriptions.ts`.

### Context Files

**US-001**
- `packages/nax-ai/src/protocols/types.ts`
- `packages/nax-ai/src/protocols/pi-client.ts`
- `packages/nax-ai/src/providers/types.ts`
- `packages/nax-ai/src/providers/catalog.ts`
- `packages/nax-ai/src/providers/pi-catalog.ts`

**US-002**
- `packages/nax-agent/src/cost/standard-types.ts`
- `packages/nax-agent/src/index.ts`

**US-003**
- `packages/nax-agent/src/session/agent-session.ts`
- `packages/nax-agent/src/session/agent-session-turn.ts`
- `packages/nax-agent/src/session/agent-session-types.ts`
- `packages/nax-agent/src/session/session-backend.ts`
- `packages/nax-agent/src/session/session-types.ts`

**US-004**
- `packages/nax-agent/src/native/session-adapter.ts`
- `packages/nax-agent/src/native/session/turn-loop.ts`
- `packages/nax-agent/src/session/native-backend.ts`
- `packages/nax-agent/src/native/models.ts`
- `packages/nax-agent/test/unit/native/session-adapter-client.test.ts`

**US-005**
- `packages/nax-agent/src/native/session/turn-complete-step.ts`
- `packages/nax-agent/test/unit/native/session/loop-events/transform-context.test.ts`
- `packages/nax-agent/src/session/image-input.ts` — created by US-002, read here

**US-006**
- `packages/nax-agent/src/native/session/compaction.ts`
- `packages/nax-agent/src/native/session/turn-compaction-step.ts`
- `packages/nax-agent/test/unit/native/turn-loop-compaction.test.ts`
- `packages/nax-agent/src/native/session/image-context.ts` — created by US-005, extended here

**US-007**
- `packages/nax-agent/src/native/session/transcript-store.ts`
- `packages/nax-agent/src/native/session/transcript-types.ts`
- `packages/nax-agent/src/native/session/transcript-identity.ts`

**US-008**
- `packages/nax-agent/src/native/session/transcript-store.ts`
- `packages/nax-agent/src/native/session/memory-transcript-store.ts`
- `packages/nax-agent/src/native/session/transcript-images.ts` — created by US-007, extended here

**US-009**
- `packages/nax-agent-acp/src/client/capabilities.ts`
- `packages/nax-agent-acp/src/client/backend.ts`
- `packages/nax-agent-acp/src/client/turn.ts`

**US-010**
- `packages/nax/src/config/schemas-model.ts`
- `packages/nax/src/cli/config-descriptions.ts`

### Creates

**US-001**
- `packages/nax-ai/test/protocols/pi-client-images.test.ts`

**US-002**
- `packages/nax-agent/src/session/image-input.ts`
- `packages/nax-agent/test/unit/session/image-input.test.ts`

**US-003**
- `packages/nax-agent/test/unit/session/agent-session-images.test.ts`

**US-004**
- `packages/nax-agent/test/unit/native/session-adapter-images.test.ts`

**US-005**
- `packages/nax-agent/src/native/session/image-context.ts`
- `packages/nax-agent/test/unit/native/session/image-context.test.ts`

**US-006**
- `packages/nax-agent/test/unit/native/session/image-compaction.test.ts`

**US-007**
- `packages/nax-agent/src/native/session/transcript-images.ts`
- `packages/nax-agent/test/unit/native/session/transcript-images-write.test.ts`

**US-008**
- `packages/nax-agent/test/unit/native/session/transcript-images-read.test.ts`

**US-009**
- `packages/nax-agent-acp/test/unit/client/backend-images.test.ts`

### Modifies

**US-001**
- `packages/nax-ai/src/index.ts` — export the `ImageAttachment` type. No other change.

**US-002**
- `packages/nax-agent/src/cost/standard-types.ts` — add `ImageAttachment` to the nax-ai type re-export. No other change.
- `packages/nax-agent/src/index.ts` — export `ImageAttachment`, `SendInput`, `validateImageAttachments` and the six image constants from `.`.
- `packages/nax-agent/api/nax-agent.api.txt` — regenerated by `bun run api:update` for the new `.` exports.

**US-003**
- `packages/nax-agent/api/nax-agent.api.txt` — regenerated by `bun run api:update` if the widened `AgentSession` and `SendTurnOpts` declarations change the snapshot.

**US-004**
- `packages/nax-agent/test/unit/native/provider-overrides.test.ts` — gains the `input` forwarding cases; existing assertions unchanged.

**US-005**
- `packages/nax-agent/test/unit/native/session/loop-events/transform-context.test.ts` — no assertion changes; listed so the story keeps its "wire is the caller's array by reference" identity test green, which `capRequestImages` preserves by returning the input array when nothing is dropped.

**US-006**
- `packages/nax-agent/test/unit/native/compaction.test.ts` — gains the image `estimateTokens` cases; existing assertions unchanged.

**US-007**
None. The write path is extended without changing any existing assertion: a document with no images is written byte-for-byte as today.

**US-008**
- `packages/nax-agent/test/unit/native/transcript-store.test.ts` — gains the folder delete, retain and prune cases; existing assertions unchanged.

**US-009**
- `packages/nax-agent-acp/test/unit/client/capabilities.test.ts` — the two whole-record `toEqual` assertions on `buildCapabilityRecord(FULL_INIT, CLAUDE)` and `buildCapabilityRecord({ protocolVersion: 1 }, undefined)` gain `image: false` (neither fixture advertises `promptCapabilities.image`); the invariant becomes "the record lists every capability field, `image` included".
- `packages/nax-agent-acp/test/unit/client/resume.test.ts` — the `RECORD: CapabilityRecord` fixture gains `image: false` so it still satisfies the widened type; no assertion changes.

**US-010**
- `packages/nax/test/unit/config/catalog-overrides-schema.test.ts` — gains the `input` accept and reject cases; existing assertions unchanged.

### Seams

- US-003 → US-004, US-009: `SendTurnOpts.images` is produced by `claimTurn` (US-003) and consumed by both backends' `sendTurn`. US-004 and US-009 each carry a test that drives `AgentSession.send(message, { images })` through `createAgentSession` and asserts what reaches the model client or the agent.
- US-003 → US-004, US-009: `OpenedBackend.acceptsImages` is declared in US-003 and implemented by both backends; each consumer story asserts the facade's `acceptsImages()` returns its backend's answer.
- US-001 → US-004: `ResolvedModel.input` (US-001) decides `NativeSessionAdapter.imageInput` and the native refusal (US-004).
- US-002 → US-003, US-005, US-006: the image constants and `validateImageAttachments` (US-002) are used by the facade, `capRequestImages` and `estimateTokens`.
- US-007 → US-008: the stored image shape and folder naming (US-007) are what the read side (US-008) rehydrates.
- US-004 → US-010: `CatalogModelOverride.input` forwarding (US-004) is what the nax schema field (US-010) feeds.

## Acceptance Criteria

### US-001

1. [unit] `toPiContext` on a request whose only message is `{ role: "user", content: "what is this", images: [{ mimeType: "image/png", data: "AAAA" }] }` yields a first pi message whose `content` is the array `[{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "what is this" }]`.
2. [unit] `toPiContext` on a user message with two images yields image parts in the same order as the `images` list, both before the text part.
3. [unit] `toPiContext` on a user message with `content: ""` and one image yields a `content` array holding only the image part.
4. [unit] `toPiContext` on a user message whose image carries `width: 10`, `height: 20` and `source: "clipboard"` yields an image part whose keys are exactly `type`, `data` and `mimeType`.
5. [unit] `toPiContext` on `{ role: "user", content: "hi" }` yields a first pi message whose `content` is the string `"hi"`.
6. [unit] `toPiContext` on `{ role: "user", content: "hi", images: [] }` yields a first pi message whose `content` is the string `"hi"`.
7. [unit] `normaliseCatalog` over a `RawProvider` whose model declares `input: ["text", "image"]` resolves that model with `input` equal to `["text", "image"]`.
8. [unit] `normaliseCatalog` over a `RawModel` with no `input` resolves a model that has no `input` key.
9. [unit] `normaliseCatalog` with a `ProviderOverride` model that has no `input` and replaces a raw model of the same provider and id declaring `input: ["text", "image"]` resolves the override's model with `input` equal to `["text", "image"]`.
10. [unit] `normaliseCatalog` with a `ProviderOverride` model declaring `input: ["text"]` that replaces a raw model declaring `input: ["text", "image"]` resolves `input` equal to `["text"]`.
11. [unit] In `defaultProviders()`, every resolved model's `input` equals the `input` of the pi-ai catalog model it was built from.
12. [unit] A client built with a `ProviderOverride` that introduces a new provider with a model declaring `input: ["text", "image"]` synthesises a pi model whose `input` is `["text", "image"]`.
13. [unit] A client built with a `ProviderOverride` that introduces a new provider with a model declaring no `input` synthesises a pi model whose `input` is `["text"]`.
14. [unit] A client built with a `ProviderOverride` on a bundled provider whose override model declares `input: ["text"]` synthesises a pi model whose `input` is `["text"]`, even when the picked template's `input` includes `"image"`.
15. [unit] A client built with a `ProviderOverride` on a bundled provider whose override model declares no `input` synthesises a pi model whose `input` equals the picked template's `input`.

### US-002

1. [unit] `validateImageAttachments([{ mimeType: "image/png", data: "AAAA" }])` returns `undefined`.
2. [unit] `validateImageAttachments` on 11 valid images returns a reason naming the limit `10`.
3. [unit] `validateImageAttachments([{ mimeType: "image/bmp", data: "AAAA" }])` returns a reason naming `image/bmp`.
4. [unit] `validateImageAttachments([{ mimeType: "image/png", data: "" }])` returns a reason that says the image data is empty.
5. [unit] `validateImageAttachments([{ mimeType: "image/png", data: "AA$A" }])` returns a reason that says the image data is not base64.
6. [unit] `validateImageAttachments([{ mimeType: "image/png", data: "AA" }])` returns a reason that says the image data is not base64, because its length is not a multiple of 4.
7. [unit] `validateImageAttachments` on one image whose `data` is `MAX_IMAGE_BASE64_CHARS + 4` base64 characters (a multiple of 4) returns a reason naming the per-image limit.
8. [unit] `validateImageAttachments` on one image whose `data` is exactly `MAX_IMAGE_BASE64_CHARS` base64 characters returns `undefined`.
9. [unit] `validateImageAttachments([{ mimeType: "image/png", data: "AAAA", width: 0, height: 10 }])` returns a reason naming `width`.
10. [unit] `validateImageAttachments([{ mimeType: "image/png", data: "AAAA", width: 10, height: 2.5 }])` returns a reason naming `height`.
11. [unit] `validateImageAttachments` on five images of `MAX_IMAGE_BASE64_CHARS` characters each (total above `MAX_REQUEST_IMAGE_BASE64_CHARS`) returns a reason naming the total limit.
12. [unit] `validateImageAttachments` on 11 images where the first has `mimeType: "image/bmp"` returns the count reason, because the count check runs first.
13. [unit] `IMAGE_MIME_TYPES` imported from the nax-agent `.` entry equals `["image/png", "image/jpeg", "image/gif", "image/webp"]`.
14. [unit] `MAX_IMAGES_PER_MESSAGE` imported from the nax-agent `.` entry equals `10`.
15. [unit] `MAX_IMAGE_BASE64_CHARS` imported from the nax-agent `.` entry equals `5242880`.
16. [unit] `MAX_REQUEST_IMAGES` imported from the nax-agent `.` entry equals `20`.
17. [unit] `MAX_REQUEST_IMAGE_BASE64_CHARS` imported from the nax-agent `.` entry equals `20971520`.
18. [unit] `IMAGE_TOKEN_ESTIMATE` imported from the nax-agent `.` entry equals `1600`.
19. [unit] `validateImageAttachments` imported from the nax-agent `.` entry returns `undefined` for one valid PNG image.

### US-003

1. [unit] On a session created with `createAgentSession` over a fake backend whose adapter records `sendTurn` calls and which implements `acceptsImages`, iterating `send("look", { images: [img] })` calls the adapter's `sendTurn` with prompt `"look"` and opts whose `images` equal `[img]`.
2. [unit] On that session, iterating `send("look")` calls `sendTurn` with opts that have no `images` key.
3. [unit] On that session, iterating `send("look", { images: [] })` calls `sendTurn` with opts that have no `images` key.
4. [unit] On that session, `send("look", { images: [{ mimeType: "image/bmp", data: "AAAA" }] })` throws `AgentSessionError` with code `AGENT_SESSION_INVALID_INPUT` synchronously.
5. [unit] After that refusal the adapter's `sendTurn` has not been called.
6. [unit] After that refusal, iterating `send("next")` on the same session calls `sendTurn` with prompt `"next"`.
7. [unit] On a session whose fake backend has no `acceptsImages`, `send("look", { images: [img] })` throws `AgentSessionError` with code `AGENT_SESSION_CAPABILITY_UNSUPPORTED` synchronously.
8. [unit] That refusal's error context has `capability` equal to `"images"`.
9. [unit] On a session whose fake backend has no `acceptsImages`, iterating `send("look")` calls `sendTurn` with prompt `"look"`.
10. [unit] On a session with a turn in flight, `send("look", { images: [{ mimeType: "image/bmp", data: "AAAA" }] })` throws `AGENT_SESSION_BUSY`, because the busy check runs before image validation.
11. [unit] `acceptsImages()` on the facade resolves `false` when the backend has no `acceptsImages`.
12. [unit] `acceptsImages()` on the facade resolves `true` when the backend's `acceptsImages` resolves `true`.
13. [unit] `acceptsImages()` on the facade resolves `false` when the backend's `acceptsImages` resolves `false`.
14. [unit] `acceptsImages()` on a closed facade session rejects with `AgentSessionError` code `AGENT_SESSION_CLOSED`.
15. [unit] `new AgentSessionError("x", "AGENT_SESSION_INVALID_INPUT")` has `code` `"AGENT_SESSION_INVALID_INPUT"`.

### US-004

1. [unit] With `_clientDeps.build` stubbed to a client whose `model()` resolves a `ResolvedModel` with `input: ["text", "image"]`, `NativeSessionAdapter.imageInput(handle)` resolves `true`.
2. [unit] With the stubbed client's model `input` set to `["text"]`, `imageInput(handle)` resolves `false`.
3. [unit] With the stubbed client's model having no `input`, `imageInput(handle)` resolves `false`.
4. [unit] Native `sendTurn` with `opts.images` equal to `[img]`, on the stubbed image-capable model, calls the client's `complete` with a last message `{ role: "user", content: <prompt>, images: [img] }`.
5. [unit] Native `sendTurn` with no `opts.images` calls the client's `complete` with a last message `{ role: "user", content: <prompt> }` that has no `images` key.
6. [unit] Native `sendTurn` with `opts.images` equal to `[img]` on the stubbed text-only model rejects with `NaxError` code `NATIVE_IMAGE_INPUT_UNSUPPORTED`.
7. [unit] After that `NATIVE_IMAGE_INPUT_UNSUPPORTED` rejection, the stubbed client's `complete` has not been called.
8. [unit] After that `NATIVE_IMAGE_INPUT_UNSUPPORTED` rejection, the session's memory transcript store holds no document for the session.
9. [unit] Native `sendTurn` with images on the image-capable model, with a `before_turn` handler registered through `createLoopEventRegistry().register("before_turn", ...)` that returns a one-message user-role seed patch, calls `complete` with the patch's message as the last message and no `images` key.
10. [unit] After a native `sendTurn` with `[img]` on the image-capable model, the transcript document saved to the session's memory store holds the user message with `images` equal to `[img]`.
11. [integration] A session from `createAgentSession` over `nativeBackend`, with `_clientDeps.build` stubbed to the image-capable model: iterating `send("look", { images: [img] })` makes the stubbed client's `complete` receive a last message whose `images` equal `[img]`.
12. [integration] The same session with the stubbed text-only model: iterating `send("look", { images: [img] })` yields a turn end with status `errored` and error code `NATIVE_IMAGE_INPUT_UNSUPPORTED`.
13. [integration] `acceptsImages()` on a `nativeBackend` session resolves `true` with the stubbed image-capable model.
14. [integration] `acceptsImages()` on a `nativeBackend` session resolves `false` with the stubbed text-only model.
15. [unit] `toProviderOverrides` on an override model declaring `input: ["text", "image"]` returns a model whose `input` is `["text", "image"]`.
16. [unit] `toProviderOverrides` on an override model with no `input` returns a model that has no `input` key.

### US-005

1. [unit] `capRequestImages` on messages holding 3 small images in total returns the same array reference it was given.
2. [unit] `capRequestImages` on 25 user messages holding one small image each keeps the images of the newest 20 messages.
3. [unit] In that 25-message case, each of the 5 oldest messages has no `images` key and its `content` ends with `\n[image from an earlier turn dropped from context: image/png]`.
4. [unit] `capRequestImages` on three single-image messages whose `data` lengths are 10,000,000, 10,000,000 and 5,000,000 (oldest first) keeps the two newest images and drops the oldest.
5. [unit] `capRequestImages` on three single-image messages whose `data` lengths, newest first, are 15,000,000, 10,000,000 and 1,000,000 keeps the newest and the oldest and drops the middle one.
6. [unit] `capRequestImages` on one message holding two images when only one more fits keeps the message's last image and drops its first.
7. [unit] After `capRequestImages` drops images, the input array still holds every original message with every original image.
8. [unit] `capRequestImages` returns assistant and tool-result messages deep-equal to the input ones.
9. [unit] When `capRequestImages` drops the only image of a user message whose `content` is `""`, that message's `content` becomes exactly `[image from an earlier turn dropped from context: image/png]`.
10. [unit] `completeWithRecovery` called with 25 single-image user messages and a `deps.complete` that captures its `messages` argument passes exactly 20 images to `deps.complete`.
11. [unit] In that `completeWithRecovery` call, the returned `messages` still hold all 25 images.
12. [unit] `completeWithRecovery` with a `transform_context` handler registered through `createLoopEventRegistry().register("transform_context", ...)` that returns the messages with 25 images while `anchorIndex` is `undefined` passes at most 20 images to `deps.complete`.
13. [unit] `completeWithRecovery` with no handler and 3 images passes `deps.complete` the caller's `messages` array by reference.

### US-006

1. [unit] `imagesAsNotes` on `{ role: "user", content: "see", images: [{ mimeType: "image/png", data: "AAAA", width: 640, height: 480 }] }` returns `{ role: "user", content: "see\n[image: image/png 640x480]" }` with no `images` key.
2. [unit] `imagesAsNotes` on an image with no `width` returns content ending with `[image: image/png]`.
3. [unit] `imagesAsNotes` returns a user message with no images deep-equal to the input.
4. [unit] `imagesAsNotes` leaves its input array and messages unchanged.
5. [unit] When proactive compaction runs (fixture pattern of `test/unit/native/turn-loop-compaction.test.ts`: compaction enabled and a context window the history exceeds) over a span holding a user message with an image, the `messages` argument of the stubbed `deps.summarize` has no `images` key on any message.
6. [unit] In that compaction run, the stubbed `deps.summarize` receives the `[image: image/png ...]` note in that user message's content.
7. [unit] `estimateTokens({ role: "user", content: "", images: [{ mimeType: "image/png", data: "AAAA" }] })` returns `1600`.
8. [unit] `estimateTokens` on a user message with an empty `content` and one image of `width: 100`, `height: 75` returns `10`.
9. [unit] `estimateTokens` on a user message with an empty `content` and one image of `width: 4000`, `height: 3000` returns `1600`.
10. [unit] `estimateTokens` on a user message with 8 characters of `content` and two images without dimensions returns `3202`.

### US-007

1. [unit] Saving through `createFileTranscriptStore(dir)` a document whose user message has one PNG image writes `<dir>/<session>.transcript.images/<sha256>.png`, where `<sha256>` is the lowercase hex SHA-256 of the base64-decoded `data`.
2. [unit] That written file's bytes equal the base64-decoded `data`.
3. [unit] The saved JSON document's image entry has `ref` equal to that hash.
4. [unit] The saved JSON document's image entry has no `data` key.
5. [unit] The saved JSON document's image entry keeps `mimeType`, `width`, `height` and `source` as given.
6. [unit] The saved JSON document has `schemaVersion` equal to `2` when it contains an image.
7. [unit] Saving a document with no images writes a JSON document with no `schemaVersion` key.
8. [unit] Saving a document with no images creates no `.transcript.images` folder.
9. [unit] Saving two messages that carry the same image bytes writes one file in the folder.
10. [unit] An `image/jpeg` image is written with the `jpg` extension.
11. [unit] An `image/gif` image is written with the `gif` extension.
12. [unit] An `image/webp` image is written with the `webp` extension.
13. [unit] Saving a document whose image has `mimeType: "image/bmp"` rejects with `NaxError` code `TRANSCRIPT_IMAGE_TYPE_UNSUPPORTED`.
14. [unit] After that rejection, no transcript file exists for the session.
15. [unit] When writing the image file fails (the folder path is occupied by a regular file), `save` rejects and the transcript file keeps its previous content.
16. [unit] `saveTranscript(dir, session, messages)` with an image writes the same folder file and a document whose image entry has a `ref`.
17. [unit] Saving an image-free document with no `schemaVersion` over a document that held an image writes no `schemaVersion` key.
18. [unit] When renaming a staged image file into place fails once (through the store's file-system seam), `save` rejects; a second `save` of the same document then succeeds and `load` returns the image with `data` equal to the original.

### US-008

1. [unit] `load` after saving a document with one PNG image returns the user message with `images` deep-equal to the original list.
2. [unit] The loaded image has no `ref` key.
3. [unit] A document stored on disk with `schemaVersion: 2` loads with no `schemaVersion` key.
4. [unit] Saving then loading an image-free document with `schemaVersion: 1` returns it with `schemaVersion` equal to `1`.
5. [unit] `load` on a message with `content: "x"` whose two stored images are both missing returns `content` equal to `"x\n[image missing]\n[image missing]"`.
6. [unit] `load` on a document whose image file was deleted returns that user message with no image and with `content` ending in `\n[image missing]`.
7. [unit] `load` on a document whose stored image `ref` is `"../escape"` returns that message with no image and with `content` ending in `\n[image missing]`.
8. [unit] With a file named `escape.png` placed one level above the folder, that `"../escape"` load still returns `[image missing]` (the file is not read).
9. [unit] `load` on a document whose stored image has `mimeType: "text/plain"` and a valid `ref` returns that message with no image and with `content` ending in `\n[image missing]`.
10. [unit] `load` on an on-disk document with `schemaVersion: 3` rejects with `NaxError` code `TRANSCRIPT_SCHEMA_UNSUPPORTED`.
11. [unit] `load` on a document written before this feature (no `schemaVersion`, string-only user messages) returns it deep-equal to what was written.
12. [unit] `markTurn` on a session whose document holds an image leaves the image loadable afterwards.
13. [unit] A native turn on a session whose file store holds an earlier user message with an image (the history loaded through `historyFromTranscript`) completes without `TRANSCRIPT_SCHEMA_UNSUPPORTED`.
14. [unit] `delete` removes the live `.transcript.images` folder.
15. [unit] `retainFailed` renames the live folder to `<session>.transcript.failed-<stamp>.images`, with the same stamp as the renamed transcript file.
16. [unit] `pruneRetainedTranscripts` removes the `.images` folder of each transcript file it deletes.
17. [unit] `pruneRetainedTranscripts` keeps the `.images` folders of the transcript files it keeps.
18. [unit] `createMemoryTranscriptStore` round-trips a document with an image deep-equal, `data` included.

### US-009

1. [unit] `buildCapabilityRecord` on an initialize reply whose `agentCapabilities.promptCapabilities.image` is `true` returns a record with `image: true`.
2. [unit] `buildCapabilityRecord` on a reply with `promptCapabilities: { image: false }` returns `image: false`.
3. [unit] `buildCapabilityRecord` on a reply with no `promptCapabilities` returns `image: false`.
4. [unit] Against the in-memory fake agent (`_acpBackendDeps.launch`) advertising `promptCapabilities.image: true`, `acceptsImages()` on the session resolves `true`.
5. [unit] Against a fake agent advertising no image capability, `acceptsImages()` resolves `false`.
6. [unit] Against the fake agent advertising images, iterating `send("look", { images: [img] })` makes the agent receive one `session/prompt` whose `prompt` is `[{ type: "image", mimeType: img.mimeType, data: img.data }, { type: "text", text: "look" }]`.
7. [unit] With two images, the `session/prompt` blocks are both image blocks in list order, then the text block.
8. [unit] The image blocks sent carry no `width`, `height` or `source` keys.
9. [unit] Iterating `send("look")` sends a `session/prompt` whose `prompt` is exactly `[{ type: "text", text: "look" }]`.
10. [unit] On the first turn of a session with instructions, the `session/prompt` holds the image blocks and then one text block holding the instructions and the prompt joined as today.
11. [unit] Against a fake agent advertising no image capability, iterating `send("look", { images: [img] })` yields a turn end with status `errored` and error code `ACP_IMAGE_INPUT_UNSUPPORTED`.
12. [unit] After that `ACP_IMAGE_INPUT_UNSUPPORTED` turn, the fake agent has received no `session/prompt`.
13. [unit] When the fake agent stops a turn sent with `[img]` as `cancelled` right after a denied permission and the client continues the turn, the continuation `session/prompt` received by the fake agent holds only text blocks.
14. [unit] When the first fake process (advertising images) dies, a text turn is sent (reconnecting to a second fake process that advertises no image capability), then `acceptsImages()` resolves `false`.
15. [unit] After that reconnect, iterating `send("look", { images: [img] })` yields a turn end with error code `ACP_IMAGE_INPUT_UNSUPPORTED`.

### US-010

1. [unit] `CatalogModelOverrideSchema` accepts a model with `input: ["text", "image"]` and the parsed value keeps `input` equal to `["text", "image"]`.
2. [unit] `CatalogModelOverrideSchema` accepts a model with no `input` and the parsed value has no `input` key.
3. [unit] `CatalogModelOverrideSchema` rejects `input: ["video"]`.
4. [unit] `CatalogModelOverrideSchema` rejects `input: []`.
5. [unit] The config description map has a non-empty entry for `agent.native.catalogOverrides.input`.
6. [unit] `NaxConfigSchema.safeParse` on a config whose `agent.native.catalogOverrides[0].models[0]` declares `input: ["text", "image"]` succeeds, and the parsed config keeps that model's `input` equal to `["text", "image"]`.

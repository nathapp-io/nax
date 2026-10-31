# SPEC: Image attachments in nax chat

## Summary

In `nax chat` the user can attach a picture to a message and the brain sees it with the text. ctrl+v reads an image from the system clipboard, pasting or dragging an image file's path attaches that file, `/image [path]` does either from a slash command, and `@shot.png` attaches a mentioned image file. An attachment shows in the input as the placeholder `[Image #N]`. On send, nax checks that the current brain reads images, builds the image list from the placeholders still in the text, and passes it to the session through `ChatHost.send` and `session.send(message, { images })`. The transcript shows one note row per image, `image 1 · png · 1280×720 · 342 KB · clipboard`, live and on resume. An ACP brain gets the images too, its recorded turns keep them, and a brain-switch handoff turns each earlier image into a one-line text note.

This is feature 2 of 2 in the approved design `docs/superpowers/specs/2026-10-31-nax-chat-image-attachments-design.md` (§7 item 2). Feature 1, `image-content-parts` (#2758), shipped the layers below: nax-ai `ImageAttachment`, `AgentSession.send(message, { images })`, `AgentSession.acceptsImages?()`, the limits in `@nathapp/nax-agent`, transcript image storage and ACP image blocks. Everything here is in `packages/nax`. It is one capability (attaching images in chat); the fourteen stories come from the 24-assertion story gate and one module per story, not from separate features.

## Motivation

- The user wants image input in `nax chat` for parity with Claude Code and Codex (user, 2026-10-31). Typical uses: a screenshot of a broken TUI render, a web page, an error dialog.
- Feature 1 made images travel from `AgentSession.send` to the model and to disk, but nothing in chat can create one: the clipboard module is write-only (`packages/nax/src/tui/chat/clipboard.ts`), ctrl+v is ignored by the line editor (`line-editor.ts` `ctrlResult`), a pasted path is inserted as text, and an `@shot.png` mention sends only its path (`mention-expand.ts` `contentRecord`, `PATH_ONLY_BINARY`).
- `ChatHost.send(message, onEvent, options)` and `runChatTurn` call `session.send(message)` with text only, and the ACP recorder (`chat/acp/acp-recorder.ts`) wraps `send(message)` without an input and without `acceptsImages`.

## Design

### Approach

Attachments live in the chat screen, next to the input draft, not in it: `InputDraft` (`ChatInput.tsx`) is unchanged and a separate pure `ImageDraft` holds the numbered attachments. The line editor stays pure. ChatApp does the I/O through a new hook module, `use-image-attach.ts`, which owns the `ImageDraft` and the deps seam for the clipboard and file reads.

Image numbers: every attachment takes the draft's next number, starting at 1. On send, only images whose placeholder `[Image #N]` is still in the text travel, ordered by the first appearance of their placeholder, and the placeholders are renumbered `1..k` in that order (every occurrence of a number is rewritten). So "image 1" in the text the model sees is always the first image part. Images from `@` mentions come after the placeholder images, in mention order, and carry no placeholder: the mention envelope record names their path. (**Claude** call: renumbering is not in the design doc; it keeps the transcript rows, replay and the model's view consistent when a placeholder was deleted.)

Capability: `ChatHost.acceptsImages?()` asks the open session (`session.acceptsImages?.()`, from feature 1). A brain that cannot read images refuses a send that has placeholder images, keeps the draft and says why. A mentioned image on such a brain degrades to today's path-only record instead of refusing the send, so `@` mentions on a text-only model behave as before. (**Claude** call.)

ctrl+v with no image on the clipboard shows `no image on the clipboard`; nax does not try to paste clipboard text (the design left this to the builder; a terminal never pastes text on ctrl+v, so the hint cannot follow a text paste).

### Image files (`packages/nax/src/chat/images/`, exported from `@/chat`)

`image-sniff.ts` holds `ImageFormat`, `SniffedImage` and `sniffImage`; `image-file.ts` holds the rest and imports `./image-sniff`; `index.ts` re-exports both. Code outside the folder (`@/chat` itself, `mention-expand.ts`) imports through the `index.ts` barrel.

```ts
import type { ImageAttachment } from "@nathapp/nax-agent";

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";
export interface SniffedImage {
  readonly format: ImageFormat;
  readonly mimeType: string; // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  readonly width?: number;
  readonly height?: number;
}
export const MAX_IMAGE_EDGE_PX = 8000;
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined;
export function imageFromBytes(bytes: Uint8Array, source: string): { readonly image: ImageAttachment } | { readonly refusal: string };
export function imageFormatOf(mimeType: string): string;          // "png" | "jpeg" | "gif" | "webp", else "image"
export function imageRawBytes(image: ImageAttachment): number;     // decoded size of image.data
export function imageSizeLabel(bytes: number): string;             // "342 KB", "1.5 MB"
export function imageDescription(image: ImageAttachment): string;  // "png · 1280×720 · 342 KB"
export function imageNoteLabel(number: number, image: ImageAttachment): string; // "image 1 · png · 1280×720 · 342 KB · clipboard"
```

`sniffImage` decides the format from magic bytes only, never from a file name, and reads dimensions from the header:

| Format | Magic | Width / height |
|---|---|---|
| PNG | bytes 0-7 `89 50 4E 47 0D 0A 1A 0A` | big-endian u32 at offsets 16 and 20 (IHDR) |
| GIF | ASCII `GIF87a` or `GIF89a` at 0 | little-endian u16 at offsets 6 and 8 |
| JPEG | bytes 0-2 `FF D8 FF` | walk the markers from offset 2: skip `FF` fill bytes; the stand-alone markers `01` and `D0`-`D8` have no length; every other marker is followed by a big-endian u16 segment length (which includes those two bytes) that is skipped. The first SOF marker (`C0`-`CF` except `C4`, `C8`, `CC`) holds height then width as big-endian u16 at offsets 5 and 7 from its `FF`. Reaching SOS (`DA`), EOI (`D9`) or the end of the bytes first gives no dimensions |
| WebP | ASCII `RIFF` at 0 and `WEBP` at 8 | chunk at 12: `VP8 ` = little-endian u16 at 26 and 28, each `& 0x3FFF`; `VP8L` = from the 4 bytes at 21, width `1 + (b0 \| (b1 & 0x3F) << 8)`, height `1 + (b1 >> 6 \| b2 << 2 \| (b3 & 0x0F) << 10)`; `VP8X` = `1 +` little-endian u24 at 24 and 27 |

A recognised format whose header is too short or malformed for its dimensions is returned without `width` and `height`. Anything else is `undefined`.

`imageFromBytes` checks in this order, first failure wins: `sniffImage` returns undefined → `not a PNG, JPEG, GIF or WebP image`; the base64 length `Math.ceil(bytes.length / 3) * 4` is over `MAX_IMAGE_BASE64_CHARS` (`@nathapp/nax-agent`, 5,242,880, so 3,932,160 raw bytes is the largest accepted) → `image is larger than 3.75 MiB`; `width` or `height` over `MAX_IMAGE_EDGE_PX` → `image is larger than 8000 px on a side`. Otherwise it returns `{ image: { mimeType, data: <base64 of bytes>, width?, height?, source } }`, `width` and `height` present only when sniffed.

Labels: `imageRawBytes` is `data.length / 4 * 3` minus the number of trailing `=`. `imageSizeLabel(bytes)` is `${Math.max(1, Math.floor(bytes / 1024))} KB` below 1,048,576 bytes, else `${(bytes / 1_048_576).toFixed(1)} MB`. `imageDescription` joins `imageFormatOf(mimeType)`, `<width>×<height>` (only when both are present; `×` is U+00D7) and the size label with ` · `. `imageNoteLabel(n, image)` is `image <n> · <imageDescription>` followed by ` · <source>` when `source` is present.

### Clipboard read (`packages/nax/src/tui/chat/clipboard-image.ts`)

```ts
export type ClipboardImage =
  | { readonly kind: "image"; readonly bytes: Uint8Array }
  | { readonly kind: "none" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly reason: string };
export type ClipboardRun =
  | { readonly kind: "exited"; readonly exitCode: number; readonly stdout: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "timed-out" };
export const CLIPBOARD_READ_TIMEOUT_MS = 2_000;
export const _clipboardImageDeps: {
  platform: NodeJS.Platform;
  env: () => Record<string, string | undefined>;
  run: (argv: readonly string[], timeoutMs: number) => Promise<ClipboardRun>;
};
export function readClipboardImage(): Promise<ClipboardImage>;
```

| Platform | Command | Image when |
|---|---|---|
| `darwin` | `["osascript", "-e", "the clipboard as «class PNGf»"]` | exit 0 and stdout matches `«data PNGf([0-9A-Fa-f]+)»`; the hex digits decode to the bytes |
| `linux`, `WAYLAND_DISPLAY` non-empty | `["wl-paste", "--no-newline", "--type", "image/png"]` | exit 0 and stdout non-empty; stdout is the bytes |
| `linux` otherwise | `["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]` | exit 0 and stdout non-empty |
| anything else | none | never: `unsupported`, nothing is run |

A non-zero exit, or an exit 0 with no image, is `none`. `missing` (the command is not installed) is `failed` with reason `<argv[0]> is not installed`; `timed-out` is `failed` with `clipboard read timed out`; a `run` rejection is `failed` with the error's message. `run` is always called with `CLIPBOARD_READ_TIMEOUT_MS`. The default `run` spawns the command with stdout piped and stderr ignored, kills it when the timeout passes, and resolves `missing` when the spawn fails because the executable does not exist. Its timer may be a cancelled `setTimeout` (the rule's mid-flight cancel exception; comment the call site).

### Pasted paths (`packages/nax/src/tui/chat/pasted-path.ts`)

`pastedImagePath(chunk: string, cwd: string): string | undefined` is pure (no filesystem). It trims the chunk; an empty chunk or one holding a newline is `undefined`. A chunk starting `file://` becomes the URL's decoded pathname, and a `file://` chunk that does not parse as a URL or whose percent-decoding fails is `undefined` (never a throw: the function runs inside the input's key handler); a chunk wrapped in matching single or double quotes loses them; otherwise each backslash escape `\x` becomes `x`. The result must end in `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` (case-insensitive), else `undefined`. It returns the path resolved against `cwd` (an absolute path stays as is). Whether the file exists and is an image is decided later, by reading it.

`ChatInput` gains an optional prop `onPaste?: (chunk: string) => boolean`. Its `useInput` handler calls it before `editLine` when the input holds more than one code point and neither `key.ctrl`, `key.meta` nor `key.return` is set; when it returns `true` the chunk is not inserted. A single typed character never reaches it.

### The image draft (`packages/nax/src/tui/chat/image-draft.ts`)

```ts
import type { ImageAttachment } from "@nathapp/nax-agent";
import type { EditorState } from "./line-editor";

export interface DraftImage { readonly number: number; readonly image: ImageAttachment }
export interface ImageDraft { readonly next: number; readonly images: readonly DraftImage[] }
export const EMPTY_IMAGE_DRAFT: ImageDraft; // { next: 1, images: [] }
export function imagePlaceholder(number: number): string; // "[Image #<number>]"
export function attachToDraft(draft: ImageDraft, editor: EditorState, image: ImageAttachment):
  | { readonly draft: ImageDraft; readonly editor: EditorState }
  | { readonly refusal: string };
export function imagesForSend(draft: ImageDraft, text: string): { readonly text: string; readonly images: readonly ImageAttachment[] };
```

`attachToDraft` counts the draft images whose placeholder is in `editor.text` ("present"). It refuses with `at most 10 images per message` when 10 (`MAX_IMAGES_PER_MESSAGE`) are present, then with `images in one message must total at most 20 MB` when the present images' `data.length` plus the new one's is over `MAX_REQUEST_IMAGE_BASE64_CHARS`. Otherwise it inserts `imagePlaceholder(draft.next)` at `editor.cursor` (a code-point index, as the line editor uses), puts the cursor after it, appends `{ number: draft.next, image }` and increments `next`. It never changes its inputs.

`imagesForSend` finds every `[Image #<digits>]` in `text` whose number is a draft image, orders those images by first appearance, renumbers them `1..k` in that order, rewrites every occurrence of each known placeholder to its new number, and leaves any other `[Image #N]` text as typed. It returns the rewritten text and the images in that order.

### Attaching in ChatApp (`packages/nax/src/tui/chat/use-image-attach.ts`)

The module exports `_imageAttachDeps = { readClipboard: readClipboardImage, readFile: (path: string) => Promise<Uint8Array | undefined> }` (read at call time, so tests replace its members with `spyOn`) and the hook `useImageAttach(options: { cwd; input: RefObject<ChatInputHandle | undefined>; editor: () => EditorState; notice: (text: string) => void; active: () => boolean })`, which returns `{ current(): ImageDraft; onPaste(chunk: string): boolean; attach(path?: string): Promise<void>; restore(draft: ImageDraft): void; reset(): void }`. `attach()` with no path is the clipboard flow; `options.editor` returns the newest editor state, from a ref ChatApp updates in `changeDraft`, so an attach that finishes after an `await` inserts into the text as it stands then, not as it stood at the key press. Attaches run one at a time in the order they were asked for: a ctrl+v or paste that arrives while a read is in flight waits for it. The hook owns the `ImageDraft` (state plus a ref for batched keys). The default `readFile` reads at most 3,932,161 bytes (one over the image limit, so an oversized file still meets the size refusal without being read whole) and resolves `undefined` when the path does not exist, is not a regular file, or cannot be read. It writes placeholders into the prompt through the input handle's existing `edit(state)` (`ChatInputHandle`), and notices through ChatApp's `append({ kind: "notice", text })`.

- **ctrl+v** (`key.ctrl` and input `v`), while the input is active (no ask card, no picker): `readClipboard()`. `image` → `imageFromBytes(bytes, "clipboard")` → `attachToDraft`. `none` → notice `no image on the clipboard`. `unsupported` → `pasting images needs macOS or Linux; use /image <path>`. `failed` → `could not read the clipboard: <reason>`.
- **Paste**: `onPaste(chunk)` returns `true` when `pastedImagePath(chunk, cwd)` is a path, and then reads it. A path pasted into a line that starts with `/` is attached like any other, and the later submit is refused by the slash-line rule (see Sending). A file that `readFile` cannot find, or bytes that are not an image, put the original chunk into the prompt at the cursor as text, so a normal paste is never lost. Any other refusal is a notice and nothing is inserted.
- **`/image [path]`**: `runSlashCommand` returns the new outcome `{ kind: "attach"; path?: string }` (`path` = `command.rest` trimmed, absent when empty) and ChatApp hands it to the hook. No path → the ctrl+v flow. A path → `readFile(resolve(cwd, path))`: `undefined` → notice `image not found: <path>`; otherwise as a paste, except that a non-image is the notice `image not attached: <refusal>`. `image` is added to `COMMANDS` right after `plugins`, described `Attach an image to the next message`. It is a builtin with no ACP-owned feature, so it works on ACP brains too. Like every other command it waits while a turn runs.
- Every refusal from `imageFromBytes` or `attachToDraft` is the notice `image not attached: <refusal>`.
- Sources: `clipboard` for the clipboard, the absolute path for a paste or `/image <path>`, the typed path for an `@` mention.

### Mentioned images (`packages/nax/src/chat/mentions/`)

- `MentionStatus` gains `"image"`; the envelope's `MENTION_STATUSES` accepts it.
- `MentionWhere` gains `images?: boolean` (absent = false).
- `ExpandedMentions` gains `images?: readonly ImageAttachment[]`, present when non-empty.
- `contentRecord`: after reading the bytes and before the binary check, when `sniffImage(bytes)` is an image: with `where.images` not true the record is `path-only` with note `path only: model cannot read images`; otherwise `imageFromBytes(bytes, located.path)`; a refusal is `path-only` with note `path only: <refusal>`; success is `{ path, status: "image", note: "image · " + imageDescription(image), body: "" }` and the image is collected in mention order. Existing steps before it (resolve, boundary, ignored, folder, the 8 MiB read limit) are unchanged.
- `attachmentLabel` for `image`: `attached <path> · <note>`. `attachmentExpandable("image")` is false.

### Sending (`packages/nax/src/tui/chat/image-send.ts`)

```ts
export interface ImageSendInput {
  readonly text: string;            // the submitted text
  readonly draft: ImageDraft;
  readonly where: MentionWhere;
  readonly expand: MentionExpander;  // _chatAppDeps.expandMentions
  readonly acceptsImages: () => Promise<boolean>;
  readonly model: string;           // host.current().model
}
export type ImageSendResult =
  | { readonly kind: "send"; readonly message: string; readonly images: readonly ImageAttachment[] }
  | { readonly kind: "refuse"; readonly notice: string };
export function prepareImageSend(input: ImageSendInput): Promise<ImageSendResult>;
```

Steps, in order:

1. `imagesForSend(draft, text)` gives the renumbered text and the placeholder images.
2. With placeholder images, `acceptsImages()` false → refuse `<model> cannot read images; switch model (/model) or remove the image`.
3. When `needsMentionExpansion(renumbered)`: `expand(renumbered, where)` when the brain does not read images, and `expand(renumbered, { ...where, images: true })` when it does (the answer is step 2's, or one `acceptsImages()` call when step 2 did not ask), so a text-only brain's expander call keeps today's exact arguments; the message is the expanded one and the images are the placeholder images followed by `expanded.images`. Otherwise the message is the renumbered text.
4. `validateImageAttachments(images)` (`@nathapp/nax-agent`) returning a reason → refuse `images not sent: <reason>`.
5. `{ kind: "send", message, images }`.

ChatApp's plain-message `submit` keeps today's exact path when the draft has no present placeholder image and the text needs no mention expansion. Otherwise it sends through `prepareImageSend`. On `refuse` it appends the notice, writes the submitted text back into the prompt (cursor at the end, through the input handle) and keeps the `ImageDraft`, so return sends it again. On `send` it calls `host.send(message, onEvent, { title, images })` when `images` is non-empty and today's call otherwise. Every plain message that reaches `host.send` (on either path) resets the `ImageDraft` to `EMPTY_IMAGE_DRAFT`, so a draft whose placeholders were all deleted does not keep its numbers. A rejected `acceptsImages()` counts as `false`. A submitted line that starts with `/` while a draft image is present is refused before the command runs, with `images can only be sent with a plain message`, and the line goes back into the prompt. Up-arrow history keeps text only: a recalled `[Image #N]` with no draft image behind it is plain text.

### Host and turn (`packages/nax/src/chat/`)

- `ChatSendOptions` gains `images?: readonly ImageAttachment[]`; `RunChatTurnOptions` gains the same. `NativeChatHost.send` passes `options.images` to `runChatTurn`, which calls `handle.session.send(message, { images })` when `images` is non-empty and `handle.session.send(message)` (one argument) otherwise.
- `ChatHost` gains optional `acceptsImages?(): Promise<boolean>` (optional so the hand-built fake hosts in tests still typecheck). The logic lives in a new `packages/nax/src/chat/session-images.ts`: `sessionAcceptsImages(session: AgentSession | undefined): Promise<boolean>` resolves `false` for no session, `false` when the session has no `acceptsImages`, `false` when it rejects, and otherwise its answer. `NativeChatHost.acceptsImages()` is a one-line delegation `sessionAcceptsImages(this.handle?.session)`, so it never throws when no session is open. ChatApp treats a host without the method, or a rejection, as `false`.
- `recordAcpTurns` (`acp-recorder.ts`): `send(message, input?)` passes `input` through as the wrapped `send`'s second argument only when `input?.images` is non-empty (the handoff prefix rule is unchanged), and records the turn with `acpTurnMessages({ message, images, events, acp })`. The wrapper gains a getter `acceptsImages` that returns the wrapped session's `acceptsImages` bound to it, or `undefined` when it has none.
- `acpTurnMessages` (`acp-history.ts`) takes optional `images`; the recorded user message is `{ role: "user", content: message, images }` when non-empty, unchanged otherwise. The file store writes them to its image folder (feature 1).
- Handoff (`acp-handoff-entries.ts`): a user message's entry text is its `content` followed by one line per image, in order, `[image <n>: <imageFormatOf(mimeType)> <width>×<height>, <source>; not carried across the switch]` (`<n>` from 1; ` <width>×<height>` only when both are present; `, <source>` only when present). Lines are joined with `\n`, with no leading `\n` when `content` is empty. The entry cap applies to the joined text.

### Transcript and replay (`packages/nax/src/tui/chat/`)

- `TranscriptEntry` gains `{ kind: "image"; label: string }`, laid out as one muted row behind the result prefix (`cardRows`, as an attachment row's label is), never expandable.
- `sentEntries(message, images?)` (`mention-send.ts`): the entries it returns today, followed by `{ kind: "image", label: imageNoteLabel(i + 1, image) }` for the first `k` images, where `k` = `max(0, images.length − <number of image-status records in the parsed mention envelope>)` (mention images come last and already have their attachment row). On replay, when an image was dropped as missing, this count can cover one image fewer than was sent; the `image · missing` row still shows.
- Replay (`history-replay.ts`): a stored user message first loses each trailing line that is exactly `[image missing]` (feature 1's load note). The rest replays as `sentEntries(content, message.images)` does, and each removed line adds `{ kind: "image", label: "image · missing" }` after those entries.

### Integration

Read-only symbols (verified 2026-10-31 on main `13b8cc805`):

- `@nathapp/nax-agent` root: `ImageAttachment` (`mimeType`, `data`, `width?`, `height?`, `source?`), `SendInput`, `validateImageAttachments(images): string | undefined`, `MAX_IMAGES_PER_MESSAGE` (10), `MAX_IMAGE_BASE64_CHARS` (5,242,880), `MAX_REQUEST_IMAGE_BASE64_CHARS` (20,971,520); `AgentSession.send(message: string, input?: SendInput)`, `AgentSession.acceptsImages?(): Promise<boolean>`.
- `packages/nax/src/tui/chat/line-editor.ts`: `EditorState { text; cursor }` (cursor = code-point index); `editLine` returns `ignored` for ctrl chords other than a/e/u/k/w, so ctrl+v reaches other `useInput` handlers untouched.
- `packages/nax/src/tui/chat/ChatInput.tsx`: `ChatInputHandle { complete(text); edit(state); submit(text) }`; `submit` publishes an empty editor and appends the text to history before `onSubmit(text)`.
- `packages/nax/src/tui/chat/ChatApp.tsx`: `_chatAppDeps.expandMentions`; `submit(message)` sends a non-slash message through `sendTurn(message, mentionPrepare(...))`; `runCommand` switches on the `SlashOutcome` kind.
- `packages/nax/src/tui/chat/mention-send.ts`: `needsMentionExpansion(text)`, `MentionExpander`.
- `packages/nax/src/chat/acp/acp-transcript-append.ts`: `appendNativeTurn(store, sessionId, messages)`.

Symbols this feature changes. The baseline exists only to locate the code; implement the target.

- `ChatSendOptions` (`packages/nax/src/chat/chat-host.ts`)
  - Baseline: `{ readonly title?: string }`
  - Target: `{ readonly title?: string; readonly images?: readonly ImageAttachment[] }`
- `ChatHost` (`packages/nax/src/chat/chat-host.ts`)
  - Target: gains optional `acceptsImages?(): Promise<boolean>`.
- `RunChatTurnOptions` (`packages/nax/src/chat/turn-runner.ts`)
  - Target: gains `readonly images?: readonly ImageAttachment[]`.
- `recordAcpTurns(session, input)` (`packages/nax/src/chat/acp/acp-recorder.ts`)
  - Baseline: the returned session's `send(message: string)`; no `acceptsImages`.
  - Target: `send(message: string, input?: SendInput)`; getter `acceptsImages`.
- `acpTurnMessages(input)` (`packages/nax/src/chat/acp/acp-history.ts`)
  - Baseline: `{ message; events; acp }`
  - Target: `{ message; images?; events; acp }`
- `MentionStatus` (`packages/nax/src/chat/mentions/types.ts`)
  - Baseline: `"attached" | "cut" | "folder" | "path-only" | "refused"`
  - Target: adds `"image"`.
- `ExpandedMentions` (same file)
  - Target: gains `readonly images?: readonly ImageAttachment[]`.
- `MentionWhere` (`packages/nax/src/chat/mentions/mention-expand.ts`)
  - Baseline: `{ cwd; repoRoot }`
  - Target: `{ cwd; repoRoot; images?: boolean }`
- `SlashOutcome` (`packages/nax/src/tui/chat/slash-commands.ts`)
  - Target: adds `{ kind: "attach"; path?: string }`.
- `TranscriptEntry` (`packages/nax/src/tui/chat/transcript-model.ts`)
  - Target: adds `{ kind: "image"; label: string }`.
- `sentEntries(message)` (`packages/nax/src/tui/chat/mention-send.ts`)
  - Target: `sentEntries(message: string, images?: readonly ImageAttachment[])`.
- `ChatInputProps` (`packages/nax/src/tui/chat/ChatInput.tsx`)
  - Target: gains `readonly onPaste?: (chunk: string) => boolean`.

Patterns to follow: `_deps` injection objects for every effect (no `mock.module`); `Bun.file` / `Bun.spawn` for file and process I/O; `NaxError` with `stage` for any new thrown error (this feature adds none: every failure is a notice). `chat-host.ts` is 586 lines and `check:file-sizes` (600-line limit for `.ts` sources, no baseline entry for it) fails it at 601, so its additions are limited to the `ImageAttachment` import, the two optional members, the one-line `acceptsImages` delegation and the `images` pass-through. `ChatApp.tsx` (621) and `ChatInput.tsx` (643) are `.tsx`, which that gate does not scan, but they are over the rule's 600 already, so new logic goes in the new modules above and they take wiring only. ChatApp UI tests live in `packages/nax/test/ui/chat/` and drive the screen through a fake host; pure-module tests live in `packages/nax/test/unit/`.

### Failure Handling

| Case | Behaviour |
|---|---|
| ctrl+v / `/image` with no image on the clipboard | notice `no image on the clipboard`; draft unchanged |
| clipboard read on an unsupported platform | notice `pasting images needs macOS or Linux; use /image <path>`; nothing run |
| clipboard command missing, timed out, or failing to spawn | notice `could not read the clipboard: <reason>`; never a crash |
| attached bytes not an image, over 3.75 MiB, or over 8000 px | notice `image not attached: <refusal>`; nothing attached |
| 11th present image, or present images over 20 MB | notice `image not attached: <refusal>`; nothing attached |
| pasted image path that does not exist or is not an image | the chunk is inserted as text |
| `/image <path>` that does not exist | notice `image not found: <path>` |
| send with images on a brain that cannot read images (or a host without `acceptsImages`) | notice `<model> cannot read images; switch model (/model) or remove the image`; no send; text and images restored |
| slash line with a present image | notice `images can only be sent with a plain message`; command not run; text and images restored |
| send whose images fail `validateImageAttachments` | notice `images not sent: <reason>`; no send; text and images restored |
| `session.acceptsImages()` rejects | `ChatHost.acceptsImages()` resolves `false` |
| mentioned image on a brain that cannot read images | path-only record `path only: model cannot read images`; the send goes ahead |
| mentioned image over a limit | path-only record `path only: <refusal>` |
| stored image missing on resume | replay row `image · missing` |

## Out of Scope

- Drawing images in the terminal (kitty, iTerm2, sixel); the note row is the only display.
- Resizing, cropping or re-encoding images.
- Image output from tools (the Read tool, MCP image results, screenshots).
- Images in `nax run`, `nax plan`, bot and subagent prompts, and the nax ACP server accepting images.
- Images with slash commands, skills or `!` shell lines: a slash line with a present image is refused.
- Re-sending earlier images when switching brains: the handoff carries a text note per image only.
- Pasting clipboard text on ctrl+v when the clipboard holds no image.
- Clipboard images on Windows and other non-macOS, non-Linux platforms (a notice points at `/image <path>`).
- `~` expansion in pasted paths and in `/image <path>`.
- Expanding an image note row to show more (the row already names its source).
- Reducing `ChatApp.tsx`, `ChatInput.tsx` or `chat-host.ts` below the 600-line source limit.
- Checking a mentioned image against the brain's capability per image beyond the yes/no `acceptsImages` answer, and checking pasted images' capability at attach time (the check runs at send).
- Verifying which ACP adapters (Codex, Cursor) advertise `promptCapabilities.image`; the session's `acceptsImages()` answer is trusted.

## Stories

**US-001: Image format sniffing.** No dependencies. Workdir: `packages/nax`. Add `src/chat/images/image-sniff.ts` with `ImageFormat`, `SniffedImage` and `sniffImage` (magic bytes and header dimensions for PNG, GIF, JPEG and WebP).

**US-002: Image attachments from bytes, and their labels.** Depends on US-001. Workdir: `packages/nax`. Add `src/chat/images/image-file.ts` (`imageFromBytes`, `MAX_IMAGE_EDGE_PX`, `imageFormatOf`, `imageRawBytes`, `imageSizeLabel`, `imageDescription`, `imageNoteLabel`) and the `src/chat/images/index.ts` barrel (re-exporting both modules), exported from `@/chat`.

**US-003: Clipboard image read.** No dependencies. Workdir: `packages/nax`. Add `src/tui/chat/clipboard-image.ts` with `readClipboardImage`, `ClipboardImage`, `ClipboardRun`, `CLIPBOARD_READ_TIMEOUT_MS` and the `_clipboardImageDeps` seam, including the default `run`.

**US-004: Pasted image paths.** No dependencies. Workdir: `packages/nax`. Add `src/tui/chat/pasted-path.ts` with `pastedImagePath`, and the optional `onPaste` prop on `ChatInput`.

**US-005: The image draft.** No dependencies. Workdir: `packages/nax`. Add `src/tui/chat/image-draft.ts` with `ImageDraft`, `DraftImage`, `EMPTY_IMAGE_DRAFT`, `imagePlaceholder`, `attachToDraft` and `imagesForSend`.

**US-006: Mentioned images.** Depends on US-002. Workdir: `packages/nax`. Add the `image` mention status, `MentionWhere.images`, `ExpandedMentions.images`, image detection in `contentRecord`, the envelope status, and the attachment row label.

**US-007: Images through the chat host and the turn.** No dependencies. Workdir: `packages/nax`. Add `ChatSendOptions.images`, `RunChatTurnOptions.images`, `ChatHost.acceptsImages?` and `src/chat/session-images.ts` (`sessionAcceptsImages`).

**US-008: Images through the ACP recorder and the handoff.** Depends on US-002. Workdir: `packages/nax`. Add the recorder's `send(message, input?)` and `acceptsImages` getter, `acpTurnMessages` images, and the handoff image notes.

**US-009: Image rows in the transcript and on replay.** Depends on US-002, US-006. Workdir: `packages/nax`. Add the `image` transcript entry and its layout, `sentEntries(message, images?)`, and image and missing-image rows in `replayHistory`.

**US-010: Attaching images in the chat screen.** Depends on US-002, US-003, US-004, US-005. Workdir: `packages/nax`. Add `src/tui/chat/use-image-attach.ts` (the hook and `_imageAttachDeps`) and wire it into ChatApp: ctrl+v and pasted paths through `onPaste`, attaches serialized and inserted at the newest cursor.

**US-011: The `/image [path]` command.** Depends on US-010. Workdir: `packages/nax`. Add `image` to `COMMANDS`, the `attach` slash outcome, and ChatApp's hand-off of that outcome to the hook.

**US-012: Preparing an image send.** Depends on US-005, US-006. Workdir: `packages/nax`. Add `src/tui/chat/image-send.ts` with `prepareImageSend`, `ImageSendInput` and `ImageSendResult`.

**US-013: Sending images from the chat screen.** Depends on US-007, US-008, US-010, US-012. Workdir: `packages/nax`. Wire ChatApp's plain-message send through `prepareImageSend`: the capability gate, the slash-line refusal, restoring the text and image draft on a refusal, and `host.send` with images.

**US-014: After an image send.** Depends on US-009, US-013. Workdir: `packages/nax`. The transcript rows of a sent message with images (`sentEntries(message, images)`), resetting the image draft after every plain send, and text-only history recall.

### Context Files

**US-002**
- `packages/nax/src/chat/index.ts`
- `packages/nax-agent/src/session/image-input.ts`
- `packages/nax/src/chat/images/image-sniff.ts` — created by US-001, read here

**US-003**
- `packages/nax/src/tui/chat/clipboard.ts`
- `packages/nax/test/unit/tui/chat/clipboard.test.ts`

**US-004**
- `packages/nax/src/tui/chat/ChatInput.tsx`
- `packages/nax/test/ui/chat/chat-input.test.tsx`

**US-005**
- `packages/nax/src/tui/chat/line-editor.ts`
- `packages/nax-agent/src/session/image-input.ts`

**US-006**
- `packages/nax/src/chat/mentions/mention-expand.ts`
- `packages/nax/src/chat/mentions/mention-envelope.ts`
- `packages/nax/src/chat/mentions/types.ts`
- `packages/nax/src/tui/chat/layout-attachment.ts`
- `packages/nax/src/tui/chat/mention-entries.ts`

**US-007**
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/src/chat/turn-runner.ts`
- `packages/nax/test/unit/chat/turn-runner.test.ts`

**US-008**
- `packages/nax/src/chat/acp/acp-recorder.ts`
- `packages/nax/src/chat/acp/acp-history.ts`
- `packages/nax/src/chat/acp/acp-handoff-entries.ts`
- `packages/nax/test/unit/chat/acp/acp-recorder.test.ts`

**US-009**
- `packages/nax/src/tui/chat/transcript-model.ts`
- `packages/nax/src/tui/chat/layout.ts`
- `packages/nax/src/tui/chat/mention-send.ts`
- `packages/nax/src/tui/chat/history-replay.ts`
- `packages/nax/src/chat/images/image-file.ts` — created by US-002, read here

**US-010**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/test/ui/chat/chat-app-mentions.test.tsx`
- `packages/nax/src/tui/chat/image-draft.ts` — created by US-005, read here
- `packages/nax/src/tui/chat/clipboard-image.ts` — created by US-003, read here
- `packages/nax/src/tui/chat/pasted-path.ts` — created by US-004, read here

**US-011**
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/test/ui/chat/slash-menu.test.tsx`
- `packages/nax/test/ui/chat/slash-commands.test.tsx`
- `packages/nax/src/tui/chat/use-image-attach.ts` — created by US-010, read here

**US-012**
- `packages/nax/src/tui/chat/mention-send.ts`
- `packages/nax/src/chat/mentions/mention-expand.ts`
- `packages/nax-agent/src/session/image-input.ts`
- `packages/nax/src/tui/chat/image-draft.ts` — created by US-005, read here

**US-013**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/chat/chat-host.ts`
- `packages/nax/test/ui/chat/chat-app-mentions.test.tsx`
- `packages/nax/src/tui/chat/image-send.ts` — created by US-012, read here
- `packages/nax/src/tui/chat/use-image-attach.ts` — created by US-010, read here

**US-014**
- `packages/nax/src/tui/chat/ChatApp.tsx`
- `packages/nax/src/tui/chat/mention-send.ts`
- `packages/nax/test/ui/chat/chat-app-mentions.test.tsx`
- `packages/nax/src/tui/chat/use-image-attach.ts` — created by US-010, read here

### Creates

**US-001**
- `packages/nax/src/chat/images/image-sniff.ts`
- `packages/nax/test/unit/chat/images/image-sniff.test.ts`

**US-002**
- `packages/nax/src/chat/images/image-file.ts`
- `packages/nax/src/chat/images/index.ts`
- `packages/nax/test/unit/chat/images/image-file.test.ts`

**US-003**
- `packages/nax/src/tui/chat/clipboard-image.ts`
- `packages/nax/test/unit/tui/chat/clipboard-image.test.ts`

**US-004**
- `packages/nax/src/tui/chat/pasted-path.ts`
- `packages/nax/test/unit/tui/chat/pasted-path.test.ts`

**US-005**
- `packages/nax/src/tui/chat/image-draft.ts`
- `packages/nax/test/unit/tui/chat/image-draft.test.ts`

**US-006**
- `packages/nax/test/unit/chat/mentions/mention-expand-images.test.ts`

**US-007**
- `packages/nax/src/chat/session-images.ts`
- `packages/nax/test/unit/chat/chat-host-images.test.ts`

**US-008**
- `packages/nax/test/unit/chat/acp/acp-recorder-images.test.ts`

**US-009**
- `packages/nax/src/tui/chat/layout-image.ts`
- `packages/nax/test/unit/tui/chat/image-entries.test.ts`

**US-010**
- `packages/nax/src/tui/chat/use-image-attach.ts`
- `packages/nax/test/ui/chat/chat-app-image-attach.test.tsx`

**US-011**
- `packages/nax/test/ui/chat/chat-app-image-command.test.tsx`

**US-012**
- `packages/nax/src/tui/chat/image-send.ts`
- `packages/nax/test/unit/tui/chat/image-send.test.ts`

**US-013**
- `packages/nax/test/ui/chat/chat-app-image-send.test.tsx`

**US-014**
- `packages/nax/test/ui/chat/chat-app-image-after-send.test.tsx`

### Modifies

Existing files each story changes. No existing test assertion breaks except the `slash-menu.test.tsx` one listed under US-011: every changed type gains an optional or union member, every new argument is passed only when images are present (so `session.send(message)`, `host.send(message, onEvent)` and `expandMentions(text, { cwd, repoRoot })` assertions still hold), and `/image` sits after `/plugins`, outside the `/mcp` … `/quit` run that `test/ui/chat/slash-commands.test.tsx` pins.

**US-002**
- `packages/nax/src/chat/index.ts` — re-export the new images barrel so sniffImage, imageFromBytes, imageNoteLabel and the rest are importable from the chat package entry.

**US-004**
- `packages/nax/src/tui/chat/ChatInput.tsx` — optional `onPaste` prop, called before `editLine` for a multi-code-point chunk.

**US-006**
- `packages/nax/src/chat/mentions/types.ts` — `MentionStatus` gains `"image"`; `ExpandedMentions` gains optional `images`.
- `packages/nax/src/chat/mentions/mention-envelope.ts` — `MENTION_STATUSES` accepts `"image"`.
- `packages/nax/src/chat/mentions/mention-expand.ts` — `MentionWhere.images`; image detection in `contentRecord` before the binary check; collect `images` in mention order.
- `packages/nax/src/tui/chat/layout-attachment.ts` — `attachmentLabel` gains the `image` case (its switch has no default); `image` is not expandable.

**US-007**
- `packages/nax/src/chat/chat-host.ts` — `ChatSendOptions.images`, optional `ChatHost.acceptsImages`, the one-line delegation and the `images` pass-through only (586 lines; stays at or under 600).
- `packages/nax/src/chat/turn-runner.ts` — `RunChatTurnOptions.images`; two-argument `send` only when images are non-empty.

**US-008**
- `packages/nax/src/chat/acp/acp-recorder.ts` — `send(message, input?)` forwarding images, recording them, and the `acceptsImages` getter.
- `packages/nax/src/chat/acp/acp-history.ts` — `acpTurnMessages` optional `images` on the recorded user message.
- `packages/nax/src/chat/acp/acp-handoff-entries.ts` — one note line per image on a user entry.

**US-009**
- `packages/nax/src/tui/chat/transcript-model.ts` — `TranscriptEntry` gains `{ kind: "image"; label: string }`.
- `packages/nax/src/tui/chat/layout.ts` — the `switch (entry.kind)` (no default) gains the `image` case, drawn by the new layout-image module.
- `packages/nax/src/tui/chat/mention-send.ts` — `sentEntries(message, images?)` appends image rows.
- `packages/nax/src/tui/chat/history-replay.ts` — strip trailing `[image missing]` lines and replay images through `sentEntries`.

**US-010**
- `packages/nax/src/tui/chat/ChatApp.tsx` — mount `useImageAttach`, pass its `onPaste` to `ChatInput`, keep the newest editor state in a ref updated in `changeDraft`, and route ctrl+v to the hook while the input is active.

**US-011**
- `packages/nax/src/tui/chat/slash-commands.ts` — `image` in `COMMANDS` after `plugins` with its description; `SlashOutcome` gains `{ kind: "attach"; path?: string }`; `runSlashCommand` returns it for the image command.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `runCommand` hands the `attach` outcome to the hook's `attach(path)`.
- `packages/nax/test/ui/chat/slash-menu.test.tsx` — "AC-10 fifteen matches draw eight rows" pins the overflow row `  … 8 more` for 15 built-ins; with the image command added there are 16, so the expected row becomes `  … 9 more` and the title says sixteen. The seven visible rows are unchanged, and "AC-11 nine downArrows" still lands on the skills row because the image command comes after it.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — "AC-4 never sends original /%s" iterates `COMMANDS` and so now submits the image command, which would run the real clipboard command; `mount()` stubs `_imageAttachDeps.readClipboard` (resolving `{ kind: "none" }`) so no test spawns `osascript`, `wl-paste` or `xclip`. Its assertion (`send` not called) is unchanged.

**US-013**
- `packages/nax/src/tui/chat/ChatApp.tsx` — route plain-message submits with present images or mentions through `prepareImageSend`, refuse a slash line with a present image, restore the text and image draft on a refusal, and pass `images` to `host.send`.

**US-014**
- `packages/nax/src/tui/chat/ChatApp.tsx` — draw a sent message's rows with `sentEntries(message, images)` and reset the image draft after every plain message that reaches `host.send`.

### Seams

- US-001 → US-002: `imageFromBytes` calls `sniffImage` (US-002 `imageFromBytes` ACs).
- US-002 → US-006: `expandChatMentions` calls `imageFromBytes` for a mentioned image file (US-006 AC on the image record and its attachment).
- US-002 → US-008: the handoff note uses `imageFormatOf` (US-008 handoff ACs).
- US-006 → US-009: `sentEntries` and replay count `image`-status records that `formatMentionMessage` / `parseMentionMessage` carry (US-009 mention-row ACs).
- US-002 → US-009: image rows use `imageNoteLabel` (US-009 `sentEntries` ACs).
- US-003 → US-010: ctrl+v in the mounted chat screen calls `_imageAttachDeps.readClipboard` (US-010 ctrl+v ACs, entering at the key press).
- US-004 → US-010: a pasted chunk in the mounted chat screen reaches `pastedImagePath` through `ChatInput`'s `onPaste` (US-010 paste ACs, entering at stdin).
- US-005 → US-010 / US-012: placeholders come from `attachToDraft` (US-010 screen ACs), sends from `imagesForSend` (US-012 ACs).
- US-006 → US-012: `prepareImageSend` passes `where.images` to the expander and appends `expanded.images` (US-012 mention ACs).
- US-010 → US-011: a submitted `/image` reaches the hook's `attach` (US-011 screen ACs, entering at the submitted line).
- US-007 → US-013, US-008 → US-013 and US-012 → US-013: the mounted chat screen calls `host.acceptsImages()` and `host.send(..., { images })` through `prepareImageSend` (US-013 screen ACs).
- US-009 → US-014: the transcript after a send shows the image row (US-014 screen AC).

## Acceptance Criteria

### US-001

1. [unit] `sniffImage` on the 8 PNG signature bytes followed by an IHDR chunk declaring width 1280 and height 720 returns `{ format: "png", mimeType: "image/png", width: 1280, height: 720 }`.
2. [unit] `sniffImage` on bytes starting `GIF89a` with little-endian width 3 and height 2 at offsets 6 and 8 returns `{ format: "gif", mimeType: "image/gif", width: 3, height: 2 }`.
3. [unit] `sniffImage` on bytes starting `GIF87a` returns format `"gif"`.
4. [unit] `sniffImage` on JPEG bytes (`FF D8 FF`) holding an APP0 segment followed by an SOF0 (`FF C0`) segment declaring height 600 and width 800 returns `{ format: "jpeg", mimeType: "image/jpeg", width: 800, height: 600 }`.
5. [unit] `sniffImage` on JPEG bytes whose first SOF marker is a progressive SOF2 (`FF C2`) returns the width and height that segment declares.
6. [unit] `sniffImage` on a RIFF/WEBP file with a `VP8 ` chunk declaring width 640 and height 480 returns `{ format: "webp", mimeType: "image/webp", width: 640, height: 480 }`.
7. [unit] `sniffImage` on a RIFF/WEBP file with a `VP8L` chunk encoding width 100 and height 50 returns width 100 and height 50.
8. [unit] `sniffImage` on a RIFF/WEBP file with a `VP8X` chunk encoding width 4000 and height 3000 returns width 4000 and height 3000.
9. [unit] `sniffImage` on the UTF-8 bytes of `"hello world"` returns `undefined`.
10. [unit] `sniffImage` on an empty byte array returns `undefined`.
11. [unit] `sniffImage` on the 8 PNG signature bytes alone returns `{ format: "png", mimeType: "image/png" }` with no `width` and no `height` key.
12. [unit] `sniffImage` on JPEG bytes where `FF` fill bytes and a stand-alone `FF D0` marker come before the SOF0 segment still returns the width and height the SOF0 segment declares.
13. [unit] `sniffImage` on JPEG bytes that reach an SOS (`FF DA`) marker before any SOF marker returns `{ format: "jpeg", mimeType: "image/jpeg" }` with no `width` and no `height` key.

### US-002

1. [unit] `imageFromBytes` on a valid 1280×720 PNG with source `"clipboard"` returns `{ image }` whose `mimeType` is `"image/png"`, `data` is the base64 of the bytes, `width` is 1280, `height` is 720 and `source` is `"clipboard"`.
2. [unit] `imageFromBytes` on the bytes of `"hello"` returns `{ refusal: "not a PNG, JPEG, GIF or WebP image" }`.
3. [unit] `imageFromBytes` on a PNG of exactly 3,932,160 bytes returns `{ image }`, and on a PNG of 3,932,161 bytes returns `{ refusal: "image is larger than 3.75 MiB" }`.
4. [unit] `imageFromBytes` on a PNG declaring width 8000 returns `{ image }`, and on one declaring width 8001 (or height 8001) returns `{ refusal: "image is larger than 8000 px on a side" }`.
5. [unit] `imageFromBytes` on a PNG of 3,932,161 bytes that also declares width 9000 returns the size refusal `image is larger than 3.75 MiB`, because the size check runs before the edge check.
6. [unit] `imageRawBytes` returns 3 for an image whose `data` is `"AAAA"` and 1 for `"AA=="`.
7. [unit] `imageSizeLabel(350_208)` returns `"342 KB"`, `imageSizeLabel(100)` returns `"1 KB"`, `imageSizeLabel(1_048_575)` returns `"1023 KB"`, and `imageSizeLabel(1_572_864)` returns `"1.5 MB"`.
8. [unit] `imageDescription` of a PNG image with width 1280, height 720 and 350,208 raw bytes returns `"png · 1280×720 · 342 KB"`; without `width` and `height` it returns `"png · 342 KB"`.
9. [unit] `imageNoteLabel(2, image)` for that PNG with source `"clipboard"` returns `"image 2 · png · 1280×720 · 342 KB · clipboard"`; with no `source` it returns `"image 2 · png · 1280×720 · 342 KB"`.
10. [unit] `imageFormatOf("image/jpeg")` returns `"jpeg"` and `imageFormatOf("image/bmp")` returns `"image"`.
11. [unit] `sniffImage`, `imageFromBytes`, `imageNoteLabel` and `MAX_IMAGE_EDGE_PX` (equal to 8000) are importable from `@/chat` and usable, and `imageFromBytes` on a PNG with no IHDR (signature only) returns an image with no `width` or `height`, because its format comes from `sniffImage`.

### US-003

1. [unit] On platform `darwin`, `readClipboardImage()` calls `_clipboardImageDeps.run` once with `["osascript", "-e", "the clipboard as «class PNGf»"]` and `CLIPBOARD_READ_TIMEOUT_MS` (2000).
2. [unit] On `darwin`, a run that exits 0 with stdout `«data PNGf89504E47»\n` returns `{ kind: "image", bytes }` where `bytes` is `[0x89, 0x50, 0x4E, 0x47]`.
3. [unit] On `darwin`, a run that exits 1 returns `{ kind: "none" }`.
4. [unit] On `darwin`, a run that exits 0 with stdout that holds no `«data PNGf…»` returns `{ kind: "none" }`.
5. [unit] On `linux` with `WAYLAND_DISPLAY` set to `wayland-0`, `readClipboardImage()` runs `["wl-paste", "--no-newline", "--type", "image/png"]`, and a run that exits 0 with non-empty stdout returns `{ kind: "image", bytes }` equal to that stdout.
6. [unit] On `linux` with `WAYLAND_DISPLAY` unset or empty, `readClipboardImage()` runs `["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]`.
7. [unit] On `linux`, a run that exits 0 with empty stdout returns `{ kind: "none" }`, and one that exits 1 returns `{ kind: "none" }`.
8. [unit] On platform `win32`, `readClipboardImage()` returns `{ kind: "unsupported" }` and never calls `run`.
9. [unit] A run that resolves `{ kind: "missing" }` for `xclip` returns `{ kind: "failed", reason: "xclip is not installed" }`.
10. [unit] A run that resolves `{ kind: "timed-out" }` returns `{ kind: "failed", reason: "clipboard read timed out" }`.
11. [unit] A run that rejects with `new Error("boom")` returns `{ kind: "failed", reason: "boom" }`.
12. [integration] The default `_clipboardImageDeps.run` with argv `["nax-no-such-command-xyz"]` resolves `{ kind: "missing" }`.
13. [integration] The default `_clipboardImageDeps.run` with argv `["sleep", "5"]` and a timeout of 50 ms resolves `{ kind: "timed-out" }` in well under 5 seconds, having killed the child.
14. [integration] The default `_clipboardImageDeps.run` with argv `["printf", "abc"]` resolves `{ kind: "exited", exitCode: 0 }` with stdout equal to the bytes of `"abc"`.

### US-004

1. [unit] `pastedImagePath("/Users/me/Desktop/shot.png", "/repo")` returns `"/Users/me/Desktop/shot.png"`.
2. [unit] `pastedImagePath("  /tmp/a.PNG \n", "/repo")` returns `"/tmp/a.PNG"`: whitespace and the trailing newline are trimmed and the extension check ignores case.
3. [unit] `pastedImagePath("'/tmp/my shot.png'", "/repo")` and `pastedImagePath("\"/tmp/my shot.png\"", "/repo")` both return `"/tmp/my shot.png"`.
4. [unit] `pastedImagePath("/tmp/my\\ shot.png", "/repo")` returns `"/tmp/my shot.png"`.
5. [unit] `pastedImagePath("file:///tmp/my%20shot.jpg", "/repo")` returns `"/tmp/my shot.jpg"`.
6. [unit] `pastedImagePath("shots/a.webp", "/repo")` returns `"/repo/shots/a.webp"`.
7. [unit] `pastedImagePath("/tmp/a.txt", "/repo")` returns `undefined`, and so do `pastedImagePath("hello world", "/repo")` and `pastedImagePath("", "/repo")`.
8. [unit] `pastedImagePath("/tmp/a.png\n/tmp/b.png", "/repo")` returns `undefined` because the trimmed chunk holds a newline.
9. [unit] `pastedImagePath("file:///tmp/%zz.png", "/repo")` and `pastedImagePath("file://", "/repo")` return `undefined` without throwing.
10. [unit] `pastedImagePath` accepts the extensions `.png`, `.jpg`, `.jpeg`, `.gif` and `.webp`, and returns `undefined` for `.bmp`.
11. [integration] A `ChatInput` with an `onPaste` that returns `true`, sent the chunk `/tmp/a.png` on stdin, calls `onPaste` once with `"/tmp/a.png"` and leaves the editor text empty.
12. [integration] A `ChatInput` with an `onPaste` that returns `false`, sent the chunk `hello`, calls `onPaste` with `"hello"` and shows `hello` in the editor.
13. [integration] A `ChatInput` with an `onPaste`, sent the single character `a`, never calls `onPaste` and shows `a`.
14. [integration] A `ChatInput` without `onPaste`, sent the chunk `hello`, shows `hello` as it does today.

### US-005

1. [unit] `imagePlaceholder(3)` returns `"[Image #3]"`, and `EMPTY_IMAGE_DRAFT` equals `{ next: 1, images: [] }`.
2. [unit] `attachToDraft(EMPTY_IMAGE_DRAFT, { text: "look ", cursor: 5 }, image)` returns an editor `{ text: "look [Image #1]", cursor: 15 }` and a draft `{ next: 2, images: [{ number: 1, image }] }`.
3. [unit] `attachToDraft` with the cursor in the middle of `"ab"` (cursor 1) returns the text `"a[Image #1]b"` with the cursor after the placeholder.
4. [unit] `attachToDraft` with the text `"😀"` and cursor 1 inserts after the emoji, because the cursor is a code-point index.
5. [unit] `attachToDraft` leaves the draft and editor it was given unchanged.
6. [unit] With 10 draft images whose placeholders are all in the editor text, `attachToDraft` returns `{ refusal: "at most 10 images per message" }`.
7. [unit] With 10 draft images of which one placeholder was deleted from the text, `attachToDraft` attaches the new image as number 11.
8. [unit] When the present images' `data` lengths plus the new image's exceed `MAX_REQUEST_IMAGE_BASE64_CHARS`, `attachToDraft` returns `{ refusal: "images in one message must total at most 20 MB" }`; at exactly the limit it attaches.
9. [unit] When both limits are exceeded, `attachToDraft` returns the count refusal, because the count check runs first.
10. [unit] `imagesForSend` for draft images 1 and 2 and the text `"a [Image #1] b [Image #2]"` returns that text unchanged and the images in order 1, 2.
11. [unit] `imagesForSend` for draft images 1 and 2 and the text `"see [Image #2]"` returns the text `"see [Image #1]"` and only image 2.
12. [unit] `imagesForSend` for draft images 1 and 2 and the text `"[Image #2] then [Image #1]"` returns `"[Image #1] then [Image #2]"` and the images in order 2, 1.
13. [unit] `imagesForSend` for draft image 1 and the text `"[Image #1] and again [Image #1]"` returns one image and leaves both placeholders as `[Image #1]`.
14. [unit] `imagesForSend` for an empty draft and the text `"old [Image #4]"` returns that text unchanged and no images.
15. [unit] `imagesForSend` for draft image 1 and the text `"no placeholder"` returns no images.

### US-006

1. [unit] `expandChatMentions("see @shot.png", { cwd, repoRoot, images: true })`, with the deps returning PNG bytes for `shot.png`, returns a record `{ path: "shot.png", status: "image", note: "image · png · 2×3 · 1 KB", body: "" }`.
2. [unit] That call returns `images` holding one `ImageAttachment` with `mimeType` `"image/png"`, `data` the base64 of the file bytes, `width` 2, `height` 3 and `source` `"shot.png"`.
3. [unit] The same call with `images` absent from `where` returns a `path-only` record with note `path only: model cannot read images` and no `images` key.
4. [unit] A mentioned PNG of 3,932,161 bytes with `images: true` returns a `path-only` record with note `path only: image is larger than 3.75 MiB` and no `images` key.
5. [unit] A mentioned file named `notes.png` whose bytes are UTF-8 text with no NUL byte is attached as text with status `attached`, because the format comes from the bytes.
6. [unit] A mentioned file named `photo.dat` holding JPEG bytes, with `images: true`, returns status `image` and a `image/jpeg` attachment.
7. [unit] Two image mentions `@a.png @b.gif` with `images: true` return `images` in the order a, b.
8. [unit] A mentioned image outside the repo is refused as today (`not attached: outside the repo`) and adds no image.
9. [unit] The expanded `message` for an image mention parses back with `parseMentionMessage` into the typed text and a record whose `status` is `"image"` and whose `body` is `""`.
10. [unit] `parseMentionMessage` on an envelope whose record says `status="image"` returns that record.
11. [unit] `attachmentLabel({ path: "shot.png", status: "image", note: "image · png · 2×3 · 1 KB" })` returns `"attached @shot.png · image · png · 2×3 · 1 KB"`.
12. [unit] `attachmentExpandable("image")` returns `false`.
13. [unit] `mentionTranscriptEntries` for a parsed message holding an `image` record lists `shot.png` among the user entry's highlighted `mentions`.

### US-007

1. [unit] `runChatTurn` with `images: [image]` calls `handle.session.send` with the message and `{ images: [image] }`.
2. [unit] `runChatTurn` without `images`, and with `images: []`, calls `handle.session.send` with the message as its only argument.
3. [unit] `NativeChatHost.send("look", onEvent, { images: [image] })` on an open session calls that session's `send` with `"look"` and `{ images: [image] }`.
4. [unit] `NativeChatHost.acceptsImages()` resolves `true` when the open session's `acceptsImages` resolves `true`, and `false` when it resolves `false`.
5. [unit] `sessionAcceptsImages` resolves `false` for a session with no `acceptsImages`, and `false` for `undefined` (no open session).
6. [unit] `sessionAcceptsImages` resolves `false` when the session's `acceptsImages` rejects.

### US-008

1. [unit] A session returned by `recordAcpTurns` called as `send("look", { images: [image] })` calls the wrapped session's `send` with `"look"` and an input whose `images` is that same array.
2. [unit] With a pending handoff, `send("look", { images: [image] })` calls the wrapped `send` with the handoff-prefixed text and `{ images: [image] }`.
3. [unit] `send("look")` on the recorder session calls the wrapped `send` with one argument.
4. [unit] After a recorded turn sent with `{ images: [image] }`, `appendNativeTurn` receives a first message `{ role: "user", content: "look", images: [image] }`.
5. [unit] After a recorded turn sent without images, the recorded user message has no `images` key.
6. [unit] The recorder session's `acceptsImages()` resolves what the wrapped session's `acceptsImages()` resolves.
7. [unit] The recorder session's `acceptsImages` is `undefined` when the wrapped session has none.
8. [unit] `handoffEntries` for a user message `{ content: "look", images: [{ mimeType: "image/png", data, width: 1280, height: 720, source: "clipboard" }] }` returns an entry whose text is `"look\n[image 1: png 1280×720, clipboard; not carried across the switch]"`.
9. [unit] `handoffEntries` for a user message with two images numbers their lines `[image 1: …` and `[image 2: …`, in image order.
10. [unit] `handoffEntries` for an image with no `width`/`height` writes `[image 1: png, clipboard; not carried across the switch]`, and for one with no `source` writes `[image 1: png 1280×720; not carried across the switch]`.
11. [unit] `handoffEntries` for a user message with `content: ""` and one image returns an entry whose text starts with `[image 1:` (no leading newline).
12. [unit] `handoffEntries` for a user message whose content plus image lines exceed `ACP_HANDOFF_ENTRY_MAX_CHARS` cuts the joined text to the cap and marks the cut with `…`.
13. [unit] `handoffEntries` for a user message without images returns the same entry as today.

### US-009

1. [unit] `layoutTranscript` of `[{ kind: "image", label: "image 1 · png · 2×3 · 1 KB · clipboard" }]` draws one row holding that label behind the result prefix, in the muted color.
2. [unit] `sentEntries("look [Image #1]", [image])`, for a PNG image of width 2, height 3 and source `"clipboard"`, returns `[{ kind: "user", text: "look [Image #1]" }, { kind: "image", label: "image 1 · png · 2×3 · 1 KB · clipboard" }]`.
3. [unit] `sentEntries("look")` and `sentEntries("look", [])` return the same entries as `sentEntries` returns today.
4. [unit] `sentEntries` for a mention message whose envelope has one `image` record, with `images` holding a pasted image followed by the mentioned image, returns the mention entries followed by exactly one image row, labelled `image 1 …` for the pasted image.
5. [unit] `replayHistory` of a stored user message `{ role: "user", content: "look [Image #1]", images: [image] }` returns the same entries as `sentEntries("look [Image #1]", [image])`.
6. [unit] `replayHistory` of a stored user message `{ content: "look\n[image missing]" }` returns a user entry with text `"look"` followed by `{ kind: "image", label: "image · missing" }`.
7. [unit] `replayHistory` of a stored user message whose content ends with two `[image missing]` lines returns two `image · missing` rows.
8. [unit] `replayHistory` of a stored mention message (envelope) followed by one `[image missing]` line returns the mention entries and then one `image · missing` row.
9. [unit] `replayHistory` of a stored user message whose content is exactly `[image missing]` returns only the `image · missing` row.
10. [unit] `replayHistory` of a stored user message with content `"see [image missing] here"` (not a whole trailing line) returns it as plain user text with no image row.
11. [unit] `sentEntries` for a mention message whose envelope has two `image` records but whose `images` holds one image returns the mention entries and no image row.

### US-010

1. [integration] In the mounted chat screen, ctrl+v with `_imageAttachDeps.readClipboard` resolving `{ kind: "image", bytes }` for a 2×3 PNG shows `[Image #1]` in the input.
2. [integration] A second ctrl+v after typing ` and ` shows `[Image #1] and [Image #2]`, the second placeholder at the cursor.
3. [integration] ctrl+v with `readClipboard` resolving `{ kind: "none" }` shows the notice `no image on the clipboard` and leaves the input empty.
4. [integration] ctrl+v with `readClipboard` resolving `{ kind: "unsupported" }` shows `pasting images needs macOS or Linux; use /image <path>`.
5. [integration] ctrl+v with `readClipboard` resolving `{ kind: "failed", reason: "xclip is not installed" }` shows `could not read the clipboard: xclip is not installed`.
6. [integration] ctrl+v with `readClipboard` resolving image bytes that are not an image shows `image not attached: not a PNG, JPEG, GIF or WebP image` and inserts no placeholder.
7. [integration] An 11th ctrl+v with ten placeholders in the input shows `image not attached: at most 10 images per message`.
8. [integration] While an ask card is shown, ctrl+v does not call `readClipboard`.
9. [integration] Pasting the chunk `/tmp/shot.png` with `_imageAttachDeps.readFile` resolving PNG bytes for `/tmp/shot.png` shows `[Image #1]` and not the path.
10. [integration] Pasting `/tmp/shot.png` with `readFile` resolving `undefined` shows `/tmp/shot.png` in the input as text.
11. [integration] Pasting `/tmp/shot.png` with `readFile` resolving bytes that are not an image shows `/tmp/shot.png` in the input as text and no notice.
12. [integration] Pasting `/tmp/big.png` with `readFile` resolving a PNG of 3,932,161 bytes shows `image not attached: image is larger than 3.75 MiB` and leaves the input empty.
13. [integration] Pasting the chunk `hello world` inserts it as text and never calls `readFile`.
14. [integration] With `readClipboard` held pending, ctrl+v then typing `ab` and then resolving the clipboard read with a PNG shows `ab[Image #1]` in the input: the typed text survives and the placeholder lands at the cursor as it stands when the read finishes.
15. [integration] Two ctrl+v presses while the first `readClipboard` is still pending call `readClipboard` a second time only after the first resolved, and show `[Image #1][Image #2]`.
16. [integration] The default `_imageAttachDeps.readFile` on a temporary file of 4,000,000 bytes resolves exactly 3,932,161 bytes, on a missing path resolves `undefined`, and on a directory resolves `undefined`.

### US-011

1. [unit] `runSlashCommand` for `/image` returns `{ kind: "attach" }`, and for `/image shots/a b.png` returns `{ kind: "attach", path: "shots/a b.png" }`.
2. [unit] `runSlashCommand` for `/image` on an ACP brain returns `{ kind: "attach" }`.
3. [integration] Submitting `/image` calls `readClipboard` once, shows `[Image #1]` for a clipboard image, and never calls `host.send`.
4. [integration] Submitting `/image shots/a.png` calls `readFile` with `shots/a.png` resolved against the screen's cwd and shows `[Image #1]`.
5. [integration] Submitting `/image missing.png` with `readFile` resolving `undefined` shows the notice `image not found: missing.png`.
6. [integration] Submitting `/image notes.png` with `readFile` resolving text bytes shows `image not attached: not a PNG, JPEG, GIF or WebP image`.
7. [integration] `/help` lists `/image  Attach an image to the next message` directly after the `/plugins` line.

### US-012

1. [unit] `prepareImageSend` for text `"look [Image #1]"`, a draft holding image 1, no mention, and `acceptsImages` resolving `true` returns `{ kind: "send", message: "look [Image #1]", images: [image 1] }`.
2. [unit] `prepareImageSend` with a present draft image and `acceptsImages` resolving `false`, for model `"openai/text-only"`, returns `{ kind: "refuse", notice: "openai/text-only cannot read images; switch model (/model) or remove the image" }` and never calls `expand`.
3. [unit] `prepareImageSend` for text `"[Image #1] @a.png"` calls `acceptsImages` once and `expand` once with the renumbered text and `{ ...where, images: true }`, and returns the expanded message with the placeholder image followed by `expanded.images`.
4. [unit] `prepareImageSend` for text `"@a.png"` with an empty draft calls `acceptsImages` once; when it resolves `false`, `expand` is called with `where` exactly as given (no `images` key), and when `true`, with `{ ...where, images: true }`.
5. [unit] `prepareImageSend` whose images fail `validateImageAttachments` (11 images in total across the draft and mentions) returns `{ kind: "refuse", notice: "images not sent: <reason>" }` carrying the validator's reason.

### US-013

1. [integration] In the mounted chat screen with a host whose `acceptsImages` resolves `true`, ctrl+v (clipboard PNG), typing ` look` and return calls `host.send` with `"[Image #1] look"`, the event callback, and options whose `images` holds one `image/png` attachment with `source` `"clipboard"`.
2. [integration] A pasted `/tmp/shot.png` image sent the same way carries `source` `"/tmp/shot.png"`.
3. [integration] Sending `"hello"` with no attachment calls `host.send` exactly as today, with `"hello"` and the event callback only.
4. [integration] Attaching images 1 and 2, deleting `[Image #1]`, and sending calls `host.send` with text holding `[Image #1]` for the second image and one image.
5. [integration] With a host whose `acceptsImages` resolves `false`, sending a message with a present image shows `<model> cannot read images; switch model (/model) or remove the image` and does not call `host.send`.
6. [integration] After that refusal the input shows the submitted text again with the cursor at its end (a typed `!` appears after the last character), and once `acceptsImages` resolves `true` a return sends it with its image.
7. [integration] With a host that has no `acceptsImages`, sending a message with a present image is refused with the same notice.
8. [integration] Submitting `/model [Image #1]` with a present image shows `images can only be sent with a plain message`, does not call `host.switchTo`, and puts `/model [Image #1]` back in the input.
9. [integration] Sending a message whose placeholder images and `expandMentions` images total 11 shows `images not sent: <reason>`, does not call `host.send`, and puts the submitted text back in the input with its placeholder images still attached.
10. [integration] With a host whose `acceptsImages` rejects, sending a message with a present image shows the `cannot read images` notice (not an error row) and puts the text back in the input.
11. [integration] Sending `"see @a.png"` with a host whose `acceptsImages` resolves `true` calls `_chatAppDeps.expandMentions` with the text and `{ cwd, repoRoot, images: true }`; with a host whose `acceptsImages` resolves `false`, or that has none, the call's second argument is exactly `{ cwd, repoRoot }`.

### US-014

1. [integration] Attaching an image, deleting its placeholder text, and sending `"hello"` calls `host.send` with no `images`.
2. [integration] Sending `"see @shot.png"` with `_chatAppDeps.expandMentions` stubbed to return an expanded message and `images: [mentioned]` calls `host.send` with that message and `images: [mentioned]`.
3. [integration] After a successful send with images, the transcript shows the user row `[Image #1] look` and the row `image 1 · png · 2×3 · 1 KB · clipboard`.
4. [integration] After a successful send with images, the next ctrl+v shows `[Image #1]` again (the image draft was reset).
5. [integration] After a send with an image, up-arrow recalls `[Image #1] look` as text, and sending the recalled line calls `host.send` with no `images`.
6. [integration] Attaching an image, deleting its placeholder, sending `"hello"`, and then pressing ctrl+v shows `[Image #1]` (the image draft was reset by the send).

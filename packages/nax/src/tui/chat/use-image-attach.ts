/**
 * Attaching images in the chat screen: a clipboard image on ctrl+v, a pasted image file's
 * path, and the `/image <path>` flow the slash command hands here.
 *
 * Three things make this more than a call to `attachToDraft`.
 *
 * *The reads are asynchronous and the prompt keeps moving.* A clipboard read can take
 * `CLIPBOARD_READ_TIMEOUT_MS` and a file read takes as long as the disk does, so the text and
 * cursor the placeholder belongs in are the ones standing when the read finishes — never the
 * ones the keypress saw. `options.editor` is read for exactly that reason, from a ref the
 * screen updates on every edit, and the image draft itself lives in a ref beside its state so
 * two keys delivered in one batch compose instead of overwriting each other.
 *
 * *Attaches run one at a time, in the order they were asked for.* A second ctrl+v while the
 * first read is in flight would otherwise race it: both placeholders would land on the same
 * cursor and both would claim the same `[Image #N]`. Each request is chained onto the one
 * before it, so the second read starts only once the first has landed.
 *
 * *A paste is never lost.* A chunk that names an image file is taken by `onPaste` and read; if
 * the file is not there, or holds no image at all, the chunk goes back into the prompt as the
 * text it would have been. Only a refusal the user can act on — a clipboard that holds
 * something else, a file too large, too many images — becomes a notice.
 *
 * Everything the hook touches outside React goes through `_imageAttachDeps`, read at call
 * time, so a test replaces one member instead of spawning `osascript`.
 */

import { resolve } from "node:path";
import { MAX_IMAGE_BASE64_CHARS } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { type RefObject, useRef, useState } from "react";
import { imageFromBytes, sniffImage } from "@/chat";
import type { ChatInputHandle } from "./ChatInput";
import { type ClipboardImage, readClipboardImage } from "./clipboard-image";
import { attachToDraft, EMPTY_IMAGE_DRAFT, type ImageDraft } from "./image-draft";
import type { EditorState } from "./line-editor";
import { pastedImagePath } from "./pasted-path";

/**
 * The most bytes the default reader takes: one past the largest raw image the per-image
 * base64 budget admits, so an oversized file still meets the size refusal without ever being
 * read whole. `imageFromBytes` measures `ceil(bytes / 3) * 4`, which is
 * `MAX_IMAGE_BASE64_CHARS` for exactly `(MAX_IMAGE_BASE64_CHARS / 4) * 3` bytes (3,932,160)
 * and over it one byte later.
 */
const MAX_READ_BYTES = (MAX_IMAGE_BASE64_CHARS / 4) * 3 + 1;

/** Where a clipboard image came from, for the attachment's own label. */
const CLIPBOARD_SOURCE = "clipboard";

const NO_CLIPBOARD_IMAGE = "no image on the clipboard";
const CLIPBOARD_UNSUPPORTED = "pasting images needs macOS or Linux; use /image <path>";
const CLIPBOARD_FAILED = "could not read the clipboard";
const NOT_ATTACHED = "image not attached";
const NOT_FOUND = "image not found";

/**
 * The bytes of the image file at `path`, at most `MAX_READ_BYTES` of them, or `undefined` when
 * there is nothing to read: no file there, something that is not a regular file (a directory,
 * a device), or a read that fails. Truncating is deliberate — an oversized image is refused by
 * its size, so the rest of it never needs to be read.
 */
async function readImageFile(path: string): Promise<Uint8Array | undefined> {
  try {
    const file = Bun.file(path);
    const stat = await file.stat();
    if (!stat.isFile()) return undefined;
    return new Uint8Array(await file.slice(0, MAX_READ_BYTES).arrayBuffer());
  } catch {
    // Nothing at that path, or nothing readable: the caller puts the paste back as text.
    return undefined;
  }
}

/** This module's effects. Read at call time, so a test can replace one member with `spyOn`. */
export const _imageAttachDeps: {
  readClipboard: () => Promise<ClipboardImage>;
  readFile: (path: string) => Promise<Uint8Array | undefined>;
} = {
  readClipboard: readClipboardImage,
  readFile: readImageFile,
};

/** What the hook needs from the screen it lives in. */
export interface ImageAttachOptions {
  /** The directory a pasted or typed relative path resolves against. */
  readonly cwd: string;
  /** The prompt's handle: where a placeholder, and a put-back chunk, are written. */
  readonly input: RefObject<ChatInputHandle | undefined>;
  /** The newest editor state — read when a read finishes, not when it was asked for. */
  readonly editor: () => EditorState;
  /** One notice row in the transcript. */
  readonly notice: (text: string) => void;
  /** True while the prompt owns the screen: no ask card, no picker. */
  readonly active: () => boolean;
}

/** What the screen may ask of the draft. */
export interface ImageAttach {
  /** The image draft as it stands — the newest value, even inside one batch of keys. */
  current(): ImageDraft;
  /** Offer a pasted chunk; true when it named an image file and was taken. */
  onPaste(chunk: string): boolean;
  /** Read an image from the clipboard, or from `path` when one is given. */
  attach(path?: string): Promise<void>;
  /** Put a draft back, as a refused send does. */
  restore(draft: ImageDraft): void;
  /** Start over with no images, as a completed send does. */
  reset(): void;
}

/** A file to read, named in a notice the way the user gave it. */
interface FileAttempt {
  /** The absolute path to read. */
  readonly path: string;
  /** The path as typed, shown in a `not found` notice. */
  readonly label: string;
  /** The chunk this attempt came from, when it came from a paste: put back if it is no image. */
  readonly fallback?: string;
}

/**
 * `editor` with `chunk` inserted at its cursor and the cursor moved past it. The text is read
 * as code points, as the line editor reads it, so a cursor after an emoji lands after the
 * whole emoji rather than between its surrogates — the same rule `attachToDraft` follows.
 */
function withChunk(editor: EditorState, chunk: string): EditorState {
  const chars = Array.from(editor.text);
  const at = Math.min(Math.max(editor.cursor, 0), chars.length);
  const added = Array.from(chunk);
  return { text: [...chars.slice(0, at), ...added, ...chars.slice(at)].join(""), cursor: at + added.length };
}

/**
 * The image draft and the effects that fill it. Attaches are serialized, and each one writes
 * into the prompt as it stands when its read lands.
 */
export function useImageAttach(options: ImageAttachOptions): ImageAttach {
  /** The draft as a value; the ref below is what the handlers read between renders. */
  const [, setDraft] = useState<ImageDraft>(EMPTY_IMAGE_DRAFT);
  /** The newest draft, ahead of React: two keys in one batch both reduce this. */
  const current = useRef<ImageDraft>(EMPTY_IMAGE_DRAFT);
  /** The tail of the attach chain: a request waits for every request before it. */
  const chain = useRef<Promise<void>>(Promise.resolve());

  /** Publish the next draft, for this batch and for the next render. */
  function publish(next: ImageDraft): void {
    current.current = next;
    setDraft(next);
  }

  /** Write an editor state into the prompt, through the handle the input publishes. */
  function write(editor: EditorState): void {
    options.input.current?.edit(editor);
  }

  /** Put `chunk` into the prompt as text at the newest cursor — a paste that was no image. */
  function putBack(chunk: string): void {
    write(withChunk(options.editor(), chunk));
  }

  /**
   * Attach `bytes` at the newest cursor, or return the reason it cannot be attached. A
   * refusal writes nothing and leaves the draft exactly as it was.
   */
  function attachBytes(bytes: Uint8Array, source: string): string | undefined {
    const result = imageFromBytes(bytes, source);
    if ("refusal" in result) return result.refusal;
    const attached = attachToDraft(current.current, options.editor(), result.image);
    if ("refusal" in attached) return attached.refusal;
    publish(attached.draft);
    write(attached.editor);
    return undefined;
  }

  /** Attach bytes that were asked for by name, noticing the refusal when there is one. */
  function attachAndReport(bytes: Uint8Array, source: string): void {
    const refusal = attachBytes(bytes, source);
    if (refusal !== undefined) options.notice(`${NOT_ATTACHED}: ${refusal}`);
  }

  /** The ctrl+v flow: whatever the clipboard holds, and nothing else. */
  async function fromClipboard(): Promise<void> {
    const read = await _imageAttachDeps.readClipboard();
    if (read.kind === "none") {
      options.notice(NO_CLIPBOARD_IMAGE);
      return;
    }
    if (read.kind === "unsupported") {
      options.notice(CLIPBOARD_UNSUPPORTED);
      return;
    }
    if (read.kind === "failed") {
      options.notice(`${CLIPBOARD_FAILED}: ${read.reason}`);
      return;
    }
    attachAndReport(read.bytes, CLIPBOARD_SOURCE);
  }

  /**
   * Read a named file. A paste whose file is missing, or holds no image, goes back into the
   * prompt as the text it would have been — a normal paste must never be lost — while a path
   * the user typed on purpose is told what happened instead.
   */
  async function fromFile(attempt: FileAttempt): Promise<void> {
    const bytes = await _imageAttachDeps.readFile(attempt.path);
    if (bytes === undefined) {
      if (attempt.fallback !== undefined) {
        putBack(attempt.fallback);
        return;
      }
      options.notice(`${NOT_FOUND}: ${attempt.label}`);
      return;
    }
    if (attempt.fallback !== undefined && sniffImage(bytes) === undefined) {
      putBack(attempt.fallback);
      return;
    }
    attachAndReport(bytes, attempt.path);
  }

  /**
   * Run `task` after every attach already asked for, and settle when it has run. The chain is
   * kept alive after a failure — one bad read must not strand the requests behind it — and a
   * read that throws anyway becomes a notice, because no attach may take the screen down (the
   * caller is a key handler that cannot await it).
   */
  function run(task: () => Promise<void>): Promise<void> {
    const next = chain.current.then(task).catch((error: unknown) => {
      options.notice(`${NOT_ATTACHED}: ${errorMessage(error)}`);
    });
    chain.current = next;
    return next;
  }

  /** The clipboard flow, or a named file's — the one `/image <path>` reaches. */
  function attach(path?: string): Promise<void> {
    if (!options.active()) return Promise.resolve();
    if (path === undefined) return run(fromClipboard);
    return run(() => fromFile({ path: resolve(options.cwd, path), label: path }));
  }

  /** Offer a pasted chunk: true only when it named an image file and was taken. */
  function onPaste(chunk: string): boolean {
    const path = pastedImagePath(chunk, options.cwd);
    if (path === undefined || !options.active()) return false;
    void run(() => fromFile({ path, label: path, fallback: chunk }));
    return true;
  }

  return {
    current: () => current.current,
    onPaste,
    attach,
    restore: publish,
    reset: () => publish(EMPTY_IMAGE_DRAFT),
  };
}

/**
 * Ceilings that bound the WORK, not just the answer.
 *
 * Every tool honoured `maxBytes` on the way out, but produced its output by
 * reading a whole file or draining a whole stream first. The ceiling described
 * what the model was told while the memory it took to get there was unbounded,
 * so a large but entirely permitted in-root file was enough to exhaust it --
 * no traversal, no escape, nothing the permission policy could see.
 *
 * Both stream helpers deliberately return up to `maxBytes + 1` bytes. That extra
 * byte is what lets a caller distinguish "this is the whole thing" from "there
 * was more", without a second stat or read.
 *
 * `readBytesPrefix` is the exception: it says how much the file holds instead
 * of carrying a marker byte, so it returns at most `maxBytes` and leaves the
 * "was there more" question to `size`.
 */

import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { NaxError } from "#src/infra/index";

function notRegularFileError(path: string): NaxError {
  return new NaxError(`"${path}" is not a regular file`, "READ_NOT_REGULAR_FILE", { stage: "read", path });
}

/** What an opened file's `stat()` must answer for the regular-file check and the size. */
export interface OpenedFileStat {
  readonly size: number;
  isFile(): boolean;
}

/**
 * The part of a `FileHandle` this module uses. Declared structurally so a test
 * can supply a fake one (`_boundedIoDeps.open`) with no cast: a short read, a
 * file that shrinks after the open, or a handle whose `stat` says "not a file".
 */
export interface BoundedHandle {
  stat(): Promise<OpenedFileStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/**
 * The filesystem operations `readPrefix`/`readBytesPrefix`/`openBoundedFile`
 * perform. At least one caller needs more than one read from ONE open file (the
 * image branch sniffs a header and then reads the body), and the open is the
 * thing that has to be shared, not the read.
 */
export const _boundedIoDeps: {
  open(path: string, flags: number): Promise<BoundedHandle>;
  stat(path: string): Promise<OpenedFileStat>;
} = { open, stat };

/** At most `maxBytes` leading bytes of a file, and the file's size when it was opened. */
export interface BytesPrefix {
  readonly bytes: Uint8Array;
  readonly size: number;
}

/**
 * One open regular file, readable from the start as many times as a caller
 * needs. Both reads come from the same handle, so a path replaced between them
 * cannot hand the caller a body that is not the file the first read described.
 */
export interface BoundedFile {
  /** The file's size when it was opened. */
  readonly size: number;
  /** The first `maxBytes` bytes, or fewer at end of file. */
  prefix(maxBytes: number): Promise<Uint8Array>;
  /**
   * The file's size now, taken from the SAME open handle as `size` — a caller
   * that read exactly `size` bytes needs this to tell a whole file from a
   * truncation of one that grew after the open.
   */
  currentSize(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Read exactly the wanted bytes from the start of the file, looping over short
 * reads: POSIX allows `read` to return fewer bytes than asked without being at
 * EOF, so one call is not "the prefix". A file that shrank under the handle
 * simply yields fewer bytes than asked; the caller compares with `size`.
 */
async function readFromStart(handle: BoundedHandle, want: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(want);
  let total = 0;
  while (total < want) {
    const { bytesRead } = await handle.read(buffer, total, want - total, total);
    if (bytesRead <= 0) break;
    total += bytesRead;
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, total);
}

function wrapHandle(handle: BoundedHandle, size: number): BoundedFile {
  return {
    size,
    // Ask for no more than the file holds, so a 20-byte header read costs 20
    // bytes rather than a full header buffer's worth. A reported size of 0 is
    // NOT a trustworthy ceiling: Linux procfs entries are regular files that
    // report size 0 and still carry their text, so they are read unclamped and
    // end at EOF like any other file.
    prefix: (maxBytes: number) => readFromStart(handle, Math.max(0, size > 0 ? Math.min(maxBytes, size) : maxBytes)),
    currentSize: async () => (await handle.stat()).size,
    close: () => handle.close(),
  };
}

/**
 * Open `path` as a regular file, or throw `READ_NOT_REGULAR_FILE`.
 *
 * The open itself is the non-blocking one (`readPrefix` has to open a FIFO
 * without hanging on it and then refuse it); a path that cannot be opened at
 * all is re-checked with `stat` so a directory or a FIFO is reported by name
 * rather than as a raw `EISDIR`/`EACCES`.
 */
export async function openBoundedFile(path: string): Promise<BoundedFile> {
  let handle: BoundedHandle;
  try {
    handle = await _boundedIoDeps.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const pathIsNonRegular = await _boundedIoDeps.stat(path).then(
      (info) => !info.isFile(),
      () => false,
    );
    if (pathIsNonRegular) throw notRegularFileError(path);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notRegularFileError(path);
    return wrapHandle(handle, info.size);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Read at most `maxBytes + 1` bytes of a UTF-8 file, never the whole file. */
export async function readPrefix(path: string, maxBytes: number): Promise<string> {
  const file = await openBoundedFile(path);
  try {
    return Buffer.from(await file.prefix(maxBytes + 1)).toString("utf8");
  } finally {
    await file.close();
  }
}

/**
 * Read at most `maxBytes` raw bytes of a file, plus the file's full size.
 *
 * `readPrefix` decodes UTF-8 and so cannot carry image bytes; this is the same
 * open and regular-file check (a FIFO or a directory is `READ_NOT_REGULAR_FILE`
 * rather than a hang) over a byte buffer. `size` comes from the open handle so
 * a caller can tell "this is the whole file" from "there was more" without a
 * second stat against a path that may have been replaced in between.
 */
export async function readBytesPrefix(path: string, maxBytes: number): Promise<BytesPrefix> {
  const file = await openBoundedFile(path);
  try {
    return { bytes: await file.prefix(maxBytes), size: file.size };
  } finally {
    await file.close();
  }
}

/**
 * Consume a stream until `maxBytes + 1` bytes have arrived, then stop.
 * Cancelling the reader is the point: a subprocess whose output is no longer
 * being consumed blocks on its own pipe and is then reaped by its caller's
 * timeout, instead of being allowed to fill memory for as long as that timeout
 * permits. `git log -p` on a large repository is the case in mind.
 */
export async function drainBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (Buffer.byteLength(out, "utf8") <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

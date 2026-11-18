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
import { type FileHandle, open, stat } from "node:fs/promises";
import { NaxError } from "#src/infra/index";

function notRegularFileError(path: string): NaxError {
  return new NaxError(`"${path}" is not a regular file`, "READ_NOT_REGULAR_FILE", { stage: "read", path });
}

/** At most `maxBytes` leading bytes of a file, and the file's size when it was opened. */
export interface BytesPrefix {
  readonly bytes: Uint8Array;
  readonly size: number;
}

/** Read at most `maxBytes + 1` bytes of a UTF-8 file, never the whole file. */
export async function readPrefix(path: string, maxBytes: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const pathIsNonRegular = await stat(path).then(
      (info) => !info.isFile(),
      () => false,
    );
    if (pathIsNonRegular) throw notRegularFileError(path);
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw notRegularFileError(path);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
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
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const pathIsNonRegular = await stat(path).then(
      (info) => !info.isFile(),
      () => false,
    );
    if (pathIsNonRegular) throw notRegularFileError(path);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notRegularFileError(path);
    // Ask for no more than the file holds, so a 20-byte header read costs 20
    // bytes rather than a full header buffer's worth.
    const buffer = Buffer.alloc(Math.max(0, Math.min(maxBytes, info.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead), size: info.size };
  } finally {
    await handle.close();
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

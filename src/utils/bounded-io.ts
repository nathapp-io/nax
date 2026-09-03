/**
 * Ceilings that bound the WORK, not just the answer.
 *
 * Every tool honoured `maxBytes` on the way out, but produced its output by
 * reading a whole file or draining a whole stream first. The ceiling described
 * what the model was told while the memory it took to get there was unbounded,
 * so a large but entirely permitted in-root file was enough to exhaust it --
 * no traversal, no escape, nothing the permission policy could see.
 *
 * Both helpers deliberately return up to `maxBytes + 1` bytes. That extra byte
 * is what lets a caller distinguish "this is the whole thing" from "there was
 * more", without a second stat or read.
 */

import { open } from "node:fs/promises";

/** Read at most `maxBytes + 1` bytes of a UTF-8 file, never the whole file. */
export async function readPrefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Consume a stream until `maxBytes + 1` bytes have arrived, then stop.
 *
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

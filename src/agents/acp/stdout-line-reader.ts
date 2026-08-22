/**
 * Incremental NDJSON stdout line reader for the spawn-based ACP client.
 * Split out of spawn-client.ts to keep that file under the source-file size limit.
 */

import type { AcpLineActivity, AcpParseState } from "@/agents";
import { parseAcpxJsonLine } from "@/agents";
import { getSafeLogger } from "@/logger";

/**
 * @internal Not part of the `@/agents` public surface. It is re-exported from
 * the barrel only so `test/unit/agents/acp/stdout-line-reader.test.ts` can reach
 * it without a deep internal import. Production callers use `spawn-client.ts`.
 *
 * Maximum bytes buffered in `remainder` while waiting for a newline. Guards
 * against unbounded memory growth from a newline-less or multi-MB line on
 * the acpx stdout stream (BUG-49) — without a cap, a single pathological
 * line doubles memory usage (raw bytes held alongside the growing string)
 * before any consumer ever sees it.
 */
export const MAX_BUFFERED_LINE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * @internal Not part of the `@/agents` public surface — see the note on
 * `MAX_BUFFERED_LINE_BYTES` above. The sole production caller is
 * `spawn-client.ts`, which imports it directly from this module.
 *
 * MEM-1: read a stream to string, keeping only a rolling tail of at most
 * `maxBytes`. Prevents unbounded stderr buffering from becoming the response
 * message content on failure — a verbose agent can emit many MB before dying,
 * and the tail is where the actual error lives.
 */
export const MAX_BUFFERED_STDERR_BYTES = 64 * 1024; // 64KB rolling tail

export function readStreamTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = MAX_BUFFERED_STDERR_BYTES,
): { promise: Promise<string>; cancel: () => void } {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let tail = "";

  const append = (chunk: string): void => {
    tail += chunk;
    const bytes = Buffer.byteLength(tail, "utf8");
    if (bytes <= maxBytes) return;
    // Keep the last `maxBytes` bytes, never splitting a multi-byte UTF-8
    // sequence: find the byte cutoff, then walk forward by whole code points
    // (surrogate pairs count as one) so the slice lands on a clean boundary.
    let cutoff = bytes - maxBytes;
    let index = 0;
    while (index < tail.length && cutoff > 0) {
      const cp = tail.codePointAt(index) ?? 0;
      const units = cp > 0xffff ? 2 : 1;
      index += units;
      cutoff -= Buffer.byteLength(String.fromCodePoint(cp), "utf8");
    }
    tail = tail.slice(index);
  };

  const promise = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
      append(decoder.decode());
      return tail;
    } finally {
      reader.releaseLock();
    }
  })();
  // Mirror readAndParseLines — expose cancel so the caller can settle the
  // pending read() when a drain-timeout race is lost (MEM-38). Without
  // cancel, the loser of drainB.stderr holds the stream lock + decoder +
  // 64KB tail closure for the rest of the process.
  return {
    promise,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

/**
 * @internal Not part of the `@/agents` public surface — see the note on
 * `MAX_BUFFERED_LINE_BYTES` above. The sole production caller is
 * `spawn-client.ts`, which imports it directly from this module.
 *
 * Read chunks from a stream, split on newlines, and feed each complete line
 * into an AcpxParseState incrementally. Discards raw bytes immediately after
 * parsing so only the extracted fields (strings + numbers) are held in memory.
 *
 * The caller races the returned promise against a drain timeout to handle the
 * Bun bug where piped streams may not close after SIGTERM.
 *
 * When onActivity is provided, it is called immediately for each line that
 * produces activity metadata
 * (message_update, thinking_update, usage_update, tool_call_update).
 *
 * Returns a `{ promise, cancel }` pair rather than a bare Promise so the caller can cancel
 * the underlying reader when a drain-timeout race is lost (BUG-46) — otherwise the pending
 * `reader.read()` never settles and the reader/lock is held for the life of the process.
 */
export function readAndParseLines(
  stream: ReadableStream<Uint8Array>,
  state: AcpParseState,
  onActivity?: (activity: AcpLineActivity) => void,
): { promise: Promise<void>; cancel: () => void } {
  const decoder = new TextDecoder();
  let remainder = "";
  const reader = stream.getReader();
  const promise = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        remainder += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = remainder.indexOf("\n");
          if (nl < 0) break;
          const line = remainder.slice(0, nl);
          remainder = remainder.slice(nl + 1);
          if (line.trim()) {
            const activity = parseAcpxJsonLine(line, state);
            if (activity && onActivity) onActivity(activity);
          }
        }
        // No newline found yet and the buffered partial line has grown past
        // the cap — a single JSON-RPC message cannot be safely truncated
        // (it would corrupt the framing on the next parse attempt either
        // way), so drop the oversized buffer and resynchronize on the next
        // newline rather than let it grow without bound.
        if (Buffer.byteLength(remainder, "utf8") > MAX_BUFFERED_LINE_BYTES) {
          getSafeLogger()?.error("acp-adapter", "Dropping oversized buffered stdout line (exceeds cap)", {
            bufferedBytes: Buffer.byteLength(remainder, "utf8"),
            maxBufferedLineBytes: MAX_BUFFERED_LINE_BYTES,
          });
          remainder = "";
        }
      }
      // Flush decoder and process any content after the last newline
      remainder += decoder.decode();
      if (remainder.trim()) {
        const activity = parseAcpxJsonLine(remainder.trim(), state);
        if (activity && onActivity) onActivity(activity);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    promise,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

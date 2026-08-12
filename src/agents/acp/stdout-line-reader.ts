/**
 * Incremental NDJSON stdout line reader for the spawn-based ACP client.
 * Split out of spawn-client.ts to keep that file under the source-file size limit.
 */

import type { AcpLineActivity, AcpParseState } from "@/agents";
import { parseAcpxJsonLine } from "@/agents";
import { getSafeLogger } from "@/logger";

/**
 * Maximum bytes buffered in `remainder` while waiting for a newline. Guards
 * against unbounded memory growth from a newline-less or multi-MB line on
 * the acpx stdout stream (BUG-49) — without a cap, a single pathological
 * line doubles memory usage (raw bytes held alongside the growing string)
 * before any consumer ever sees it.
 */
export const MAX_BUFFERED_LINE_BYTES = 10 * 1024 * 1024; // 10MB

/**
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

/**
 * Bounded, tail-keeping capture of a child's piped output streams.
 *
 * A coverage run under `AGENT=1` stays quiet: the child's output is drained into memory
 * and replayed only when something fails. Two properties matter to the caller.
 *
 * Draining starts at launch and is NOT the same event as the child exiting. A descendant
 * that inherited the pipe keeps it open after its own parent is gone, so "the child
 * exited" does not mean "the output is complete": awaiting EOF without a bound hangs the
 * run past the deadline it was given. The caller therefore races this capture against its
 * own deadline and, when the deadline wins, detaches it (`StreamCapture.detach`) instead
 * of waiting for an EOF that may never come.
 *
 * Memory stays bounded per stream. A chatty failing run is exactly when the diagnostic
 * matters and exactly when the output is largest, so only the LAST `MAX_CAPTURE_BYTES` of
 * each stream are kept — the tail is where bun's pass/fail block and the failure text
 * live. Bytes dropped from the head are counted, never kept, so a run that prints
 * hundreds of megabytes cannot grow this process: it costs one bounded buffer per stream.
 */

/** Output retained per stream. Anything older is dropped: diagnostics are read from the tail. */
export const MAX_CAPTURE_BYTES = 64 * 1024;

export interface CapturedTail {
  /** The retained bytes, decoded as UTF-8. */
  text: string;
  /** Bytes read from the stream in total, including any dropped from the head. */
  bytes: number;
  /** Whether earlier bytes were dropped to stay within the cap. */
  truncated: boolean;
}

export interface StreamCapture {
  /** What has arrived so far. Safe to call before EOF — this is what a deadline reads. */
  snapshot(): CapturedTail;
  /** Resolves at EOF. Never awaited once the deadline has detached the capture. */
  done: Promise<CapturedTail>;
  /** Releases the pending read without waiting for EOF. */
  detach(): void;
}

/** Joins the retained chunks into one buffer, so the tail decodes as one text. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
}

/**
 * Starts draining `stream` immediately, keeping at most `capBytes` of its tail.
 *
 * An inherited descriptor (`"inherit"`, i.e. a number) yields an empty capture: there is
 * nothing here to drain, because the child writes to this process's own streams.
 */
export function captureStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
  capBytes: number = MAX_CAPTURE_BYTES,
): StreamCapture {
  if (!(stream instanceof ReadableStream)) {
    const empty: CapturedTail = { text: "", bytes: 0, truncated: false };
    return { snapshot: () => empty, done: Promise.resolve(empty), detach: () => {} };
  }
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  let seenBytes = 0;

  const snapshot = (): CapturedTail => ({
    text: new TextDecoder().decode(concat(kept)),
    bytes: seenBytes,
    // A cut at the cap can split a multi-byte character, which decodes as U+FFFD at the
    // head of the tail. That is cosmetic; the tail's end, where failure text lives, is intact.
    truncated: seenBytes > keptBytes,
  });

  const done = (async (): Promise<CapturedTail> => {
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) return snapshot();
      if (value === undefined || value.byteLength === 0) continue;
      seenBytes += value.byteLength;
      kept.push(value);
      keptBytes += value.byteLength;
      while (keptBytes > capBytes && kept.length > 0) {
        const head = kept[0];
        const excess = keptBytes - capBytes;
        if (head.byteLength <= excess) {
          kept.shift();
          keptBytes -= head.byteLength;
        } else {
          // Trim inside the head chunk: the excess is a byte count, not a chunk boundary.
          kept[0] = head.subarray(excess);
          keptBytes -= excess;
        }
      }
    }
  })();

  return {
    snapshot,
    done,
    // `cancel` settles the pending read instead of leaving it waiting on a pipe that a
    // descendant may hold forever. Nothing awaits `done` after a detach, and the caller
    // attaches a catch to it, so a rejection here stays handled.
    detach: () => {
      void reader.cancel().catch(() => {});
    },
  };
}

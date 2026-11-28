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
 * The bound holds on the text that is REPLAYED, not just on the bytes buffered — see
 * `fitToByteCap` for why decoding a tail can grow it.
 */

/** Output retained per stream. Anything older is dropped: diagnostics are read from the tail. */
export const MAX_CAPTURE_BYTES = 64 * 1024;

export interface CapturedTail {
  /** The retained bytes, decoded as UTF-8 and trimmed so they re-encode within the cap. */
  text: string;
  /** Bytes read from the stream in total, including any dropped from the head. */
  bytes: number;
  /** Whether anything was dropped: bytes from the buffer, or characters from the text. */
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

/** UTF-8 byte length of one code point, as `String.prototype.codePointAt` reports it. */
function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x1_0000) return 3;
  return 4;
}

/**
 * Drops leading characters until `text` re-encodes within `capBytes`, keeping the tail.
 *
 * Bounding the BUFFERED bytes is not enough. A tail that starts inside a multi-byte
 * character decodes with U+FFFD where the partial bytes were, and one replacement character
 * is three bytes in place of one to three — so the replayed text can be LARGER than the
 * bytes retained, and the diagnostic the user sees can exceed the cap it is supposed to
 * honour. Trimming from the head keeps the tail (bun's pass/fail block and the failure
 * text) and makes the bound hold on what is replayed, not on what was buffered. It also
 * removes those replacement characters whenever they are the cheapest thing to drop, so the
 * head of the tail is normally a whole character.
 */
function fitToByteCap(text: string, capBytes: number): string {
  let bytes = Buffer.byteLength(text);
  if (bytes <= capBytes) return text;
  let cut = 0;
  while (bytes > capBytes && cut < text.length) {
    const codePoint = text.codePointAt(cut);
    if (codePoint === undefined) break;
    bytes -= utf8Size(codePoint);
    // A surrogate pair is two UTF-16 units; never cut between its halves.
    cut += codePoint > 0xffff ? 2 : 1;
  }
  return text.slice(cut);
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

  const snapshot = (): CapturedTail => {
    const decoded = new TextDecoder().decode(concat(kept));
    const text = fitToByteCap(decoded, capBytes);
    return { text, bytes: seenBytes, truncated: seenBytes > keptBytes || text !== decoded };
  };

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

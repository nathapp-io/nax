/**
 * Tests for readAndParseLines — stdout-line-reader.ts
 *
 * BUG-49: unbounded buffering of `remainder` for newline-less/multi-MB lines
 * could grow memory without bound. MAX_BUFFERED_LINE_BYTES caps it.
 */

import { describe, expect, test } from "bun:test";
import { MAX_BUFFERED_LINE_BYTES, createParseState, readAndParseLines } from "@/agents";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

describe("readAndParseLines", () => {
  test("parses complete NDJSON lines split across chunks", async () => {
    const line1 =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}';
    const stream = makeStream([line1.slice(0, 20), line1.slice(20), "\n"]);
    const state = createParseState();

    const { promise } = readAndParseLines(stream, state);
    await promise;

    expect(state.text).toBe("hello");
    expect(state.sawJsonLine).toBe(true);
  });

  test("BUG-49: caps unbounded buffering of a newline-less line instead of growing without bound", async () => {
    // A single pathological chunk (no newline) that already exceeds the cap
    // on its own — the reader must drop the oversized buffer immediately
    // rather than retain it, leaving nothing to flush at end-of-stream.
    const oversizedChunk = "x".repeat(MAX_BUFFERED_LINE_BYTES + 1024 * 1024);

    const stream = makeStream([oversizedChunk]);
    const state = createParseState();

    const { promise } = readAndParseLines(stream, state);
    await promise;

    // The oversized, newline-less buffer must have been dropped rather than
    // accumulated — nothing to parse, no crash, no fabricated text from a
    // never-completed line.
    expect(state.text).toBe("");
    expect(state.sawJsonLine).toBe(false);
  });

  test("BUG-49: resynchronizes on the next newline after dropping an oversized buffer", async () => {
    // The oversized chunk exceeds the cap on its own and has no trailing
    // newline, so it is dropped in full — nothing carries over into the
    // next line.
    const oversizedChunk = "x".repeat(MAX_BUFFERED_LINE_BYTES + 1024 * 1024);
    const validLine =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"recovered"}}}}';
    const stream = makeStream([oversizedChunk, "\n", validLine, "\n"]);
    const state = createParseState();

    const { promise } = readAndParseLines(stream, state);
    await promise;

    // A well-formed line arriving after the drop is still parsed correctly,
    // with nothing left over from the dropped buffer.
    expect(state.text).toBe("recovered");
    expect(state.sawJsonLine).toBe(true);
  });

  test("normal small lines are unaffected by the cap", async () => {
    const lines = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a"}}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"b"}}}}',
    ];
    const stream = makeStream([`${lines[0]}\n${lines[1]}\n`]);
    const state = createParseState();

    const { promise } = readAndParseLines(stream, state);
    await promise;

    expect(state.text).toBe("ab");
  });
});

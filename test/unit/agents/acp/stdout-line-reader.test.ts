/**
 * Tests for readAndParseLines — stdout-line-reader.ts
 *
 * BUG-49: unbounded buffering of `remainder` for newline-less/multi-MB lines
 * could grow memory without bound. MAX_BUFFERED_LINE_BYTES caps it.
 */

import { describe, expect, test } from "bun:test";
import { MAX_BUFFERED_LINE_BYTES, createParseState, readAndParseLines, readStreamTail } from "@/agents";

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

describe("readStreamTail (MEM-1)", () => {
  const enc = new TextEncoder();

  function streamOf(content: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(content)); c.close(); },
    });
  }

  test("small content passes through unchanged", async () => {
    const result = await readStreamTail(streamOf("connection refused"), 1024);
    expect(result).toBe("connection refused");
  });

  test("content over the cap is trimmed to the last maxBytes", async () => {
    const big = "x".repeat(10_000) + "TAIL";
    const result = await readStreamTail(streamOf(big), 100);
    expect(result.endsWith("TAIL")).toBe(true);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100);
  });

  test("never splits a multi-byte UTF-8 sequence at the trim boundary", async () => {
    const heart = "❤".repeat(5000); // 3 bytes each
    const result = await readStreamTail(streamOf(heart), 100);
    // Trimming may drop whole code points, but must never leave a broken
    // surrogate / invalid sequence — round-trip through a decoder.
    const reparsed = new TextDecoder().decode(enc.encode(result));
    expect(reparsed).toBe(result);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100);
  });

  test("never splits an astral-plane surrogate pair at the trim boundary", async () => {
    const clef = "𝄞".repeat(5000); // U+1D11E — 4 bytes, surrogate pair in UTF-16
    const result = await readStreamTail(streamOf(clef), 100);
    const reparsed = new TextDecoder().decode(enc.encode(result));
    expect(reparsed).toBe(result);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100);
    // No lone surrogates: every code unit pairs up.
    for (let i = 0; i < result.length; i++) {
      const unit = result.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = result.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
  });

  test("chunks split mid-UTF-8-sequence are decoded correctly", async () => {
    const content = "a❤b";
    const bytes = enc.encode(content);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 2)); // splits the 3-byte heart mid-sequence
        c.enqueue(bytes.slice(2));
        c.close();
      },
    });
    const result = await readStreamTail(stream, 1024);
    expect(result).toBe(content);
  });
});

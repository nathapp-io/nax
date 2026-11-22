/** The bounded, line-aware shell output tail behind the live tail and the shell view. */

import { describe, expect, test } from "bun:test";
import {
  createShellTail,
  SHELL_TAIL_MAX_BYTES,
  SHELL_TAIL_MAX_LINES,
  SHELL_TAIL_REFRESH_MS,
  type ShellTailView,
} from "@/chat/background";
import type { ShellTail } from "@/chat/background/shell-tail";

const encoder = new TextEncoder();

function appendText(tail: ShellTail, text: string): void {
  tail.append(encoder.encode(text));
}

/** The view of a tail fed the whole text in one chunk, for the single-append cases. */
function viewOf(text: string, limits?: { maxLines: number; maxBytes: number }): ShellTailView {
  const tail = createShellTail(limits);
  appendText(tail, text);
  return tail.view();
}

const TIGHT = { maxLines: 1000, maxBytes: 4 };

const lineCases: ReadonlyArray<[string, string[]]> = [
  ["a\nb\n", ["a", "b"]],
  ["a\nb", ["a", "b"]],
  ["x\r\ny\r\n", ["x", "y"]],
  ["a\n\nb\n", ["a", "", "b"]],
];

describe("createShellTail", () => {
  describe("lines", () => {
    test.each(lineCases)("splits %p into its lines", (input, expected) => {
      expect(viewOf(input).lines).toEqual(expected);
    });

    test("keeps a partial line open across appends", () => {
      const tail = createShellTail();
      appendText(tail, "a\nb");
      expect(tail.view().lines).toEqual(["a", "b"]);
      appendText(tail, "c\n");
      expect(tail.view().lines).toEqual(["a", "bc"]);
    });

    test("treats a CRLF split across appends as one line ending", () => {
      const tail = createShellTail();
      appendText(tail, "x\r");
      appendText(tail, "\ny\n");
      expect(tail.view().lines).toEqual(["x", "y"]);
      expect(tail.view().lines).toEqual(viewOf("x\r\ny\n").lines);
    });

    test("lets a lone CR replace the partial line", () => {
      const tail = createShellTail();
      appendText(tail, "10%\r50%\r");
      appendText(tail, "100%\n");
      expect(tail.view().lines).toEqual(["100%"]);
    });

    test("reports a tail with nothing dropped as not truncated", () => {
      expect(viewOf("a\nb\n").truncated).toBe(false);
    });

    test("leaves the view unchanged when an empty chunk is appended", () => {
      const tail = createShellTail();
      appendText(tail, "a\nb");
      const before = tail.view();
      const bytesBefore = tail.bytes();
      tail.append(new Uint8Array(0));
      expect(tail.view()).toEqual(before);
      expect(tail.view().lines).toEqual(["a", "b"]);
      expect(tail.bytes()).toBe(bytesBefore);
    });
  });

  describe("UTF-8 decoding", () => {
    test("joins a multibyte character split across appends", () => {
      const tail = createShellTail();
      const bytes = encoder.encode("é");
      tail.append(bytes.subarray(0, 1));
      tail.append(bytes.subarray(1));
      expect(tail.view().lines).toEqual(["é"]);
    });

    test("replaces an invalid byte with U+FFFD", () => {
      const tail = createShellTail();
      tail.append(new Uint8Array([0xff]));
      appendText(tail, "\n");
      expect(tail.view().lines).toEqual(["\ufffd"]);
    });
  });

  describe("default caps", () => {
    const lines = Array.from({ length: 2001 }, (_, index) => `l${index + 1}`);

    function tailOf2001Lines(): ShellTail {
      const tail = createShellTail();
      for (const line of lines) appendText(tail, `${line}\n`);
      return tail;
    }

    test("drops the oldest line past the line cap", () => {
      expect(tailOf2001Lines().view().lines).toEqual(lines.slice(1));
    });

    test("reports a tail that dropped lines as truncated", () => {
      expect(tailOf2001Lines().view().truncated).toBe(true);
    });

    test("keeps the retained lines within the byte cap", () => {
      const tail = createShellTail();
      for (let index = 0; index < 400; index++) appendText(tail, `${"x".repeat(1000)}\n`);
      expect(tail.bytes()).toBeLessThanOrEqual(262144);
    });

    test("reports a tail that dropped bytes as truncated", () => {
      const tail = createShellTail();
      appendText(tail, `${"x".repeat(SHELL_TAIL_MAX_BYTES + 1)}\n`);
      expect(tail.view().truncated).toBe(true);
    });

    test("pins the default limits and the refresh interval", () => {
      expect(SHELL_TAIL_MAX_LINES).toBe(2000);
      expect(SHELL_TAIL_MAX_BYTES).toBe(262144);
      expect(SHELL_TAIL_REFRESH_MS).toBe(100);
    });
  });

  describe("custom limits", () => {
    test("keeps only the newest lines under the line cap", () => {
      expect(viewOf("a\nb\nc\n", { maxLines: 2, maxBytes: 1024 }).lines).toEqual(["b", "c"]);
    });

    test("counts the partial line toward the line cap", () => {
      expect(viewOf("a\nb\nc", { maxLines: 2, maxBytes: 1024 }).lines).toEqual(["b", "c"]);
    });

    test("drops the oldest complete line past the byte cap", () => {
      expect(viewOf("abc\ndef\n", TIGHT).lines).toEqual(["def"]);
    });

    test("keeps the newest bytes of an over-long partial line", () => {
      expect(viewOf("abcdefgh", TIGHT).lines).toEqual(["efgh"]);
    });

    test("keeps the newest bytes of an over-long complete line", () => {
      expect(viewOf("abcdefgh\n", TIGHT).lines).toEqual(["efgh"]);
    });

    test("does not count newlines toward the byte cap", () => {
      const tail = createShellTail(TIGHT);
      appendText(tail, "ab\ncd\n");
      expect(tail.view().lines).toEqual(["ab", "cd"]);
      expect(tail.bytes()).toBe(4);
    });
  });

  describe("evict", () => {
    test("empties the tail and reports it truncated", () => {
      const tail = createShellTail();
      appendText(tail, "a\nb\n");
      tail.evict();
      expect(tail.view().lines).toEqual([]);
      expect(tail.view().truncated).toBe(true);
    });

    test("drops every retained byte", () => {
      const tail = createShellTail();
      appendText(tail, "a\nb\n");
      tail.evict();
      expect(tail.bytes()).toBe(0);
    });
  });
});

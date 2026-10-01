import { describe, expect, test } from "bun:test";
import { stripControlChars } from "@/utils/strip-control-chars";

describe("stripControlChars (SEC-09)", () => {
  test("strips a CSI cursor-move sequence", () => {
    const out = stripControlChars("before\x1b[2Jafter");
    expect(out).toBe("beforeafter");
  });

  test("strips a CSI color sequence", () => {
    const out = stripControlChars("\x1b[31mred text\x1b[0m");
    expect(out).toBe("red text");
  });

  test("strips an OSC 52 clipboard-write sequence terminated by BEL", () => {
    const out = stripControlChars("evil\x1b]52;c;ZXZpbA==\x07safe");
    expect(out).toBe("evilsafe");
  });

  test("strips an OSC sequence terminated by ST (ESC \\)", () => {
    const out = stripControlChars("evil\x1b]0;title\x1b\\safe");
    expect(out).toBe("evilsafe");
  });

  test("strips a short two-byte escape", () => {
    const out = stripControlChars("before\x1bcafter");
    expect(out).toBe("beforeafter");
  });

  test("strips stray control bytes not part of an escape sequence", () => {
    const out = stripControlChars("a\x00b\x07c");
    expect(out).toBe("abc");
  });

  test("preserves tabs, newlines, and carriage returns", () => {
    const out = stripControlChars("line1\nline2\tindented\r\n");
    expect(out).toBe("line1\nline2\tindented\r\n");
  });

  test("leaves ordinary text untouched", () => {
    expect(stripControlChars("US-001: implement the login form")).toBe("US-001: implement the login form");
  });

  test("handles empty string", () => {
    expect(stripControlChars("")).toBe("");
  });
});

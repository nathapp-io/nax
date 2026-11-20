import { describe, expect, test } from "bun:test";
import { stripControlChars } from "#src/internal/strip-control-chars";

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

  // B1: the C1 block (0x80-0x9F) is the other half of the control repertoire. A terminal in 8-bit
  // mode reads 0x9B for CSI and 0x9D for OSC, so leaving them in a display string hands it a way to
  // rewrite the line that the C0 strip never saw.
  test("strips an 8-bit CSI sequence (0x9B) with its parameters", () => {
    expect(stripControlChars("before\u009b31mred\u009b0mafter")).toBe("beforeredafter");
  });

  test("strips an 8-bit OSC sequence (0x9D) terminated by BEL", () => {
    expect(stripControlChars("evil\u009d0;title\u0007safe")).toBe("evilsafe");
  });

  test("strips a stray C1 control byte", () => {
    expect(stripControlChars("a\u0085b\u009fc")).toBe("abc");
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

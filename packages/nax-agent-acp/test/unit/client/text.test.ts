import { describe, expect, test } from "bun:test";
import { capBytes, isRecord, scrubSecrets, stripControl, stripInvisible } from "#src/client/text";

describe("text hygiene (spec §6.4 untrusted fields, §7)", () => {
  test("stripControl keeps newline and tab, drops other control characters", () => {
    expect(stripControl("a\u0000b\u001b[31mc\nd\te\u007f")).toBe("ab[31mc\nd\te");
  });

  test("stripInvisible drops format characters: bidi overrides and zero-width", () => {
    expect(stripInvisible("a\u200bb\u202ec\u2066d\ufeffe")).toBe("abcde");
  });

  test("scrubSecrets replaces values of 8+ characters only", () => {
    expect(scrubSecrets("key=abcdefgh short=abc", ["abcdefgh", "abc"])).toBe("key=[REDACTED] short=abc");
  });

  test("capBytes never splits a multi-byte character", () => {
    expect(capBytes("ab€", 4)).toBe("ab");
    expect(capBytes("short", 100)).toBe("short");
  });

  test("isRecord accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

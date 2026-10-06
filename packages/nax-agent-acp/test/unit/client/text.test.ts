import { describe, expect, test } from "bun:test";
import {
  capBytes,
  cleanLabel,
  isRecord,
  MIN_SECRET_LENGTH,
  scrubDeep,
  scrubSecrets,
  stripControl,
  stripInvisible,
} from "#src/client/text";

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

describe("scrubDeep and cleanLabel (S4-5 D5-d, D5-f)", () => {
  const SECRET = "s3cr3t-token-value-0123";

  test("scrubDeep scrubs every string, keys included, and keeps the shape", () => {
    const input = { cmd: `curl -H ${SECRET}`, list: [SECRET, 3, null, true], [SECRET]: { deep: `x${SECRET}y` } };
    expect(scrubDeep(input, [SECRET])).toEqual({
      cmd: "curl -H [REDACTED]",
      list: ["[REDACTED]", 3, null, true],
      "[REDACTED]": { deep: "x[REDACTED]y" },
    });
    expect(scrubDeep("plain", [])).toBe("plain");
    expect(scrubDeep(42, [SECRET])).toBe(42);
  });

  test("scrubDeep keeps a __proto__ key as data", () => {
    const scrubbed = scrubDeep(JSON.parse('{"__proto__": {"polluted": true}}'), []);
    expect(Object.getPrototypeOf(scrubbed)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  test("cleanLabel: one line, visible characters, secrets scrubbed, capped by code points", () => {
    expect(cleanLabel("  Run\n\t`ls`‮  ", [], 200)).toBe("Run `ls`");
    expect(cleanLabel(`use ${SECRET}`, [SECRET], 200)).toBe("use [REDACTED]");
    expect(cleanLabel("\u{1f600}".repeat(5), [], 3)).toBe("\u{1f600}".repeat(3));
    expect(cleanLabel("   ", [], 200)).toBeUndefined();
    expect(cleanLabel(7, [], 200)).toBeUndefined();
  });

  test("MIN_SECRET_LENGTH is the scrub floor", () => {
    expect(MIN_SECRET_LENGTH).toBe(8);
    expect(scrubDeep("short1", ["short1"])).toBe("short1");
  });
});

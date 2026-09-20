/**
 * US-001 AC1–AC13: shared `truncateForModel` byte-safe truncation policy.
 *
 * Each `describe` block pins one AC: the body shape that crosses the named
 * cap (or stays under every cap) and the observable behaviour the model is
 * told. Bodies larger than `MODEL_MAX_BYTES` are constructed inline from
 * single-byte characters so length matches byte length and overshoot can
 * be checked without coupling the assertions to the constant values.
 *
 * The two multi-byte tests (AC3, AC7) construct `"\u00ff"` etc. by code-point
 * so the byte length is known but the codepoint count is not — exactly the
 * shape that punishes a stray `subarray(0, maxBytes)` cut.
 */

import { describe, expect, test } from "bun:test";
import {
  MODEL_MAX_BYTES,
  MODEL_MAX_LINE_CHARS,
  MODEL_MAX_LINES,
  type TruncateForModelOptions,
  type TruncationDirection,
  truncateForModel,
} from "@/tools";

function trunc(body: string, direction: TruncationDirection = "head") {
  return truncateForModel(body, { direction });
}

describe("AC1: body within every cap is returned unchanged and truncated is false", () => {
  test("a body within MODEL_MAX_BYTES, MODEL_MAX_LINES, and MODEL_MAX_LINE_CHARS", () => {
    const res = trunc("hello\nworld");
    expect(res.content).toBe("hello\nworld");
    expect(res.truncated).toBe(false);
  });

  test("a one-line body that just fits MODEL_MAX_LINE_CHARS is unchanged", () => {
    const line = "x".repeat(MODEL_MAX_LINE_CHARS);
    const res = trunc(line);
    expect(res.content).toBe(line);
    expect(res.truncated).toBe(false);
  });

  test("a body of exactly MODEL_MAX_LINES lines is unchanged", () => {
    const lines = Array.from({ length: MODEL_MAX_LINES }, (_, i) => `line ${i + 1}`);
    const body = `${lines.join("\n")}\n`;
    const res = trunc(body);
    expect(res.content).toBe(body);
    expect(res.truncated).toBe(false);
  });
});

describe("AC2: body exceeding MODEL_MAX_BYTES returns truncated true and bytes <= MODEL_MAX_BYTES", () => {
  test("ASCII body twice the ceiling", () => {
    const body = "x".repeat(MODEL_MAX_BYTES * 2);
    const res = trunc(body);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("body one byte over MODEL_MAX_BYTES still gets truncated true and bytes <= ceiling", () => {
    const body = "x".repeat(MODEL_MAX_BYTES + 1);
    const res = trunc(body);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });
});

describe("AC3: cut landing mid-codepoint returns at most MODEL_MAX_BYTES bytes", () => {
  test("a multi-byte codepoint straddling the cut is not emitted as a replacement character", () => {
    // Build a body that is one byte short of the cap with ASCII, then add a
    // 2-byte char so the cut lands inside the multi-byte codepoint.
    const filler = "a".repeat(MODEL_MAX_BYTES - 1);
    const body = `${filler}\u00e9`; // \u00e9 is 2 bytes in UTF-8
    const expectedFullBytes = Buffer.byteLength(body, "utf8");
    expect(expectedFullBytes).toBeGreaterThan(MODEL_MAX_BYTES);

    const res = trunc(body);
    // The truncation flag must be set, since the body clearly exceeds the cap.
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    // No U+FFFD in the output: every codepoint must be a clean cut.
    expect(res.content).not.toContain("\ufffd");
  });

  test("a 3-byte codepoint straddling the cut is not emitted as a replacement character", () => {
    // 3-byte codepoint: CJK 'あ' (U+3042). ASCII padding so the body sits
    // just above the cap.
    const filler = "a".repeat(MODEL_MAX_BYTES - 1);
    const body = `${filler}\u3042`;
    const res = trunc(body);
    // The truncation flag must be set, since the body clearly exceeds the cap.
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    expect(res.content).not.toContain("\ufffd");
  });
});

describe("AC4: body with more than MODEL_MAX_LINES lines (within byte and per-line ceilings) returns <= MODEL_MAX_LINES lines", () => {
  test("body of MODEL_MAX_LINES + 50 lines retains <= MODEL_MAX_LINES lines", () => {
    const total = MODEL_MAX_LINES + 50;
    const lines = Array.from({ length: total }, (_, i) => `line ${i + 1}`);
    const body = `${lines.join("\n")}\n`;
    // Sanity: the body is within byte and per-line ceilings.
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MODEL_MAX_BYTES);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MODEL_MAX_LINE_CHARS);

    const res = trunc(body, "head");
    const outLines = res.content.split("\n");
    // Two boundary companions: the first line still appears (head keeps the
    // start), and the total count is at most MODEL_MAX_LINES. Trailing
    // newline may or may not appear depending on convention; what AC4 pins
    // is the line-count ceiling, not its marker.
    expect(outLines.length).toBeLessThanOrEqual(MODEL_MAX_LINES);
    expect(res.content).toContain("line 1");
  });
});

describe("AC5: line longer than MODEL_MAX_LINE_CHARS is shortened to that length", () => {
  test("a single over-long line within byte and line-count ceilings", () => {
    const overLong = "y".repeat(MODEL_MAX_LINE_CHARS * 2);
    const body = `${overLong}\nshort\n`;
    const res = trunc(body);
    const outLines = res.content.split("\n");
    for (const line of outLines) {
      // up to and including the cap is fine; above is a regression.
      expect(line.length).toBeLessThanOrEqual(MODEL_MAX_LINE_CHARS);
    }
    expect(res.truncated).toBe(true);
  });

  test("a surrogate-pair line is cut on the cap, never between the halves of a pair", () => {
    // 1001 emoji is 2002 UTF-16 code units — two past the cap, so a code-unit
    // cut at 2000 lands between the halves of a pair. The cap must back up to
    // the pair boundary: a lone surrogate re-encodes into a U+FFFD replacement
    // character, which would make the "shortened to MODEL_MAX_LINE_CHARS" line
    // longer in bytes than the UTF-16 length the cap was measured in.
    const emoji = "\u{1f600}";
    const body = `${emoji.repeat(1001)}\nshort\n`;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MODEL_MAX_BYTES);

    const res = trunc(body);
    const outLine = res.content.split("\n")[0];
    expect(outLine?.length).toBeLessThanOrEqual(MODEL_MAX_LINE_CHARS);
    expect(outLine).toBe(emoji.repeat(1000));
    expect(res.truncated).toBe(true);
  });
});

describe("AC6: both line-count and per-line caps apply to a body within MODEL_MAX_BYTES", () => {
  test("body with > MODEL_MAX_LINES lines and an over-long line retains <= MODEL_MAX_LINES lines, all <= MODEL_MAX_LINE_CHARS", () => {
    const overLong = "z".repeat(MODEL_MAX_LINE_CHARS * 3);
    const lines = Array.from({ length: MODEL_MAX_LINES - 2 }, (_, i) => `line ${i + 1}`);
    const body = `${overLong}\n${lines.join("\n")}\n`;
    // Sanity: the body fits within the byte ceiling when its long line is
    // capped to MODEL_MAX_LINE_CHARS. We keep the body within the headline
    // size so the byte cap doesn't dominate the test.
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MODEL_MAX_BYTES);

    const res = trunc(body, "head");
    const outLines = res.content.split("\n");
    expect(outLines.length).toBeLessThanOrEqual(MODEL_MAX_LINES);
    for (const line of outLines) {
      expect(line.length).toBeLessThanOrEqual(MODEL_MAX_LINE_CHARS);
    }
    // The over-long line was definitely shortened, and the body had more
    // than MODEL_MAX_LINES lines, so at least one stage must have changed
    // the content.
    expect(res.truncated).toBe(true);
  });
});

describe("AC7: body exceeding MODEL_MAX_BYTES with an over-long line keeps bytes <= MODEL_MAX_BYTES and no over-long line", () => {
  test("over-long line + over-cap bytes: both caps apply", () => {
    const overLong = "q".repeat(MODEL_MAX_LINE_CHARS * 4);
    const body = `${overLong}\n${"x".repeat(MODEL_MAX_BYTES)}\n`;
    const res = trunc(body);
    // The body clearly exceeds the byte cap — truncation must be reported.
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    for (const line of res.content.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(MODEL_MAX_LINE_CHARS);
    }
  });
});

describe("AC8: tail-with-first-line direction keeps the body's first line inside the byte budget", () => {
  test("first line is the body's first line and bytes <= MODEL_MAX_BYTES", () => {
    const firstLine = "header: this is the start";
    const body = `${firstLine}\n${"y".repeat(MODEL_MAX_BYTES)}\n`;
    const res = trunc(body, "tail-with-first-line");
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    const firstRetained = res.content.split("\n")[0];
    expect(firstRetained).toBe(firstLine);
  });

  test("the byte cap itself fires and the first line still fits inside it", () => {
    // Every line here is well under the per-line cap and the body is under the
    // line-count cap, so neither of the first two stages touches it: the byte
    // cap is the ONLY stage that can fire. That is the case the criterion is
    // about — the retained first line has to come out of the byte budget, not
    // be prepended on top of a body that already filled it.
    const firstLine = "HEADER";
    const filler = Array.from({ length: 900 }, () => "y".repeat(50));
    const body = `${firstLine}\n${filler.join("\n")}\n`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MODEL_MAX_BYTES);

    const res = trunc(body, "tail-with-first-line");
    expect(res.truncated).toBe(true);
    const contentBytes = Buffer.byteLength(res.content, "utf8");
    expect(contentBytes).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    expect(res.content.split("\n")[0]).toBe(firstLine);
    // Nothing was appended after the cut: were the first line added on top of
    // a full budget's worth of tail, the result would exceed the ceiling.
    expect(contentBytes).toBe(MODEL_MAX_BYTES);
  });
});

describe("AC9: trailing-newline body within every cap is returned unchanged and truncated is false", () => {
  test("trailing newline terminates the last line rather than opening an empty one", () => {
    const body = "a\nb\n";
    const res = trunc(body);
    expect(res.content).toBe(body);
    expect(res.truncated).toBe(false);
  });

  test("two-line body ending in newline within every cap", () => {
    const body = "one\ntwo\n";
    const res = trunc(body);
    expect(res.content).toBe(body);
    expect(res.truncated).toBe(false);
  });
});

describe("AC10: tail-with-first-line on a trailing-newline body exceeding MODEL_MAX_LINES keeps the body's last non-empty line", () => {
  test("the last retained line is the body's last non-empty line", () => {
    const lines = Array.from({ length: MODEL_MAX_LINES + 5 }, (_, i) => `L${i + 1}`);
    const last = lines[lines.length - 1];
    const body = `${lines.join("\n")}\n`; // trailing newline
    const res = trunc(body, "tail-with-first-line");
    const outLines = res.content.split("\n").filter((l) => l.length > 0);
    // The last retained non-empty line is `last`. Tail-with-first-line
    // keeps the first line then tails; the last entry is `last`, not "".
    expect(outLines[outLines.length - 1]).toBe(last);
  });
});

describe("AC11: head direction returns the body's first lines and omits the last line", () => {
  test("a body over MODEL_MAX_LINES with head direction drops the trailing lines and keeps the first MODEL_MAX_LINES", () => {
    // Build a body strictly over MODEL_MAX_LINES so the line-count cap
    // fires. head keeps the first N lines and drops everything else —
    // the last line of the input (and every line after) must be gone.
    const total = MODEL_MAX_LINES + 5;
    const lines = Array.from({ length: total }, (_, i) => `line-${i + 1}`);
    const body = lines.join("\n");
    // Sanity: the body is within the byte and per-line ceilings so the
    // line-count cap is the only stage that fires.
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MODEL_MAX_BYTES);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MODEL_MAX_LINE_CHARS);

    const res = trunc(body, "head");
    // Truncated is set because at least one stage changed the content.
    expect(res.truncated).toBe(true);
    const outLines = res.content.split("\n").filter((l) => l.length > 0);
    // The body's first line is kept and the body's last line is dropped.
    expect(outLines[0]).toBe("line-1");
    expect(res.content).not.toContain(`line-${total}`);
  });
});

describe("AC12: tail-with-first-line direction returns first line + last lines, omits middle", () => {
  test("a body over MODEL_MAX_LINES with tail-with-first-line keeps the first line, drops the middle, retains the tail", () => {
    // Build a body strictly over MODEL_MAX_LINES so the line-count cap
    // fires. tail-with-first-line keeps the first line and the last
    // (MODEL_MAX_LINES - 1) lines, dropping every line in between.
    // Line names are zero-padded and distinct so substring checks cannot
    // accidentally match a neighbouring number.
    const total = MODEL_MAX_LINES + 5;
    const lines = Array.from({ length: total }, (_, i) => `L${String(i).padStart(6, "0")}`);
    const body = lines.join("\n");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MODEL_MAX_BYTES);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MODEL_MAX_LINE_CHARS);

    const res = trunc(body, "tail-with-first-line");
    expect(res.truncated).toBe(true);
    // First line is kept.
    expect(res.content).toContain("L000000");
    // Last lines (at least the body's last line) are kept.
    const lastName = `L${String(total - 1).padStart(6, "0")}`;
    expect(res.content).toContain(lastName);
    // The body's last line should be the last retained line.
    const outLines = res.content.split("\n").filter((l) => l.length > 0);
    expect(outLines[outLines.length - 1]).toBe(lastName);
    // Middle lines must be omitted: a body of MODEL_MAX_LINES + 5 lines
    // has a large middle band that must not survive the cap.
    expect(res.content).not.toContain("L000001");
    expect(res.content).not.toContain("L000002");
  });
});

describe("AC13: originalBytes equals the body's full UTF-8 byte length, truncated or not", () => {
  test("untruncated body: originalBytes equals its full UTF-8 byte length", () => {
    const body = "alpha\nbeta\ngamma";
    const res = trunc(body);
    expect(res.truncated).toBe(false);
    expect(res.originalBytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  test("truncated body: originalBytes still equals its full UTF-8 byte length", () => {
    const body = "x".repeat(MODEL_MAX_BYTES * 4);
    const res = trunc(body);
    expect(res.truncated).toBe(true);
    expect(res.originalBytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  test("multi-byte body: originalBytes equals its full UTF-8 byte length, not its length", () => {
    // 5 CJK chars, each 3 bytes = 15 UTF-8 bytes, length 5.
    const body = "\u3042\u3044\u3046\u3048\u304a";
    const res = trunc(body);
    expect(res.originalBytes).toBe(15);
    expect(res.originalBytes).not.toBe(body.length);
  });
});

// Smoke test: `truncateForModel` must accept a TruncateForModelOptions shape
// from this file's imports. This isolates the surface contract from the
// implementer's structural decisions.
describe("truncateForModel signature", () => {
  test("accepts an options object with a `direction` field", () => {
    const opts: TruncateForModelOptions = { direction: "head" };
    expect(opts.direction).toBe("head");
  });
});

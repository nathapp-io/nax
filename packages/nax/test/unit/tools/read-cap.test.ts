/**
 * US-002 — Read self-caps at whole-line model caps.
 *
 * Each acceptance criterion in the story has a dedicated test (and, where
 * useful, a boundary companion). The two paths the tool exposes are
 * exercised separately — the unranged path through the `[N lines]` header,
 * the ranged path through the `[lines a-b of T]` header — and the new
 * cap-footer text is pinned in both.
 *
 * Coverage rationale — every AC is a test that INVOKES the tool at
 * runtime and asserts on the returned content (observable behaviour, not
 * source inspection). The cap footer replaces the limit-stop footer on a
 * cut result; a result never carries both. The cut keeps the largest k
 * such that header + k lines + cap footer fits both budgets; when no k
 * fits, the candidate is returned unshaped (today's result, plus the
 * limit-stop footer from rule 1 if it applied).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  applyModelTruncationPolicy,
  compileToolPolicy,
  createCodingToolRuntime,
  MODEL_MAX_BYTES,
  MODEL_MAX_LINES,
  readTool,
  registerBuiltinCodingTools,
  SCRATCHPAD_DIR,
  SPILL_DIR,
} from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-us002-cap-");
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  cleanupTempDir(root);
});

function ctx(paths: string[], maxBytes = 10_000, opts: { readCeiling?: number; maxFileBytes?: number } = {}) {
  return {
    root,
    resolvedPaths: paths,
    maxBytes,
    maxFileBytes: opts.maxFileBytes ?? 2_000_000,
    ...(opts.readCeiling === undefined ? {} : { readCeiling: opts.readCeiling }),
  };
}

// -----------------------------------------------------------------------------
// AC1 — readTool.description ends with the cap-sentence, built from the
//       MODEL_MAX_LINES / MODEL_MAX_BYTES constants.
// -----------------------------------------------------------------------------
describe("AC1: readTool.description ends with the cap sentence built from the constants", () => {
  test("AC1 — description ends with the cap sentence interpolated from MODEL_MAX_LINES and MODEL_MAX_BYTES", () => {
    // Dynamic import to keep the top-level test list lean — readTool is
    // also imported below for content tests, but reading its description
    // through the same module avoids two registry snapshots.
    return import("@/tools").then(({ readTool, MODEL_MAX_BYTES: B, MODEL_MAX_LINES: L }) => {
      const expected = `Output is capped at ${L} lines or ${B} bytes.`;
      expect(readTool.description.endsWith(expected)).toBe(true);
      expect(expected).toBe("Output is capped at 1000 lines or 40000 bytes.");
    });
  });
});

// -----------------------------------------------------------------------------
// AC2 — unranged read of a 1500-line short-line file cuts to MODEL_MAX_LINES
//       lines: header, file lines 1..998, and the cap footer.
// -----------------------------------------------------------------------------
describe("AC2: unranged read of a 1500-line file with short lines cuts to MODEL_MAX_LINES lines", () => {
  test("AC2 — content has exactly MODEL_MAX_LINES lines: header, file lines 1..998, cap footer", async () => {
    const path = join(root, "fifteen.txt");
    // 1500 short lines. Well under ctx.maxBytes = 100_000 — the byte cap is
    // not the binding constraint here; the line cap is.
    writeFileSync(path, Array.from({ length: 1500 }, () => "x").join("\n"));
    const res = await readTool.run({ path: "fifteen.txt" }, ctx([path], 100_000));
    expect(res.isError).toBeFalsy();
    const lines = res.content.split("\n");
    expect(lines).toHaveLength(MODEL_MAX_LINES);
    expect(lines[0]).toBe("[1500 lines]");
    // Body is exactly file lines 1..998 — `x` for each.
    expect(lines.slice(1, MODEL_MAX_LINES - 1)).toEqual(Array.from({ length: MODEL_MAX_LINES - 2 }, () => "x"));
    expect(lines.at(-1)).toBe(
      `[Showing lines 1-${MODEL_MAX_LINES - 2} of 1500. Use offset=${MODEL_MAX_LINES - 1} to continue.]`,
    );
  });
});

// -----------------------------------------------------------------------------
// AC3 — 200-line file, every line 399 `x` chars, ctx.maxBytes 40000 cuts
//       to keep the largest whole-line count; cap footer reports 1-99.
// -----------------------------------------------------------------------------
describe("AC3: 200-line file with 399-char lines and maxBytes 40000 cuts at the byte ceiling", () => {
  test("AC3 — last content line is the cap footer reporting 1-99 of 200", async () => {
    const path = join(root, "dense.txt");
    writeFileSync(path, Array.from({ length: 200 }, () => "x".repeat(399)).join("\n"));
    const res = await readTool.run({ path: "dense.txt" }, ctx([path], MODEL_MAX_BYTES));
    expect(res.isError).toBeFalsy();
    const lines = res.content.split("\n");
    expect(lines.at(-1)).toBe("[Showing lines 1-99 of 200. Use offset=100 to continue.]");
  });
});

// -----------------------------------------------------------------------------
// AC4 — body lines of that same result are exactly file lines 1..99, each
//       complete (no truncation of the line content itself).
// -----------------------------------------------------------------------------
describe("AC4: body of the 200-line 399-char file is exactly file lines 1..99", () => {
  test("AC4 — body lines are exactly the file's first 99 whole lines", async () => {
    const path = join(root, "dense.txt");
    writeFileSync(path, Array.from({ length: 200 }, () => "x".repeat(399)).join("\n"));
    const res = await readTool.run({ path: "dense.txt" }, ctx([path], MODEL_MAX_BYTES));
    expect(res.isError).toBeFalsy();
    const lines = res.content.split("\n");
    const body = lines.slice(1, -1);
    expect(body).toEqual(Array.from({ length: 99 }, () => "x".repeat(399)));
  });
});

// -----------------------------------------------------------------------------
// AC5 — UTF-8 byte length is at most 40000; 100 file lines would exceed it.
// -----------------------------------------------------------------------------
describe("AC5: the cut keeps the largest whole-line count that fits the byte ceiling", () => {
  test("AC5 — result UTF-8 byte length <= 40000; adding the 100th file line would push it past", async () => {
    const path = join(root, "dense.txt");
    writeFileSync(path, Array.from({ length: 200 }, () => "x".repeat(399)).join("\n"));
    const res = await readTool.run({ path: "dense.txt" }, ctx([path], MODEL_MAX_BYTES));
    expect(res.isError).toBeFalsy();
    // Body must fit ctx.maxBytes (the byte budget, header and footer included).
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);

    // Construct the "with 100 file lines" candidate. We compose it the same
    // way the tool would: header, 100 lines, cap footer. This must exceed
    // MODEL_MAX_BYTES — that's what proves 99 was the largest k that fit.
    const header = "[200 lines]";
    const lineLen = 399;
    const withHundred =
      header +
      "\n" +
      Array.from({ length: 100 }, () => "x".repeat(lineLen)).join("\n") +
      "\n[Showing lines 1-100 of 200. Use offset=101 to continue.]";
    expect(Buffer.byteLength(withHundred, "utf8")).toBeGreaterThan(MODEL_MAX_BYTES);
  });
});

// -----------------------------------------------------------------------------
// AC6 — ranged read on a 1500-line file with offset=100 limit=1200 carries
//       the unchanged requested-range header and a cap footer (no limit-stop
//       footer) when the candidate overflows the line cap.
// -----------------------------------------------------------------------------
describe("AC6: ranged offset=100 limit=1200 on a 1500-line short-line file cuts at the line cap", () => {
  test("AC6 — first line is the requested-range header; last line is the cap footer; no limit-stop footer", async () => {
    const path = join(root, "fifteen.txt");
    writeFileSync(path, Array.from({ length: 1500 }, () => "x").join("\n"));
    const res = await readTool.run({ path: "fifteen.txt", offset: 100, limit: 1200 }, ctx([path], 100_000));
    expect(res.isError).toBeFalsy();
    const lines = res.content.split("\n");
    expect(lines[0]).toBe("[lines 100-1299 of 1500]");
    // The cap footer here: a = 100, b = 1097 (100 + MODEL_MAX_LINES - 3 - 1),
    // see the cap algorithm: 1 header + k lines + 1 cap footer = MODEL_MAX_LINES,
    // so k = MODEL_MAX_LINES - 2, b = 100 + (MODEL_MAX_LINES - 2) - 1 = 1097.
    expect(lines.at(-1)).toBe("[Showing lines 100-1097 of 1500. Use offset=1098 to continue.]");
    // No limit-stop footer — the cap footer replaces it.
    expect(lines.filter((l) => l.includes("more lines in file"))).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// AC7 — a cut result does not end with a newline character.
// -----------------------------------------------------------------------------
describe("AC7: cut results do not end with a trailing newline", () => {
  test("AC7 — the 1500-line whole-file read result does not end with \\n", async () => {
    const path = join(root, "fifteen.txt");
    writeFileSync(path, Array.from({ length: 1500 }, () => "x").join("\n"));
    const res = await readTool.run({ path: "fifteen.txt" }, ctx([path], 100_000));
    expect(res.isError).toBeFalsy();
    expect(res.content.endsWith("\n")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// AC8 — readCeiling 500, maxBytes 300, 30-line file of 99 `x` chars each.
//       The whole-file prefix hits the readCeiling so total is a floor
//       (6+). The cap footer reports 1-2 of 6+.
// -----------------------------------------------------------------------------
describe("AC8: readCeiling floor total combined with a tight byte cap", () => {
  test("AC8 — header is [6+ lines] and cap footer reports 1-2 of 6+", async () => {
    const path = join(root, "floor.txt");
    const line = "x".repeat(99);
    writeFileSync(path, Array.from({ length: 30 }, () => line).join("\n"));
    // Each line is 99 chars, plus the joining \n = 99 + 1 = 100 bytes per line.
    // Six lines = 600 bytes; five lines + newline = 500 bytes (readCeiling hit).
    // ctx.maxBytes = 300 forces the byte cap to bind: header (~12 bytes) + 99
    // + 99 (two lines, with \n between) + footer (~50 bytes) is roughly within
    // budget, while three lines would not fit.
    const res = await readTool.run({ path: "floor.txt" }, ctx([path], 300, { readCeiling: 500 }));
    expect(res.isError).toBeFalsy();
    const lines = res.content.split("\n");
    expect(lines[0]).toBe("[6+ lines]");
    expect(lines.at(-1)).toBe("[Showing lines 1-2 of 6+. Use offset=3 to continue.]");
  });
});

// -----------------------------------------------------------------------------
// AC9 — one-line file, 256 `r` chars, ctx.maxBytes 32. No line fits with the
//       header and cap footer, so the result is returned unshaped — header,
//       newline, the 256 chars, no cap footer.
// -----------------------------------------------------------------------------
describe("AC9: when no k >= 1 fits, the candidate is returned unshaped with no cap footer", () => {
  test("AC9 — one-line file, ctx.maxBytes 32: header, newline, 256 chars, no cap footer", async () => {
    const path = join(root, "long.txt");
    writeFileSync(path, "r".repeat(256));
    const res = await readTool.run({ path: "long.txt" }, ctx([path], 32));
    expect(res.isError).toBeFalsy();
    // Exactly: `[1 lines]\n` + 256 `r`s. No cap footer because no k >= 1
    // fits within the budget (header + 1 line + cap footer > 32 bytes).
    expect(res.content).toBe("[1 lines]\n" + "r".repeat(256));
    expect(res.content.endsWith("\n")).toBe(false);
    // The unshaped body keeps today's bytes exactly — the cap footer is
    // present in neither the cut nor the uncut form here.
    expect(res.content).not.toContain("Showing lines");
  });
});

// -----------------------------------------------------------------------------
// AC10 — 50-line file fitting both caps returns the [50 lines] header plus
//        the file's exact bytes, trailing newline included.
// -----------------------------------------------------------------------------
describe("AC10: a 50-line file fitting both caps is returned verbatim", () => {
  test("AC10 — 50-line file: [50 lines] header plus the file's exact bytes", async () => {
    const path = join(root, "fifty.txt");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    const res = await readTool.run({ path: "fifty.txt" }, ctx([path], 100_000));
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(`[50 lines]\n${lines.join("\n")}\n`);
    expect(res.content.endsWith("\n")).toBe(true);
    // No cap footer on a within-cap result.
    expect(res.content).not.toContain("Showing lines");
  });

  test("AC10 boundary — a 999-line file (one below MODEL_MAX_LINES) with a trailing newline is returned verbatim", async () => {
    // Adversarial finding #1: the fit check previously used a raw split("\n")
    // which counts the trailing newline as a phantom line. A 999-line file
    // produces 1001 raw lines (header + 999 body + empty trailing), which
    // exceeded MODEL_MAX_LINES = 1000 and wrongly triggered the cap cut. The
    // fix is to count with `splitModelLines`, which agrees with the after_tool
    // policy's line count. Header + 999 body lines = 1000 lines total, well
    // within MODEL_MAX_LINES.
    const path = join(root, "nine-ninety-nine.txt");
    const lines = Array.from({ length: 999 }, (_, i) => `line ${i + 1}`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    const res = await readTool.run({ path: "nine-ninety-nine.txt" }, ctx([path], 100_000));
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe(`[999 lines]\n${lines.join("\n")}\n`);
    expect(res.content.endsWith("\n")).toBe(true);
    // No cap footer — the result fits within every cap.
    expect(res.content).not.toContain("Showing lines");
  });
});

// -----------------------------------------------------------------------------
// AC11-AC13 — built-in runtime Read call on a 1500-line file exercises the
//       cap-footer path AND the spill seam: the runtime returns the cap
//       footer (no runtime marker), no spill file is written, and the
//       after_tool policy is a no-op on the within-cap result.
// -----------------------------------------------------------------------------
describe("AC11-AC13: built-in runtime Read on a 1500-line file cuts at the cap footer and does not spill", () => {
  test("AC11 — runtime callTool('Read', { path }) on a 1500-line file returns the cap footer and no runtime marker", async () => {
    registerBuiltinCodingTools();
    const path = join(root, "fifteen.txt");
    writeFileSync(path, Array.from({ length: 1500 }, () => "x").join("\n"));
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
    });
    rt.advertised(["Read"]);
    const outcome = await rt.callTool("Read", { path: "fifteen.txt" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    const lines = outcome.content.split("\n");
    expect(lines.at(-1)).toBe("[Showing lines 1-998 of 1500. Use offset=999 to continue.]");
    // The runtime's own `[truncated:` marker must NOT appear on a result
    // already capped at the whole-line boundary by the tool.
    expect(outcome.content).not.toContain("... [truncated:");
  });

  test("AC12 — no spill file is written under the runtime's .nax/scratchpad/", async () => {
    registerBuiltinCodingTools();
    const path = join(root, "fifteen.txt");
    writeFileSync(path, Array.from({ length: 1500 }, () => "x").join("\n"));
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
    });
    rt.advertised(["Read"]);
    await rt.callTool("Read", { path: "fifteen.txt" });

    // The spill dir either does not exist or has no spill files for this call.
    const spillDir = join(root, SCRATCHPAD_DIR, SPILL_DIR);
    const present = existsSync(spillDir) ? readdirSync(spillDir) : [];
    const spillFiles = present.filter((name) => name.startsWith("Read-") && name.endsWith(".txt"));
    expect(spillFiles).toHaveLength(0);
  });

  test("AC13 — applyModelTruncationPolicy on the runtime's output returns it byte-identically", async () => {
    registerBuiltinCodingTools();
    const path = join(root, "fifteen.txt");
    writeFileSync(path, Array.from({ length: 1500 }, () => "x").join("\n"));
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
    });
    rt.advertised(["Read"]);
    const outcome = await rt.callTool("Read", { path: "fifteen.txt" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // The runtime's content already satisfies the within-cap contract for
    // applyModelTruncationPolicy: the result is at most MODEL_MAX_BYTES
    // bytes AND at most MODEL_MAX_LINES lines. Pass it back through the
    // after_tool policy with the same parameters and assert byte equality.
    const after = await applyModelTruncationPolicy(outcome.content, {
      toolName: "Read",
      callId: "c1",
      // No root: a second spill pass would only ever be triggered when the
      // input exceeded the cap, which it does not here.
      maxBytes: MODEL_MAX_BYTES,
    });
    expect(after).toBe(outcome.content);
  });
});

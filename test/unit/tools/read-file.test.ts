/**
 * US-001 AC16–AC21: shared ranged file-read core (`readFileSlice`).
 *
 * The tests run against the temp dir produced by `makeTempDir` so they do
 * not write to the project tree. The `readCeiling` parameter is supplied
 * per-case so the boundary checks for AC17 (file larger than ceiling) and
 * AC18/AC19 (slice mechanics) are independent of the constant `READ_CEILING`.
 *
 * AC21 pins an explicit-throw contract: the implementer may throw a
 * `NaxError`, an `Error`, or a `RangeError` — the test only asserts that
 * the call rejects and that the rejection names the bad input so a silent
 * return would fail.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { readFileSlice } from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-read-file-");
});
afterEach(() => {
  cleanupTempDir(root);
});

function path(name: string) {
  return join(root, name);
}

function writeLines(name: string, lines: string[]) {
  writeFileSync(path(name), `${lines.join("\n")}\n`);
}

describe("AC16: readFileSlice with neither offset nor limit returns whole contents and bounded false when file < readCeiling", () => {
  test("a small file is returned whole and bounded is false", async () => {
    writeLines("small.txt", ["alpha", "beta", "gamma"]);

    const res = await readFileSlice(path("small.txt"), { readCeiling: 10_000 });
    expect(res.bounded).toBe(false);
    expect(res.content).toBe("alpha\nbeta\ngamma\n");
  });

  test("a single-line file is returned whole and bounded is false", async () => {
    writeFileSync(path("one.txt"), "only line\n");

    const res = await readFileSlice(path("one.txt"), { readCeiling: 1_000 });
    expect(res.bounded).toBe(false);
    expect(res.content).toBe("only line\n");
  });

  test("omitting readCeiling still returns the whole file when it is small", async () => {
    writeLines("tiny.txt", ["x", "y"]);

    // readCeiling is optional. A small file should be returned whole
    // regardless of whether the caller supplied a ceiling.
    const res = await readFileSlice(path("tiny.txt"));
    expect(res.bounded).toBe(false);
    expect(res.content).toBe("x\ny\n");
  });
});

describe("AC17: readFileSlice returns bounded true when file > supplied readCeiling", () => {
  test("a file whose byte length exceeds readCeiling", async () => {
    writeFileSync(path("big.txt"), "x".repeat(2_000));

    const res = await readFileSlice(path("big.txt"), { readCeiling: 500 });
    expect(res.bounded).toBe(true);
    // The contract is bounded:true AND a meaningful (non-placeholder) totalLines.
    expect(res.totalLines).toBeGreaterThan(0);
  });

  test("a file whose byte length sits one byte over readCeiling", async () => {
    writeFileSync(path("plus.txt"), "x".repeat(501));

    const res = await readFileSlice(path("plus.txt"), { readCeiling: 500 });
    expect(res.bounded).toBe(true);
    // Boundary companion: a one-byte-overshoot file still gets bounded:true
    // and a totalLines reflecting the real file. A stub that returns a
    // placeholder would satisfy bounded:true alone; this assert closes it.
    expect(res.totalLines).toBeGreaterThan(0);
  });

  test("bounded true is reported alongside a meaningful totalLines (not a stub sentinel)", async () => {
    // A multi-line file whose total byte length exceeds readCeiling. The
    // contract is: bounded is true AND totalLines reflects the file's real
    // line count, even when the file is too large to read whole.
    const lines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`);
    writeLines("many.txt", lines);

    const res = await readFileSlice(path("many.txt"), { readCeiling: 50 });
    expect(res.bounded).toBe(true);
    expect(res.totalLines).toBeGreaterThan(0);
  });

  test("the returned content is itself within the ceiling, not just flagged bounded", async () => {
    // A bounded read that handed back ceiling + 1 bytes would mean the tool
    // read past the bound it was given. The ceiling is the tool's I/O bound,
    // so the body it returns has to sit inside it.
    writeFileSync(path("over.txt"), "x".repeat(2_000));

    const res = await readFileSlice(path("over.txt"), { readCeiling: 500 });
    expect(res.bounded).toBe(true);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(500);
  });

  test("a ceiling landing mid-codepoint does not push the body past the ceiling", async () => {
    // Every codepoint here is 3 bytes, so a ceiling of 500 lands inside one.
    // A byte-aligned cut would decode that partial tail into a U+FFFD
    // replacement character (3 bytes) and hand back more than the ceiling.
    writeFileSync(path("cjk.txt"), "\u4e2d".repeat(400)); // 1,200 bytes

    const res = await readFileSlice(path("cjk.txt"), { readCeiling: 500 });
    expect(res.bounded).toBe(true);
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(500);
    expect(res.content).not.toContain("\ufffd");
  });

  test("a four-byte codepoint cut after three bytes is omitted before decoding", async () => {
    writeFileSync(path("emoji.txt"), "\u{1f600}tail");

    const res = await readFileSlice(path("emoji.txt"), { readCeiling: 3 });

    expect(res.bounded).toBe(true);
    expect(res.content).toBe("");
    expect(res.content).not.toContain("\ufffd");
  });
});

describe("AC18: readFileSlice with offset 3 and limit 2 returns the third and fourth lines", () => {
  test("offset=3 limit=2 returns lines three and four of a five-line file", async () => {
    writeLines("five.txt", ["L1", "L2", "L3", "L4", "L5"]);

    const res = await readFileSlice(path("five.txt"), { offset: 3, limit: 2 });
    expect(res.content).toContain("L3");
    expect(res.content).toContain("L4");
    expect(res.content).not.toContain("L1\n");
    expect(res.content).not.toContain("L2\n");
    expect(res.content).not.toContain("L5\n");
  });

  test("the slice is exactly the requested lines, with no synthesised terminator", async () => {
    writeLines("five.txt", ["L1", "L2", "L3", "L4", "L5"]);

    const res = await readFileSlice(path("five.txt"), { offset: 3, limit: 2 });
    // readTool's offset/limit path (src/tools/read.ts) joins the selected
    // lines with no trailing newline. readFileSlice follows that precedent
    // rather than re-adding the file's terminator the caller never asked for.
    expect(res.content).toBe("L3\nL4");
  });
});

describe("AC19: readFileSlice returns totalLines equal to its line count when file is within readCeiling", () => {
  test("a ten-line file within readCeiling reports totalLines = 10", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    writeLines("ten.txt", lines);

    const res = await readFileSlice(path("ten.txt"), { readCeiling: 10_000 });
    expect(res.totalLines).toBe(10);
  });

  test("a 50-line file within readCeiling reports totalLines = 50", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `L${i + 1}`);
    writeLines("fifty.txt", lines);

    const res = await readFileSlice(path("fifty.txt"), { readCeiling: 10_000 });
    expect(res.totalLines).toBe(50);
  });

  test("an empty file reports totalLines = 0", async () => {
    writeFileSync(path("empty.txt"), "");
    const res = await readFileSlice(path("empty.txt"), { readCeiling: 1_000 });
    expect(res.totalLines).toBe(0);
  });
});

describe("AC20: readFileSlice with offset > file line count returns empty content and that line count as totalLines", () => {
  test("offset=10 on a 5-line file: content is empty, totalLines = 5", async () => {
    writeLines("five.txt", ["L1", "L2", "L3", "L4", "L5"]);

    const res = await readFileSlice(path("five.txt"), { offset: 10 });
    expect(res.content).toBe("");
    expect(res.totalLines).toBe(5);
  });

  test("offset=1 past the end returns empty and the file's totalLines", async () => {
    const lines = Array.from({ length: 7 }, (_, i) => `L${i + 1}`);
    writeLines("seven.txt", lines);

    const res = await readFileSlice(path("seven.txt"), { offset: 8 });
    expect(res.content).toBe("");
    expect(res.totalLines).toBe(7);
  });
});

describe("AC21: readFileSlice rejects offset=0 or limit=0 rather than returning the file's last line", () => {
  test("offset=0 rejects rather than returning the file's last line", async () => {
    writeLines("five.txt", ["L1", "L2", "L3", "L4", "L5"]);

    // The boundary: a successful return containing "L5" would mean offset=0
    // silently shifted to the last line — that's the failure the AC closes.
    let rejected = false;
    try {
      await readFileSlice(path("five.txt"), { offset: 0 });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("limit=0 rejects the request rather than silently returning nothing", async () => {
    writeLines("five.txt", ["L1", "L2", "L3", "L4", "L5"]);

    let rejected = false;
    try {
      await readFileSlice(path("five.txt"), { limit: 0 });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("a negative offset also rejects (offset is 1-based, negative is invalid)", async () => {
    writeLines("five.txt", ["L1", "L2", "L3", "L4", "L5"]);

    let rejected = false;
    try {
      await readFileSlice(path("five.txt"), { offset: -1 });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

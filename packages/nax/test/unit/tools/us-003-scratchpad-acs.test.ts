/**
 * US-003 — ScratchpadRead acceptance criteria (AC12, AC13, AC14, AC15).
 *
 * Companion to `test/unit/tools/us-003-acs.test.ts` (which covers AC1-AC11
 * for the spill/recovery pipeline). The four ACs here pin
 * ScratchpadRead's offset/limit paging, the `[N lines]` header, the offset-
 * past-end message, and the recovery-via-spill-paging path.
 *
 * Each AC has a dedicated describe block with a success-path test and a
 * boundary-path test, named after the AC they pin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { compileToolPolicy, createCodingToolRuntime, MODEL_MAX_BYTES, scratchpadReadTool } from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-us003-scratch-");
});

afterEach(() => {
  cleanupTempDir(root);
});

/** Stub Grep that returns a fixed body. The runtime shapes the result. */
function stubGrep(body: string) {
  return {
    name: "Grep",
    description: "stub",
    inputSchema: { type: "object" },
    scope: { pathFields: [] },
    async run() {
      return { content: body };
    },
  };
}

/** A scratchpad file fixture. Writes to `<root>/.nax/scratchpad/<name>`. */
function writeScratchFile(name: string, contents: string): string {
  const filePath = join(root, ".nax", "scratchpad", name);
  mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
  writeFileSync(filePath, contents);
  return filePath;
}

// -----------------------------------------------------------------------------
// AC12 — ScratchpadRead offset=3, limit=2 -> returns the 3rd and 4th lines.
// -----------------------------------------------------------------------------

describe("AC12: ScratchpadRead offset=3, limit=2 -> returns 3rd and 4th lines only", () => {
  test("AC12 success: offset=3, limit=2 returns lines L3 and L4 and nothing else", async () => {
    const filePath = writeScratchFile("page.md", "L1\nL2\nL3\nL4\nL5\n");

    const result = await scratchpadReadTool.run(
      { path: "page.md", offset: 3, limit: 2 },
      {
        root,
        resolvedPaths: [filePath],
        maxBytes: 10_000,
        maxFileBytes: 10_000_000,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("L3");
    expect(result.content).toContain("L4");
    expect(result.content).not.toContain("L1\n");
    expect(result.content).not.toContain("L2\n");
    expect(result.content).not.toContain("L5\n");
  });

  test("AC12 boundary: offset only (no limit) reads from offset to end of file", async () => {
    const filePath = writeScratchFile("tail.md", "L1\nL2\nL3\nL4\nL5\n");

    const result = await scratchpadReadTool.run(
      { path: "tail.md", offset: 4 },
      {
        root,
        resolvedPaths: [filePath],
        maxBytes: 10_000,
        maxFileBytes: 10_000_000,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("L4");
    expect(result.content).toContain("L5");
    expect(result.content).not.toContain("L3\n");
  });
});

// -----------------------------------------------------------------------------
// AC13 — ScratchpadRead content begins with a `[N lines]` header.
// -----------------------------------------------------------------------------

describe("AC13: ScratchpadRead content begins with a [N lines] header", () => {
  test("AC13 success: a 50-line file read without offset/limit starts with [50 lines]", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const filePath = writeScratchFile("fifty.md", `${lines.join("\n")}\n`);

    const result = await scratchpadReadTool.run(
      { path: "fifty.md" },
      {
        root,
        resolvedPaths: [filePath],
        maxBytes: 10_000,
        maxFileBytes: 10_000_000,
      },
    );
    expect(result.isError).toBeFalsy();
    // The FIRST content line is `[50 lines]`.
    const firstLine = result.content.split("\n")[0];
    expect(firstLine).toBe("[50 lines]");
  });

  test("AC13 boundary: an empty file returns [0 lines] and is not an error", async () => {
    const filePath = writeScratchFile("empty.md", "");

    const result = await scratchpadReadTool.run(
      { path: "empty.md" },
      {
        root,
        resolvedPaths: [filePath],
        maxBytes: 10_000,
        maxFileBytes: 10_000_000,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("[0 lines]");
  });
});

// -----------------------------------------------------------------------------
// AC14 — ScratchpadRead offset past last line -> message naming total line count.
// -----------------------------------------------------------------------------

describe("AC14: ScratchpadRead offset past last line -> message naming total line count", () => {
  test("AC14 success: offset past end of a 5-line file names the line count 5", async () => {
    const filePath = writeScratchFile("five.md", "L1\nL2\nL3\nL4\nL5\n");

    const result = await scratchpadReadTool.run(
      { path: "five.md", offset: 999 },
      {
        root,
        resolvedPaths: [filePath],
        maxBytes: 10_000,
        maxFileBytes: 10_000_000,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).not.toBe("");
    expect(result.content).toContain("5");
  });

  test("AC14 boundary: offset exactly one past the last line is a non-error naming the line count", async () => {
    const filePath = writeScratchFile("seven.md", "L1\nL2\nL3\nL4\nL5\nL6\nL7\n");

    const result = await scratchpadReadTool.run(
      { path: "seven.md", offset: 8 },
      {
        root,
        resolvedPaths: [filePath],
        maxBytes: 10_000,
        maxFileBytes: 10_000_000,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("7");
  });
});

// -----------------------------------------------------------------------------
// AC15 — Successive ScratchpadRead offsets read a spilled body > MODEL_MAX_BYTES
//        -> the whole body is recoverable.
// -----------------------------------------------------------------------------

describe("AC15: successive ScratchpadRead offsets read a spilled body > MODEL_MAX_BYTES -> whole body recoverable", () => {
  test("AC15 success: paging through a spill file with offset/limit recovers the body", async () => {
    // Seed a spill through the runtime: a Grep call whose body exceeds
    // MODEL_MAX_BYTES triggers the chokepoint, which spills the untruncated
    // body and names it in the marker. We then page through the spill.
    // Use a wide line so 100 lines clear MODEL_MAX_BYTES.
    const totalLines = 100;
    const firstLine = "FIRST-MARKER-LINE";
    const lastLine = "LAST-MARKER-LINE";
    const wideLine = "mid".padEnd(2000, "x");
    const lines = [firstLine, ...Array.from({ length: totalLines - 2 }, () => wideLine), lastLine];
    const body = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MODEL_MAX_BYTES);

    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(body)],
    });
    rt.advertised(["Grep"]);
    await rt.callTool("Grep", { pattern: "x" });

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    if (!existsSync(spillDir)) throw new Error("spill directory missing");
    const spillFile = readdirSync(spillDir).find((f) => f.startsWith("Grep-") && f.endsWith(".txt"));
    if (spillFile === undefined) throw new Error("spill file missing");
    const filePath = join(spillDir, spillFile);
    const relativePath = `spill/${spillFile}`;

    // Page through 20 lines at a time.
    const pageLimit = 20;
    const pages: string[] = [];
    for (let offset = 1; offset <= totalLines; offset += pageLimit) {
      const r = await scratchpadReadTool.run(
        { path: relativePath, offset, limit: pageLimit },
        {
          root,
          resolvedPaths: [filePath],
          maxBytes: 10_000,
          maxFileBytes: 10_000_000,
        },
      );
      expect(r.isError).toBeFalsy();
      pages.push(r.content);
    }
    const recovered = pages.join("\n");
    expect(recovered).toContain(firstLine);
    expect(recovered).toContain(lastLine);
  });

  test("AC15 boundary: a body smaller than MODEL_MAX_BYTES needs no paging and is returned under the line header", async () => {
    const filePath = writeScratchFile("small.md", "alpha\nbeta\ngamma\ndelta\n");

    const result = await scratchpadReadTool.run(
      { path: "small.md" },
      {
        root,
        resolvedPaths: [filePath],
        maxBytes: 10_000,
        maxFileBytes: 10_000_000,
      },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("alpha");
    expect(result.content).toContain("beta");
    expect(result.content).toContain("gamma");
    expect(result.content).toContain("delta");
  });
});

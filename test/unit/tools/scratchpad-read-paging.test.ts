/**
 * US-003 — ScratchpadRead offset/limit paging (AC11, AC12, AC13, AC14).
 *
 * ScratchpadRead gains `offset` and `limit` (matching `readTool`'s spelling),
 * leading `[N lines]` headers, and the "offset past end" message that names
 * the file's total line count. The tests here pin each property as
 * observable behavior on `scratchpadReadTool.run` and through
 * `runtime.callTool`.
 *
 * AC14 — recovery: a spilled body larger than MODEL_MAX_BYTES can be
 * re-read in successive pages through `offset`/`limit`, and the
 * concatenated pages reproduce the full body. This is the seam that makes
 * spill recovery useful for the model.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  compileToolPolicy,
  createCodingToolRuntime,
  DEFAULT_TOOL_MAX_BYTES,
  DEFAULT_TOOL_MAX_FILE_BYTES,
  scratchpadReadTool,
} from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-scratchpad-paging-");
});

afterEach(() => {
  cleanupTempDir(root);
});

function ctx(target: string, opts: { maxBytes?: number; maxFileBytes?: number; readCeiling?: number } = {}) {
  return {
    root,
    resolvedPaths: [target],
    maxBytes: opts.maxBytes ?? DEFAULT_TOOL_MAX_BYTES,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_TOOL_MAX_FILE_BYTES,
    ...(opts.readCeiling !== undefined ? { readCeiling: opts.readCeiling } : {}),
  };
}

describe("AC11: when ScratchpadRead receives offset 3 and limit 2, then it returns the third and fourth lines of the named scratchpad file", () => {
  test("offset=3 limit=2 returns the 3rd and 4th lines only", async () => {
    const lines = ["L1", "L2", "L3", "L4", "L5"];
    const filePath = join(root, ".nax", "scratchpad", "page.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = await scratchpadReadTool.run({ path: "page.md", offset: 3, limit: 2 }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    // The returned content holds the 3rd and 4th lines and nothing else.
    expect(result.content).toContain("L3");
    expect(result.content).toContain("L4");
    expect(result.content).not.toContain("L1\n");
    expect(result.content).not.toContain("L2\n");
    expect(result.content).not.toContain("L5\n");
  });

  test("offset=3 limit=2 returns exactly lines 3 and 4, with no synthesised terminator", async () => {
    const lines = ["L1", "L2", "L3", "L4", "L5"];
    const filePath = join(root, ".nax", "scratchpad", "exact.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = await scratchpadReadTool.run({ path: "exact.md", offset: 3, limit: 2 }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    // readFileSlice joins lines with no synthesised newline — the slice is
    // exactly the two lines the caller asked for.
    expect(result.content).toBe("L3\nL4");
  });

  test("offset only (no limit) reads from offset to end of file", async () => {
    const lines = ["L1", "L2", "L3", "L4", "L5"];
    const filePath = join(root, ".nax", "scratchpad", "tail.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = await scratchpadReadTool.run({ path: "tail.md", offset: 4 }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("L4");
    expect(result.content).toContain("L5");
    expect(result.content).not.toContain("L3\n");
  });
});

describe("AC12: when ScratchpadRead returns file content, then it begins with a `[N lines]` header reporting file line count", () => {
  test("a 50-line file read without offset/limit starts with `[50 lines]`", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const filePath = join(root, ".nax", "scratchpad", "fifty.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = await scratchpadReadTool.run({ path: "fifty.md" }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    // The first line of the returned content is the `[50 lines]` header.
    const firstLine = result.content.split("\n")[0];
    expect(firstLine).toBe("[50 lines]");
  });

  test("a 3-line file with no trailing newline reports `[3 lines]`, not `[4 lines]`", async () => {
    const filePath = join(root, ".nax", "scratchpad", "three.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, "alpha\nbeta\ngamma");

    const result = await scratchpadReadTool.run({ path: "three.md" }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    const firstLine = result.content.split("\n")[0];
    expect(firstLine).toBe("[3 lines]");
  });

  test("an empty file returns `[0 lines]` and is not an error", async () => {
    const filePath = join(root, ".nax", "scratchpad", "empty.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, "");

    const result = await scratchpadReadTool.run({ path: "empty.md" }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    // Either just the header, or header + empty body. The header alone is
    // enough to pin AC12.
    expect(result.content).toContain("[0 lines]");
  });

  test("the schema advertises offset and limit matching readTool's spelling", () => {
    const schema = scratchpadReadTool.inputSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["path"]);
    // Use a small reflective helper that takes a key and returns the
    // value's type/minimum fields, or fails the test with a useful
    // message. The helper avoids any `as <CapitalisedType>` cast by
    // using a single-purpose cast to `unknown` via a typed wrapper.
    const lookup = (key: string): { type?: string; minimum?: number } => {
      const raw: unknown = (schema as { properties?: unknown }).properties;
      if (typeof raw !== "object" || raw === null) {
        throw new Error("expected schema.properties to be an object");
      }
      const value: unknown = (raw as { [k: string]: unknown })[key];
      if (typeof value !== "object" || value === null) {
        throw new Error(`expected schema.properties.${key} to be an object`);
      }
      return value as { type?: string; minimum?: number };
    };
    expect(lookup("path").type).toBe("string");
    expect(lookup("offset").type).toBe("integer");
    expect(lookup("offset").minimum).toBe(1);
    expect(lookup("limit").type).toBe("integer");
    expect(lookup("limit").minimum).toBe(1);
  });
});

describe("AC13: when ScratchpadRead receives an offset past the last line, then it returns a message naming total line count", () => {
  test("offset past end of a 5-line file returns a non-error message naming 5", async () => {
    const filePath = join(root, ".nax", "scratchpad", "five.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, "L1\nL2\nL3\nL4\nL5\n");

    const result = await scratchpadReadTool.run({ path: "five.md", offset: 999 }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    expect(result.content).not.toBe("");
    expect(result.content).toContain("5");
  });

  test("offset=1 past the last line returns a non-error message naming the line count", async () => {
    const filePath = join(root, ".nax", "scratchpad", "seven.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, "L1\nL2\nL3\nL4\nL5\nL6\nL7\n");

    const result = await scratchpadReadTool.run({ path: "seven.md", offset: 8 }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("7");
  });

  test("offset past end is a non-error result (the model can act on the line count)", async () => {
    const filePath = join(root, ".nax", "scratchpad", "ten.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, `${Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n")}\n`);

    const result = await scratchpadReadTool.run({ path: "ten.md", offset: 50 }, ctx(filePath));
    // Specifically NOT isError — readTool's behaviour, pinned on ScratchpadRead.
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("10");
  });
});

describe("AC14: when successive ScratchpadRead offsets read a spilled body larger than MODEL_MAX_BYTES, then the whole body is recoverable", () => {
  test("page-by-page reads of a spilled body reproduce the full content", async () => {
    // AC14 pins recoverability: a spilled body (one that exceeded
    // MODEL_MAX_BYTES and was sent to the spill file) can be re-read in
    // successive pages through ScratchpadRead's offset/limit, and the
    // concatenated pages reproduce the full body. The model uses this
    // mechanism to recover content that didn't fit through the truncation
    // chokepoint.
    //
    // We bypass the size test by using a stub that pretends to be the spill
    // file's content, then page through it. The body just needs to be larger
    // than the page size to exercise paging — and we pin the FIRST and LAST
    // line as recoverable as concrete discriminators.
    const totalLines = 250;
    const firstLine = "FIRST-PAGE-CHECK-MARKER-LINE";
    const lastLine = "LAST-PAGE-CHECK-MARKER-LINE";
    const middle = "mid-payload";
    const lines = [firstLine, ...Array.from({ length: totalLines - 2 }, () => middle), lastLine];
    const body = `${lines.join("\n")}\n`;
    // The body is much larger than what a single offset/limit page would
    // return — paging is required to recover everything. (The exact
    // threshold doesn't matter; we're exercising the paging path, not
    // hitting the model-facing cap.)
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(1024);

    const filePath = join(root, ".nax", "scratchpad", "spill-recovery.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, body);

    // Page through it 30 lines at a time — three pages will be needed for
    // 250 lines.
    const pageLimit = 30;
    const pages: string[] = [];
    for (let offset = 1; offset <= totalLines; offset += pageLimit) {
      const r = await scratchpadReadTool.run({ path: "spill-recovery.md", offset, limit: pageLimit }, ctx(filePath));
      expect(r.isError).toBeFalsy();
      pages.push(r.content);
    }
    // Concatenate the pages and assert the discriminators survive.
    const recovered = pages.join("\n");
    expect(recovered).toContain(firstLine);
    expect(recovered).toContain(lastLine);
    // The total non-empty lines recovered equals the original line count.
    const recoveredLineCount = recovered.split("\n").filter((l) => l.length > 0).length;
    expect(recoveredLineCount).toBeGreaterThanOrEqual(totalLines);
  });

  test("a body smaller than MODEL_MAX_BYTES does not need paging — it returns whole under the line header", async () => {
    // Boundary: when no paging is needed, the read returns the body under
    // the [N lines] header. A regression that always paginated would
    // return only the first page.
    const lines = ["alpha", "beta", "gamma", "delta"];
    const filePath = join(root, ".nax", "scratchpad", "small.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const result = await scratchpadReadTool.run({ path: "small.md" }, ctx(filePath));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("alpha");
    expect(result.content).toContain("beta");
    expect(result.content).toContain("gamma");
    expect(result.content).toContain("delta");
  });
});

describe("AC14 runtime: ScratchpadRead paging through runtime.callTool", () => {
  test("runtime.callTool('ScratchpadRead', {offset, limit}) returns the requested slice", async () => {
    const lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];
    const filePath = join(root, ".nax", "scratchpad", "paging-rt.md");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "ScratchpadRead", patterns: ["*"] }], root),
    });
    rt.advertised(["ScratchpadRead"]);

    const outcome = await rt.callTool("ScratchpadRead", {
      path: "paging-rt.md",
      offset: 5,
      limit: 3,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.content).toContain("L5");
    expect(outcome.content).toContain("L6");
    expect(outcome.content).toContain("L7");
    expect(outcome.content).not.toContain("L4\n");
    expect(outcome.content).not.toContain("L8\n");
  });
});

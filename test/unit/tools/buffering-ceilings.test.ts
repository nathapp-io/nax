/**
 * Ceilings bound the WORK, not just the answer.
 *
 * `maxBytes` capped what a tool returned to the model, and every tool honoured
 * it — but `Read` loaded a whole file into a string before truncating it,
 * `Edit` did the same before replacing, `Write` had no cap at all, and the
 * subprocess tools buffered a command's entire stdout before trimming it. The
 * ceiling described the output while the memory was unbounded, so a large but
 * entirely permitted in-root file was enough to exhaust it. No traversal, no
 * escape, nothing the permission policy could see.
 *
 * Two ceilings, because they answer different questions: `maxBytes` is how much
 * the model may be told, `maxFileBytes` is how much file a tool will handle at
 * all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy, createCodingToolRuntime, DEFAULT_TOOL_MAX_FILE_BYTES } from "@/tools";
import { drainBounded, readPrefix } from "@/utils/bounded-io";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nax-ceiling-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runtime(maxFileBytes?: number) {
  return createCodingToolRuntime({
    policy: compileToolPolicy(
      [
        { tool: "Read", patterns: ["*"] },
        { tool: "Write", patterns: ["*"] },
        { tool: "Edit", patterns: ["*"] },
      ],
      root,
    ),
    maxBytes: 100,
    ...(maxFileBytes !== undefined ? { maxFileBytes } : {}),
  });
}

describe("readPrefix — reads no more than the ceiling", () => {
  test("stops at the ceiling instead of loading the whole file", async () => {
    const path = join(root, "big.txt");
    writeFileSync(path, "x".repeat(50_000));

    const prefix = await readPrefix(path, 100);

    // 101, not 50,000: one byte past the ceiling is all that is needed to know
    // truncation is required.
    expect(prefix.length).toBe(101);
    expect(statSync(path).size).toBe(50_000);
  });

  test("returns a short file whole", async () => {
    const path = join(root, "small.txt");
    writeFileSync(path, "hello");

    expect(await readPrefix(path, 100)).toBe("hello");
  });
});

describe("drainBounded — stops consuming a stream at the ceiling", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i >= chunks.length) return controller.close();
        controller.enqueue(encoder.encode(chunks[i] ?? ""));
        i += 1;
      },
    });
  }

  test("stops once the ceiling is passed rather than draining to the end", async () => {
    let pulled = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) return controller.close();
        controller.enqueue(encoder.encode("y".repeat(100)));
      },
    });

    const out = await drainBounded(stream, 250);

    expect(out.length).toBeLessThanOrEqual(350);
    // Would be 1000 if it drained the whole stream.
    expect(pulled).toBeLessThan(10);
  });

  test("returns a short stream whole", async () => {
    expect(await drainBounded(streamOf(["ab", "cd"]), 100)).toBe("abcd");
  });
});

describe("Read — bounded by the output ceiling", () => {
  test("truncates a large file and says so", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(50_000));

    const outcome = await runtime().callTool("Read", { path: "big.txt" });

    expect(outcome.kind).toBe("ok");
    expect(outcome.kind === "ok" && outcome.content).toContain("truncated");
    expect(outcome.kind === "ok" && outcome.content.length).toBeLessThan(500);
  });
});

describe("Write and Edit — bounded by the file ceiling", () => {
  test("Write refuses content past the file ceiling", async () => {
    const outcome = await runtime(1_000).callTool("Write", { path: "out.txt", content: "x".repeat(2_000) });

    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.content).toContain("exceeds");
  });

  test("Write still accepts content under the ceiling", async () => {
    const outcome = await runtime(1_000).callTool("Write", { path: "out.txt", content: "x".repeat(500) });

    expect(outcome.kind).toBe("ok");
  });

  test("Edit refuses a file past the ceiling instead of loading it", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(2_000));

    const outcome = await runtime(1_000).callTool("Edit", {
      path: "big.txt",
      old_string: "x",
      new_string: "y",
    });

    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.content).toContain("exceeds");
  });

  test("Edit still works on a file under the ceiling", async () => {
    writeFileSync(join(root, "ok.txt"), "alpha beta");

    const outcome = await runtime(1_000).callTool("Edit", {
      path: "ok.txt",
      old_string: "beta",
      new_string: "gamma",
    });

    expect(outcome.kind).toBe("ok");
  });

  test("a default ceiling exists, so an unconfigured runtime is still bounded", () => {
    expect(DEFAULT_TOOL_MAX_FILE_BYTES).toBeGreaterThan(0);
  });
});

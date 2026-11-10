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
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainBounded, readPrefix } from "#src/internal/bounded-io";
import { compileToolPolicy, createCodingToolRuntime, DEFAULT_TOOL_MAX_FILE_BYTES, readTool } from "#src/tools/index";
import { assertNaxError, isConfinedTestRun } from "#test/helpers/index";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nax-ceiling-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readContext(path: string) {
  return {
    root,
    resolvedPaths: [path],
    maxBytes: 100,
    maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES,
  };
}

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

async function rejectedRead(path: string) {
  let caught: unknown;
  try {
    await readPrefix(path, 100);
  } catch (error) {
    caught = error;
  }
  assertNaxError(caught);
  return caught;
}

const hasMkfifo = Bun.which("mkfifo") !== null;

describe("readPrefix — reads no more than the ceiling", () => {
  test.skipIf(!hasMkfifo)(
    "rejects a FIFO without a writer within two seconds",
    async () => {
      const path = join(root, "pipe");
      execFileSync("mkfifo", [path]);

      const error = await rejectedRead(path);

      expect(error.code).toBe("READ_NOT_REGULAR_FILE");
      expect(error.message).toContain(path);
    },
    2_000,
  );

  test("rejects a directory as a non-regular file", async () => {
    const error = await rejectedRead(root);

    expect(error.code).toBe("READ_NOT_REGULAR_FILE");
    expect(error.context).toEqual({ stage: "read", path: root });
  });

  test.skipIf(!hasMkfifo)(
    "Read reports a FIFO error promptly",
    async () => {
      const path = join(root, "read-pipe");
      execFileSync("mkfifo", [path]);

      const result = await readTool.run({ path: "read-pipe" }, readContext(path));

      expect(result.isError).toBe(true);
      expect(result.content).toContain("is not a regular file");
    },
    2_000,
  );

  test("reads the first 101 bytes from a regular 500-byte file", async () => {
    const path = join(root, "five-hundred.txt");
    const contents = "x".repeat(500);
    writeFileSync(path, contents);

    expect(await readPrefix(path, 100)).toBe(contents.slice(0, 101));
  });

  test("follows a symlink to a regular file", async () => {
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    writeFileSync(target, "symlink target contents");
    symlinkSync(target, link);

    expect(await readPrefix(link, 100)).toBe("symlink target contents");
  });

  // The confined sandbox denies listen() on a Unix socket (EPERM); the unconfined run covers this case.
  test.skipIf(process.platform === "win32" || isConfinedTestRun())(
    "rejects a Unix socket as a non-regular file",
    async () => {
      const path = join(root, "socket");
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });

      try {
        const error = await rejectedRead(path);
        expect(error.code).toBe("READ_NOT_REGULAR_FILE");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

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

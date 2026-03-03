import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getChangedSourceFiles } from "../../../src/verification/smart-runner";

// ---------------------------------------------------------------------------
// Helpers to mock Bun.spawn (used internally via the "bun" import alias)
// ---------------------------------------------------------------------------

function makeProc(stdout: string, exitCode: number) {
  return {
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}

describe("getChangedSourceFiles", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    (Bun as any).spawn = originalSpawn;
  });

  test("returns only .ts files under src/", async () => {
    const gitOutput = [
      "src/verification/smart-runner.ts",
      "src/utils/git.ts",
      "README.md",
      "src/index.js",
      "test/unit/foo.test.ts",
      "src/config/schema.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => makeProc(gitOutput, 0));

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual([
      "src/verification/smart-runner.ts",
      "src/utils/git.ts",
      "src/config/schema.ts",
    ]);
  });

  test("returns empty array when git exits with non-zero code", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => makeProc("", 128));

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual([]);
  });

  test("returns empty array when git throws (e.g. not a repo)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => {
      throw new Error("git not found");
    });

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual([]);
  });

  test("filters out non-.ts src files", async () => {
    const gitOutput = ["src/foo.js", "src/bar.tsx", "src/baz.ts"].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => makeProc(gitOutput, 0));

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual(["src/baz.ts"]);
  });

  test("returns empty array when no files changed", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => makeProc("", 0));

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual([]);
  });
});

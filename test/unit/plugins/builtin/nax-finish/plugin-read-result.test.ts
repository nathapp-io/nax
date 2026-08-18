import { afterEach, describe, expect, test } from "bun:test";
import { _naxFinishDeps, naxFinishPlugin } from "@/plugins";
import type { PostRunContext } from "@/plugins/types";
import { withTempDir } from "@test/helpers";

const action = naxFinishPlugin.extensions.postRunAction!;

// _naxFinishDeps is module-level state shared across every test file in this
// process — restore it after each test so a stub cannot leak sideways.
const origDeps = { ...(_naxFinishDeps as Record<string, unknown>) };
afterEach(() => {
  Object.assign(_naxFinishDeps, origDeps);
});
const baseCtx = (over: Partial<PostRunContext> = {}): PostRunContext =>
  ({
    runId: "r",
    feature: "x",
    workdir: "/repo",
    prdPath: "/repo/.nax/features/x/prd.json",
    branch: "feat/x",
    totalDurationMs: 1,
    totalCost: 0,
    storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    config: { finish: { autoFlow: { enabled: true } } },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    ...over,
  }) as unknown as PostRunContext;

describe("defaultReadResult (BUG-1: malformed result.json on disk)", () => {
  // origDeps.readResult is the real defaultReadResult — untouched here since this
  // block never assigns _naxFinishDeps.readResult itself.
  const readResult = origDeps.readResult as (resultPath: string) => Promise<unknown>;

  test("returns null (not a thrown parse error) for a truncated/malformed result file", async () => {
    await withTempDir(async (dir) => {
      const resultPath = `${dir}/run.result.json`;
      await Bun.write(resultPath, '{"feature": "x", "status": "opened"'); // truncated — missing closing brace
      await expect(readResult(resultPath)).resolves.toBeNull();
    });
  });

  test("still returns null when the file is missing", async () => {
    await withTempDir(async (dir) => {
      await expect(readResult(`${dir}/nonexistent.result.json`)).resolves.toBeNull();
    });
  });

  test("parses a well-formed result file normally", async () => {
    await withTempDir(async (dir) => {
      const resultPath = `${dir}/run.result.json`;
      await Bun.write(resultPath, JSON.stringify({ feature: "x", status: "opened" }));
      await expect(readResult(resultPath)).resolves.toEqual({ feature: "x", status: "opened" });
    });
  });

  test("a malformed result file is treated as 'no result file' end-to-end", async () => {
    await withTempDir(async (dir) => {
      const resultPath = `${dir}/run.result.json`;
      await Bun.write(resultPath, "not json at all");
      _naxFinishDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
      _naxFinishDeps.clearResult = async () => {};
      _naxFinishDeps.exists = async () => true;
      // finishResultPath is opaque to the action (it doesn't take resultPath as an
      // input), so point readResult straight at our temp file via a bound closure
      // over the real defaultReadResult, rather than relying on real path derivation.
      _naxFinishDeps.readResult = async () => readResult(resultPath) as never;
      const r = await action.execute(baseCtx());
      expect(r.success).toBe(false);
      expect(r.message).toContain("no result file");
    });
  });
});

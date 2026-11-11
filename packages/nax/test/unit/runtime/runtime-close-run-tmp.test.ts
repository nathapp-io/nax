import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeFakeRunMemory, makeNaxConfig, withTempDir } from "@test/helpers";
import { _runtimeTmpDeps, createRuntime } from "@/runtime";
import { _runTmpCloseDeps } from "@/runtime/run-tmp-close";

const savedRuntime = { ..._runtimeTmpDeps };
const savedClose = { ..._runTmpCloseDeps };
afterEach(() => {
  Object.assign(_runtimeTmpDeps, savedRuntime);
  Object.assign(_runTmpCloseDeps, savedClose);
});

describe("runtime temp teardown", () => {
  test.each([false, true])("closes once with dryRun=%s", async (dryRun) => {
    await withTempDir(async (dir) => {
      const close = mock(async () => {});
      _runtimeTmpDeps.closeRunTmp = close;
      const runtime = createRuntime(makeNaxConfig({ outputDir: dir }), dir, { dryRun });
      await runtime.close();
      await runtime.close();
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith({ runId: runtime.runId, dryRun });
    });
  });
  test("still cleans up if MCP close fails", async () => {
    await withTempDir(async (dir) => {
      const close = mock(async () => {});
      _runtimeTmpDeps.closeRunTmp = close;
      const runtime = createRuntime(makeNaxConfig({ outputDir: dir }), dir);
      runtime.mcpPool.close = async () => {
        throw new Error("MCP");
      };
      await expect(runtime.close()).rejects.toThrow("MCP");
      expect(close).toHaveBeenCalledWith({ runId: runtime.runId, dryRun: false });
    });
  });
  test("closes memory before temp cleanup", async () => {
    await withTempDir(async (dir) => {
      const order: string[] = [];
      const fake = makeFakeRunMemory({
        closing: async () => {
          order.push("memory");
        },
      });
      _runtimeTmpDeps.closeRunTmp = async () => {
        order.push("temp");
      };
      const runtime = createRuntime(makeNaxConfig({ outputDir: dir }), dir, { memory: fake.memory });
      await runtime.close();
      expect(order).toEqual(["memory", "temp"]);
    });
  });
  test("default wiring calls both leaf deps", async () => {
    await withTempDir(async (dir) => {
      const wipe = mock(async () => {});
      const sweep = mock(async (_opts: Parameters<typeof _runTmpCloseDeps.sweepStaleRunTmpRoots>[0]) => {});
      _runTmpCloseDeps.wipeRunTmp = wipe;
      _runTmpCloseDeps.sweepStaleRunTmpRoots = sweep;
      const runtime = createRuntime(makeNaxConfig({ outputDir: dir }), dir);
      await runtime.close();
      expect(wipe).toHaveBeenCalledWith(runtime.runId);
      expect(sweep.mock.calls[0]?.[0]).toMatchObject({ currentRunId: runtime.runId });
    });
  });
});

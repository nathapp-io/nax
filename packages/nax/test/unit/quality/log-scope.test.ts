import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn, withDebugSpy, withInfoSpy } from "@test/helpers";
import { runQualityQuietly } from "@/quality/log-scope";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";

let originalSpawn: typeof _qualityRunnerDeps.spawn;
beforeEach(() => {
  originalSpawn = _qualityRunnerDeps.spawn;
  _qualityRunnerDeps.spawn = makeSpawn(() => "ok").spawn;
});
afterEach(() => {
  _qualityRunnerDeps.spawn = originalSpawn;
});

const run = () => runQualityCommand({ commandName: "lint", command: "bun run lint", workdir: "/tmp/project" });

describe("runQualityQuietly (nax#2491 P7)", () => {
  test("inside the scope the Running/completed records go to debug, not info", async () => {
    await withInfoSpy(async (infoSpy) => {
      await withDebugSpy(async (debugSpy) => {
        await runQualityQuietly(run);
        expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(0);
        expect(debugSpy.mock.calls.filter((c) => c[0] === "quality").map((c) => c[1])).toEqual([
          "Running lint",
          "lint completed",
        ]);
      });
    });
  });

  test("outside the scope they stay at info", async () => {
    await withInfoSpy(async (infoSpy) => {
      await run();
      expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(2);
    });
  });

  test("the scope returns the wrapped result and ends with it", async () => {
    const result = await runQualityQuietly(run);
    expect(result.success).toBe(true);
    await withInfoSpy(async (infoSpy) => {
      await run();
      expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(2);
    });
  });
});

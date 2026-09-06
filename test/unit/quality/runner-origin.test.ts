/**
 * Unit tests for the `origin` discriminator on runQualityCommand.
 *
 * The quality runner has two callers with very different console semantics:
 *
 *  - the harness's own deterministic ops (lintCheckOp, typecheckCheckOp, the
 *    finish gates, `nax setup`), which run a gate once and whose outcome the
 *    operator must see; and
 *  - the agent's `RunCommand` coding tool (src/tools/run-command.ts), which is
 *    the agent's own iteration loop. On acpx that loop runs inside the spawned
 *    agent process and nax never observes it; on the native path it comes back
 *    through this runner. In one observed run 283 of 289 invocations (98%) were
 *    agent-tool calls, and a failing lint among them is normal TDD red, not a
 *    harness fault.
 *
 * So agent-tool records are demoted to debug: still written to the JSONL (the
 * file sink writes every level), filtered off the console by the formatter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn, withDebugSpy, withInfoSpy } from "@test/helpers";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";

describe("runQualityCommand — origin gating", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
    _qualityRunnerDeps.spawn = makeSpawn(() => "ok").spawn;
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
  });

  test("harness origin is the default and logs at info", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runQualityCommand({
        commandName: "lint",
        command: "bun run lint",
        workdir: "/tmp/project",
        storyId: "US-001",
      });

      const quality = infoSpy.mock.calls.filter((c) => c[0] === "quality");
      expect(quality.map((c) => c[1])).toEqual(["Running lint", "lint completed"]);
    });
  });

  test("explicit harness origin logs at info", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runQualityCommand({
        commandName: "typecheck",
        command: "bun run typecheck",
        workdir: "/tmp/project",
        origin: "harness",
      });

      expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(2);
    });
  });

  test("agent-tool origin emits no info records", async () => {
    await withInfoSpy(async (infoSpy) => {
      await runQualityCommand({
        commandName: "lint",
        command: "bun run lint",
        workdir: "/tmp/project",
        origin: "agent-tool",
      });

      expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(0);
    });
  });

  test("agent-tool origin still records both lines at debug", async () => {
    await withDebugSpy(async (debugSpy) => {
      await runQualityCommand({
        commandName: "testScoped",
        command: "bun test foo.test.ts",
        workdir: "/tmp/project",
        origin: "agent-tool",
      });

      const quality = debugSpy.mock.calls.filter((c) => c[0] === "quality");
      expect(quality.map((c) => c[1])).toEqual(["Running testScoped", "testScoped completed"]);
    });
  });

  test("agent-tool debug records keep their structured payload", async () => {
    await withDebugSpy(async (debugSpy) => {
      await runQualityCommand({
        commandName: "lint",
        command: "bun run lint",
        workdir: "/tmp/project",
        storyId: "US-007",
        origin: "agent-tool",
      });

      const completed = debugSpy.mock.calls.find((c) => c[1] === "lint completed");
      const data = completed?.[2] as Record<string, unknown>;
      expect(data.storyId).toBe("US-007");
      expect(data.commandName).toBe("lint");
      expect(data.exitCode).toBe(0);
    });
  });

  test("a failing agent-tool command is not promoted off debug", async () => {
    _qualityRunnerDeps.spawn = makeSpawn(() => ({ stdout: "", stderr: "boom", exitCode: 1 })).spawn;

    await withInfoSpy(async (infoSpy) => {
      const result = await runQualityCommand({
        commandName: "lint",
        command: "bun run lint",
        workdir: "/tmp/project",
        origin: "agent-tool",
      });

      expect(result.success).toBe(false);
      expect(infoSpy.mock.calls.filter((c) => c[0] === "quality")).toHaveLength(0);
    });
  });
});

// RE-ARCH: keep
import { beforeEach, describe, expect, test } from "bun:test";
import { makeDispatchContext, makePRD, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
import type { PipelineContext, PipelineStage } from "@/pipeline";
import { runPipeline } from "@/pipeline";

function makeCtx(): PipelineContext {
  return {
    config: DEFAULT_CONFIG,
    rootConfig: DEFAULT_CONFIG,
    prd: makePRD({ userStories: [] }),
    story: makeStory({ id: "US-001", title: "t", status: "pending", acceptanceCriteria: [] }),
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    projectDir: "/tmp",
    workdir: "/tmp",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  };
}

/**
 * A stage throw used to vanish: runPipeline caught it, returned a fail result,
 * and logged nothing. Callers that discard the result (the pre-run acceptance
 * pipeline did) then continued as though the stage had succeeded, so a failed
 * acceptance setup produced no diagnostic anywhere. See
 * docs/superpowers/specs/2026-09-02-plan-4-results.md.
 */
describe("runPipeline logs a stage throw", () => {
  let logCalls: LogEntry[];

  beforeEach(() => {
    resetLogger();
    logCalls = [];
    initLogger({ level: "silent" });
    addSink((entry) => logCalls.push(entry));
  });

  test("logs an error naming the stage and the cause when a stage throws", async () => {
    const stages: PipelineStage[] = [
      {
        name: "acceptance-setup",
        enabled: () => true,
        execute: async () => {
          throw new Error("Session unsupported: openSession");
        },
      },
    ];

    const result = await runPipeline(stages, makeCtx());

    expect(result.success).toBe(false);
    expect(result.stoppedAtStage).toBe("acceptance-setup");

    const errors = logCalls.filter((e) => e.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    const logged = errors.map((e) => `${e.message} ${JSON.stringify(e.data ?? {})}`).join("\n");
    expect(logged).toContain("acceptance-setup");
    expect(logged).toContain("Session unsupported: openSession");
  });

  test("does not log an error when a stage fails cleanly rather than throwing", async () => {
    const stages: PipelineStage[] = [
      {
        name: "clean-fail",
        enabled: () => true,
        execute: async () => ({ action: "fail", reason: "declined" }),
      },
    ];

    await runPipeline(stages, makeCtx());

    expect(logCalls.filter((e) => e.level === "error")).toHaveLength(0);
  });
});

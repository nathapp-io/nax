// RE-ARCH: keep
import { beforeEach, describe, expect, test } from "bun:test";
import { makeDispatchContext, makePRD, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { runPreRunPipeline } from "@/execution/pre-run";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
import type { PipelineStage } from "@/pipeline";

function deps() {
  return {
    ...makeDispatchContext(),
    config: DEFAULT_CONFIG,
    workdir: "/tmp",
    featureDir: "/tmp/.nax/features/f",
    hooks: { hooks: {} },
  };
}

const prd = () => makePRD({ userStories: [makeStory({ id: "US-001", title: "t", acceptanceCriteria: [] })] });

const stage = (name: string, result: import("@/pipeline").StageResult): PipelineStage => ({
  name,
  enabled: () => true,
  execute: async () => result,
});

/**
 * acceptanceSetupStage returns action:"skip" on a healthy outcome — "acceptance
 * tests already pass" — right after reporting passed:true. runPipeline reports
 * success:false for skip, fail, escalate AND pause, so keying an error log off
 * `!success` alone cries wolf on a routine success, which is exactly what
 * trains people to ignore the log this fix exists to add.
 */
describe("runPreRunPipeline outcome logging", () => {
  let logs: LogEntry[];
  beforeEach(() => {
    resetLogger();
    logs = [];
    initLogger({ level: "silent" });
    addSink((e) => logs.push(e));
  });

  const errors = () => logs.filter((e) => e.level === "error");
  const infos = () => logs.filter((e) => e.level === "info");

  test("a genuine failure logs an error naming the stage and reason", async () => {
    await runPreRunPipeline(deps(), prd(), undefined, [
      stage("acceptance-setup", { action: "fail", reason: "session unsupported" }),
    ]);

    expect(errors()).toHaveLength(1);
    const logged = `${errors()[0].message} ${JSON.stringify(errors()[0].data ?? {})}`;
    expect(logged).toContain("acceptance-setup");
    expect(logged).toContain("session unsupported");
  });

  test("an escalate also logs an error", async () => {
    await runPreRunPipeline(deps(), prd(), undefined, [
      stage("acceptance-setup", { action: "escalate", reason: "needs a higher tier" }),
    ]);

    expect(errors()).toHaveLength(1);
  });

  test("the deliberate 'tests already pass' skip does NOT log an error", async () => {
    await runPreRunPipeline(deps(), prd(), undefined, [
      stage("acceptance-setup", {
        action: "skip",
        reason: "[acceptance-setup] Acceptance tests already pass — they are not testing new behavior.",
      }),
    ]);

    expect(errors()).toHaveLength(0);
    expect(infos().some((e) => JSON.stringify(e.data ?? {}).includes("already pass"))).toBe(true);
  });

  test("a fully successful pipeline logs neither an error nor an outcome notice", async () => {
    await runPreRunPipeline(deps(), prd(), undefined, [stage("acceptance-setup", { action: "continue" })]);

    expect(errors()).toHaveLength(0);
    expect(infos().some((e) => e.message.includes("did not complete"))).toBe(false);
  });

  test("returns the context the stage mutated, so acceptanceTestPaths survives", async () => {
    const ctx = await runPreRunPipeline(deps(), prd(), undefined, [
      {
        name: "acceptance-setup",
        enabled: () => true,
        execute: async (c) => {
          c.acceptanceTestPaths = [{ testPath: "/tmp/.nax-acceptance.test.ts", packageDir: "/tmp" }];
          return { action: "continue" };
        },
      },
    ]);

    expect(ctx.acceptanceTestPaths).toEqual([{ testPath: "/tmp/.nax-acceptance.test.ts", packageDir: "/tmp" }]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  cleanupTempDir,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { type TestBaseline, writeRunBaseline } from "@/verification/test-baseline";
import { buildStoryEnv } from "@/workflow/stage-env";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

async function facts(baseline: TestBaseline) {
  const dir = makeTempDir("timeout-facts-");
  dirs.push(dir);
  const config = makeNaxConfig({ execution: { regressionGate: { timeoutSeconds: 120 } } });
  const runtime = makeMockRuntime({ config, workdir: dir });
  const ctx = makeTestContext({
    config,
    rootConfig: config,
    runtime,
    projectDir: dir,
    workdir: dir,
    storyGitRef: "base",
  });
  await writeRunBaseline(dir, ctx.prd.feature, baseline);
  const { env } = await buildStoryEnv(ctx, makeMockCallContext({ runtime }));
  assertDefined(env.steps.timeoutFacts, "timeoutFacts");
  return env.steps.timeoutFacts();
}

describe("buildStoryEnv timeout facts", () => {
  test("reads the run baseline timeout and configured limit", async () => {
    expect(await facts({ kind: "no-baseline", reason: "timeout", capturedAt: "now" })).toEqual({
      baselineTimedOut: true,
      limitSeconds: 120,
    });
  });
  test("a captured baseline is not a timeout", async () => {
    expect(await facts({ kind: "captured", source: "preflight", capturedAt: "now", entries: [] })).toEqual({
      baselineTimedOut: false,
      limitSeconds: 120,
    });
  });
});

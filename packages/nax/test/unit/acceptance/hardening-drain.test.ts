/**
 * The hardening pass must finish even when a process the acceptance command
 * started escapes the group and keeps the output pipe open.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSessionManager,
  makeSpawn,
  makeStory,
} from "@test/helpers";
import { _hardeningDeps, type HardeningContext, runHardeningPass } from "@/acceptance/hardening";

const CONFIG = makeNaxConfig({
  agent: { default: "claude" },
  acceptance: { model: "fast", hardening: { enabled: true } },
});

let saved: typeof _hardeningDeps;
beforeEach(() => {
  saved = { ..._hardeningDeps };
  _hardeningDeps.detectLanguage = mock(async () => undefined);
  _hardeningDeps.writeFile = mock(async () => {});
  _hardeningDeps.savePRD = mock(async () => {});
  _hardeningDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    if (op.name === "acceptance-refine") {
      return [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }];
    }
    return { testCode: 'test("AC-1", () => {})' };
  }) as typeof _hardeningDeps.callOp;
});
afterEach(() => {
  Object.assign(_hardeningDeps, saved);
});

describe("runHardeningPass — post-exit drain", () => {
  test("settles when the runner has exited but an orphan still holds stdout open", async () => {
    _hardeningDeps.drainTimeoutMs = 20;
    // exitCode 0 with a stdout that never closes: the escaped daemon still has the write end.
    // `stdoutStall` (test-kit FakeProcSpec) gives that stream without a cast.
    _hardeningDeps.spawn = makeSpawn(() => ({ exitCode: 0, stdoutStall: true })).spawn;
    const story = makeStory({ suggestedCriteria: ["edge case"], status: "passed", passes: true, attempts: 1 });
    const ctx: HardeningContext = {
      prd: makePRD({ userStories: [story] }),
      prdPath: "/tmp/prd.json",
      featureDir: "/tmp/features/test",
      workdir: "/tmp/workdir",
      config: CONFIG,
      agentManager: makeMockAgentManager(),
      sessionManager: makeSessionManager(),
      runtime: makeMockRuntime({ agentManager: makeMockAgentManager(), config: CONFIG }),
      abortSignal: new AbortController().signal,
    };

    // Before the fix this hangs past the 5 s per-test timeout. After it, exit 0 with no
    // failing AC is a pass, so the suggested criterion is promoted (same path as the
    // "promotes passing suggested criteria" test in hardening.test.ts).
    const result = await runHardeningPass(ctx);
    expect(result.promoted).toEqual(["edge case"]);
  });
});

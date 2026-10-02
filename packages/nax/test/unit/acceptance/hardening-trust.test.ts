/**
 * runHardeningPass — US-006 trust backstop.
 *
 * Split from hardening.test.ts (800-line test-file limit): these tests pin the
 * trust gate at the acceptance-command surface. They carry their own fixtures
 * and isolate the registry with useUntrustedRegistry, so the hardening
 * behaviour suites above stay independent of the trust state.
 */

import { describe, expect, mock, test } from "bun:test";
import { realOrRaw } from "@nathapp/nax-agent/internal";
import {
  cleanupTempDir,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSessionManager,
  makeSpawn,
  makeStory,
  makeTempDir,
  useUntrustedRegistry,
} from "@test/helpers";
import { _hardeningDeps, type HardeningContext, runHardeningPass } from "@/acceptance/hardening";
import type { NaxConfig } from "@/config";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TEST_CONFIG: NaxConfig = makeNaxConfig({
  agent: { default: "claude" },
  acceptance: {
    model: "fast",
    hardening: { enabled: true },
  },
});

function makeCtx(overrides: Partial<HardeningContext> = {}): HardeningContext {
  const agentManager = makeMockAgentManager();
  const runtimeAgentManager = makeMockAgentManager();
  return {
    prd: makePRD(),
    prdPath: "/tmp/prd.json",
    featureDir: "/tmp/features/test",
    workdir: "/tmp/workdir",
    config: TEST_CONFIG,
    agentManager,
    sessionManager: makeSessionManager(),
    runtime: makeMockRuntime({ agentManager: runtimeAgentManager, config: TEST_CONFIG }),
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function mockCallOp(refineReturn: object[], generateReturn: object): typeof _hardeningDeps.callOp {
  return mock(async (_ctx: unknown, op: { name: string }, _input: unknown) => {
    if (op.name === "acceptance-refine") return refineReturn;
    if (op.name === "acceptance-generate") return generateReturn;
    throw new Error(`Unexpected op: ${op.name}`);
  }) as typeof _hardeningDeps.callOp;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runHardeningPass — US-006 trust backstop", () => {
  useUntrustedRegistry();

  async function runUntrustedHardening(): Promise<{
    result: Awaited<ReturnType<typeof runHardeningPass>>;
    callOpCount: number;
    spawnCount: number;
  }> {
    const project = realOrRaw(makeTempDir("hardening-untrusted-"));
    const originalCallOp = _hardeningDeps.callOp;
    const originalSavePRD = _hardeningDeps.savePRD;
    const originalDetectLanguage = _hardeningDeps.detectLanguage;
    const originalSpawn = _hardeningDeps.spawn;
    let callOpCount = 0;
    const responder = mockCallOp(
      [{ original: "suggested criterion", refined: "suggested criterion", testable: true, storyId: "US-001" }],
      { testCode: 'test("AC-1", () => {})' },
    );
    const callOp: typeof _hardeningDeps.callOp = (...args) => {
      callOpCount += 1;
      return responder(...args);
    };
    const savePRD = mock(async () => {});
    const detectLanguage = mock(async () => undefined);
    const spawn = makeSpawn();
    try {
      _hardeningDeps.callOp = callOp;
      _hardeningDeps.savePRD = savePRD;
      _hardeningDeps.detectLanguage = detectLanguage;
      _hardeningDeps.spawn = spawn.spawn;
      const story = makeStory({ suggestedCriteria: ["suggested criterion"] });
      const ctx = makeCtx({ workdir: project, prd: makePRD({ userStories: [story] }) });
      const result = await runHardeningPass(ctx);
      return { result, callOpCount, spawnCount: spawn.calls.length };
    } finally {
      _hardeningDeps.callOp = originalCallOp;
      _hardeningDeps.savePRD = originalSavePRD;
      _hardeningDeps.detectLanguage = originalDetectLanguage;
      _hardeningDeps.spawn = originalSpawn;
      cleanupTempDir(project);
    }
  }

  test("US-006 AC6: untrusted hardening returns an empty result", async () => {
    const { result } = await runUntrustedHardening();
    expect(result).toEqual({ promoted: [], discarded: [] });
  });

  test("US-006 AC7: untrusted hardening does not call the LLM operation", async () => {
    const { callOpCount } = await runUntrustedHardening();
    expect(callOpCount).toBe(0);
  });

  test("US-006 AC8: untrusted hardening does not spawn acceptance tests", async () => {
    const { spawnCount } = await runUntrustedHardening();
    expect(spawnCount).toBe(0);
  });
});

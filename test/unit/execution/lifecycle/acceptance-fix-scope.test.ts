/**
 * #2201: the acceptance fix cycle dispatches acceptanceFixSourceOp /
 * acceptanceFixTestOp, both of which declare Bash, so the FixCycleContext it
 * runs under must carry the ask resolver and the command shadow — and the
 * wiring must be disposed once the cycle settles, including when it throws.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { CommandShadow } from "@/command-safety";
import {
  _acceptanceFixScopeDeps,
  type AcceptanceFixScopeSource,
  openAcceptanceFixScope,
} from "@/execution/lifecycle/acceptance-fix-scope";
import {
  _acceptanceFixCycleDeps,
  type AcceptanceLoopContext,
  runAcceptanceFixCycle,
} from "@/execution/lifecycle/acceptance-loop";
import type { FixCycleContext } from "@/findings";
import type { DispatchAskWiring, RunDispatchAskOptions } from "@/interaction";
import { InteractionChain } from "@/interaction";
import { headlessAskResolver } from "@/permissions";

function fakeWiring(withShadow = true): { wiring: DispatchAskWiring; disposed: () => number } {
  let disposed = 0;
  const shadow: CommandShadow = { observe: () => {}, settle: () => {}, drain: async () => {} };
  return {
    wiring: {
      askResolver: headlessAskResolver(),
      commandShadow: withShadow ? shadow : undefined,
      dispose: async () => void disposed++,
    },
    disposed: () => disposed,
  };
}

const PRD = makePRD({
  feature: "feat",
  userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002", workdir: "packages/api" })],
});

function makeSource(overrides: Partial<AcceptanceFixScopeSource> = {}): AcceptanceFixScopeSource {
  return {
    config: makeNaxConfig(),
    prd: PRD,
    workdir: "/tmp/acc-scope",
    feature: "feat",
    abortSignal: new AbortController().signal,
    agentManager: makeMockAgentManager(),
    ...overrides,
  };
}

let saved: typeof _acceptanceFixScopeDeps;
let savedCycle: typeof _acceptanceFixCycleDeps;
beforeEach(() => {
  saved = { ..._acceptanceFixScopeDeps };
  savedCycle = { ..._acceptanceFixCycleDeps };
});
afterEach(() => {
  Object.assign(_acceptanceFixScopeDeps, saved);
  Object.assign(_acceptanceFixCycleDeps, savedCycle);
});

describe("openAcceptanceFixScope", () => {
  test("the cycle context carries the wiring's resolver and shadow", async () => {
    const fake = fakeWiring();
    const built: RunDispatchAskOptions[] = [];
    _acceptanceFixScopeDeps.buildRunDispatchAskWiring = async (opts) => {
      built.push(opts);
      return fake.wiring;
    };
    const interactionChain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });
    const runtime = makeMockRuntime();

    const scope = await openAcceptanceFixScope(makeSource({ interactionChain }), runtime, "US-001", "/tmp/acc-scope");

    expect(scope.cycleCtx.askResolver).toBe(fake.wiring.askResolver);
    expect(scope.cycleCtx.commandShadow).toBe(fake.wiring.commandShadow);
    expect(built[0]).toMatchObject({
      interaction: interactionChain,
      storyId: "US-001",
      runId: runtime.runId,
      outputDir: runtime.outputDir,
      packageDirs: [undefined, "packages/api"],
    });
    await scope.dispose();
    expect(fake.disposed()).toBe(1);
  });

  test("no shadow configured: the context omits commandShadow but keeps the resolver", async () => {
    const fake = fakeWiring(false);
    _acceptanceFixScopeDeps.buildRunDispatchAskWiring = async () => fake.wiring;
    const scope = await openAcceptanceFixScope(makeSource(), makeMockRuntime(), "US-001", "/tmp/acc-scope");
    expect(scope.cycleCtx.askResolver).toBe(fake.wiring.askResolver);
    expect("commandShadow" in scope.cycleCtx).toBe(false);
  });

  test("with the real builder the resolver is present even without an interaction chain", async () => {
    const scope = await openAcceptanceFixScope(makeSource(), makeMockRuntime(), "US-001", "/tmp/acc-scope");
    expect(scope.cycleCtx.askResolver?.humanReachable).toBe(false);
    await scope.dispose();
  });
});

function makeLoopCtx(): AcceptanceLoopContext {
  const config = makeNaxConfig({ acceptance: { maxRetries: 1 } });
  const runtime = makeMockRuntime({ config });
  return {
    ...makeSource({ config }),
    prdPath: "/tmp/acc-scope/prd.json",
    hooks: { hooks: {} },
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 1,
    allStoryMetrics: [],
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    agentManager: makeMockAgentManager(),
    sessionManager: runtime.sessionManager,
    runtime,
  };
}

describe("runAcceptanceFixCycle — ask wiring lifetime", () => {
  const FAILURES = { failedACs: ["AC-1"], testOutput: "AC-1 failed" };
  const DIAGNOSIS = { verdict: "source_bug" as const, reasoning: "r", confidence: 0.9 };

  test("the fix cycle runs under the scope's context and the wiring is disposed afterwards", async () => {
    const fake = fakeWiring();
    _acceptanceFixScopeDeps.buildRunDispatchAskWiring = async () => fake.wiring;
    let seen: FixCycleContext | undefined;
    _acceptanceFixCycleDeps.runFixCycle = mock(async (_cycle, ctx) => {
      seen = ctx;
      expect(fake.disposed()).toBe(0); // live while the cycle dispatches
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const };
    });

    await runAcceptanceFixCycle(makeLoopCtx(), PRD, FAILURES, DIAGNOSIS, "/tmp/acc-scope/acc.test.ts");

    expect(seen?.askResolver).toBe(fake.wiring.askResolver);
    expect(seen?.commandShadow).toBe(fake.wiring.commandShadow);
    expect(fake.disposed()).toBe(1);
  });

  test("the wiring is disposed even when the fix cycle throws", async () => {
    const fake = fakeWiring();
    _acceptanceFixScopeDeps.buildRunDispatchAskWiring = async () => fake.wiring;
    _acceptanceFixCycleDeps.runFixCycle = mock(async () => {
      throw new Error("cycle blew up");
    });

    await expect(
      runAcceptanceFixCycle(makeLoopCtx(), PRD, FAILURES, DIAGNOSIS, "/tmp/acc-scope/acc.test.ts"),
    ).rejects.toThrow("cycle blew up");
    expect(fake.disposed()).toBe(1);
  });
});

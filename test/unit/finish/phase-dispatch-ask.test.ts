/**
 * #2201: the finish phase's CallContext dispatches finishFixOp, which declares
 * Bash, so it must carry the ask resolver and the command shadow; the wiring is
 * disposed when the phase ends, including when the machine throws.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestRuntime } from "@test/helpers";
import type { CommandShadow } from "@/command-safety";
import type { FinishContext, FinishOps, FinishPhaseContext } from "@/finish";
import { _finishPhaseDeps, runFinishPhase } from "@/finish";
import type { DispatchAskWiring, RunDispatchAskOptions } from "@/interaction";
import { InteractionChain } from "@/interaction";
import type { CallContext } from "@/operations";
import { headlessAskResolver } from "@/permissions";

function fakeWiring(): { wiring: DispatchAskWiring; disposed: () => number } {
  let disposed = 0;
  const shadow: CommandShadow = { observe: () => {}, settle: () => {}, drain: async () => {} };
  return {
    wiring: { askResolver: headlessAskResolver(), commandShadow: shadow, dispose: async () => void disposed++ },
    disposed: () => disposed,
  };
}

const PROCEED: FinishContext = {
  base: "origin/main",
  specPath: "spec.md",
  acceptanceStatus: "disabled",
  groups: [],
  testFileRegex: [],
  commitsAhead: 3,
  route: "proceed",
};

function makeCtx(overrides: Partial<FinishPhaseContext> = {}): FinishPhaseContext {
  return {
    runtime: makeTestRuntime(),
    config: { finish: { enabled: true, notify: { mode: "off" } } },
    feature: "f",
    workdir: "/tmp/finish-dispatch-ask",
    branch: "feat/x",
    runId: "run-9",
    agentName: "claude",
    abortSignal: new AbortController().signal,
    storySummary: { completed: 1, failed: 0, paused: 0 },
    packageDirs: [undefined, "packages/api"],
    ...overrides,
  };
}

let saved: typeof _finishPhaseDeps;
let seenCallCtx: CallContext | undefined;
beforeEach(() => {
  saved = { ..._finishPhaseDeps };
  seenCallCtx = undefined;
  _finishPhaseDeps.loadFinishContext = async () => PROCEED;
  _finishPhaseDeps.detectForge = async () => null;
  const realCreate = saved.createFinishOps;
  _finishPhaseDeps.createFinishOps = (deps): FinishOps => {
    seenCallCtx = deps.callCtx;
    return realCreate(deps);
  };
});
afterEach(() => {
  Object.assign(_finishPhaseDeps, saved);
});

describe("runFinishPhase — finish-fix ask wiring (#2201)", () => {
  test("the CallContext carries the resolver and shadow built from the run's inputs", async () => {
    const fake = fakeWiring();
    const built: RunDispatchAskOptions[] = [];
    _finishPhaseDeps.buildRunDispatchAskWiring = async (opts) => {
      built.push(opts);
      return fake.wiring;
    };
    _finishPhaseDeps.runFinishMachine = async () => {
      expect(fake.disposed()).toBe(0); // live while the machine dispatches
      return { feature: "f", status: "already-ready" };
    };
    const interactionChain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });
    const ctx = makeCtx({ interactionChain });

    await runFinishPhase(ctx);

    expect(seenCallCtx?.askResolver).toBe(fake.wiring.askResolver);
    expect(seenCallCtx?.commandShadow).toBe(fake.wiring.commandShadow);
    expect(built[0]).toMatchObject({
      interaction: interactionChain,
      runId: "run-9",
      outputDir: ctx.runtime.outputDir,
      repoRoot: "/tmp/finish-dispatch-ask",
      packageDirs: [undefined, "packages/api"],
    });
    expect(fake.disposed()).toBe(1);
  });

  test("the wiring is disposed when the machine throws (the phase fails open)", async () => {
    const fake = fakeWiring();
    _finishPhaseDeps.buildRunDispatchAskWiring = async () => fake.wiring;
    _finishPhaseDeps.runFinishMachine = async () => {
      throw new Error("machine blew up");
    };

    expect(await runFinishPhase(makeCtx())).toBeNull();
    expect(fake.disposed()).toBe(1);
  });

  test("with the real builder and no chain the resolver is present but unreachable", async () => {
    _finishPhaseDeps.runFinishMachine = async () => ({ feature: "f", status: "already-ready" });
    await runFinishPhase(makeCtx());
    expect(seenCallCtx?.askResolver?.humanReachable).toBe(false);
  });
});

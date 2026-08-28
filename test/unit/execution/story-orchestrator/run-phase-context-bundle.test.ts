/**
 * runPhase — per-stage context bundle override at the dispatch seam (nax#1737 Phase B).
 *
 * `runPhase` is the single dispatch point for the CANONICAL_ORDER phases AND
 * the rectification fix cycle (rectification.ts:325 `wrappedCallOp` calls it
 * too), so a per-phase bundle override belongs here and nowhere else.
 *
 * Mapped ops (contextStageForOp) get a bundle assembled for their own
 * context-engine stage via `ctx.assembleStageBundle`. Unmapped ops keep
 * `ctx.contextBundle` exactly as Phase A left it — the non-regression
 * guarantee.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCallOp, makeContextBundle, makeMockCallContext } from "@test/helpers";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution/story-orchestrator";
import type { CallContext, RunOperation } from "@/operations";

function makeSlot(opName: string): AnySlot {
  const op = {
    kind: "run" as const,
    name: opName,
    stage: "run" as const,
    config: [] as const,
    session: { role: "implementer" as const, lifetime: "fresh" as const },
    build: () => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => ({}),
  } satisfies RunOperation<unknown, unknown, unknown>;
  return { op, input: {} };
}

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let dispatchedCtx: CallContext | undefined;

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  dispatchedCtx = undefined;
  _storyOrchestratorDeps.callOp = makeCallOp({
    fallback: { passed: true, success: true },
    onDispatch: (_op, ctx) => {
      dispatchedCtx = ctx;
    },
  });
  _storyOrchestratorDeps.captureGitRef = async () => "HEAD";
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
});

describe("runPhase — assembleStageBundle override (nax#1737 Phase B)", () => {
  test("a mapped three-session phase dispatches with the stage-assembled bundle", async () => {
    const stageBundle = makeContextBundle({ pushMarkdown: "## tdd-implementer bundle" });
    const floorBundle = makeContextBundle({ pushMarkdown: "## floor bundle" });
    const ctx = makeMockCallContext({
      contextBundle: floorBundle,
      assembleStageBundle: async (stage: string) => (stage === "tdd-implementer" ? stageBundle : undefined),
    });

    await runPhase(ctx, makeSlot("implementer"), {}, {}, true);

    expect(dispatchedCtx?.contextBundle).toBe(stageBundle);
  });

  test("the same op name with isThreeSession=false does not override", async () => {
    const stageBundle = makeContextBundle({ pushMarkdown: "## tdd-implementer bundle" });
    const floorBundle = makeContextBundle({ pushMarkdown: "## floor bundle" });
    const ctx = makeMockCallContext({
      contextBundle: floorBundle,
      assembleStageBundle: async () => stageBundle,
    });

    await runPhase(ctx, makeSlot("implementer"), {}, {}, false);

    expect(dispatchedCtx?.contextBundle).toBe(floorBundle);
  });

  test("an unmapped op dispatches with ctx.contextBundle untouched", async () => {
    const floorBundle = makeContextBundle({ pushMarkdown: "## floor bundle" });
    let assembleCalled = false;
    const ctx = makeMockCallContext({
      contextBundle: floorBundle,
      assembleStageBundle: async () => {
        assembleCalled = true;
        return makeContextBundle();
      },
    });

    await runPhase(ctx, makeSlot("lint-check"), {}, {}, true);

    expect(dispatchedCtx?.contextBundle).toBe(floorBundle);
    expect(assembleCalled).toBe(false);
  });

  test("assembleStageBundle returning undefined leaves the existing bundle in place", async () => {
    const floorBundle = makeContextBundle({ pushMarkdown: "## floor bundle" });
    const ctx = makeMockCallContext({
      contextBundle: floorBundle,
      assembleStageBundle: async () => undefined,
    });

    await runPhase(ctx, makeSlot("rectify"), {}, {}, false);

    expect(dispatchedCtx?.contextBundle).toBe(floorBundle);
  });

  test("assembleStageBundle rejecting does not fail the phase", async () => {
    const floorBundle = makeContextBundle({ pushMarkdown: "## floor bundle" });
    const ctx = makeMockCallContext({
      contextBundle: floorBundle,
      assembleStageBundle: async () => {
        throw new Error("boom");
      },
    });

    const output = await runPhase(ctx, makeSlot("semantic-review"), {}, {}, false);

    expect(output).toEqual({ passed: true, success: true });
    expect(dispatchedCtx?.contextBundle).toBe(floorBundle);
  });

  test("no assembleStageBundle on ctx (older caller) does not fail a mapped phase", async () => {
    const floorBundle = makeContextBundle({ pushMarkdown: "## floor bundle" });
    const ctx = makeMockCallContext({ contextBundle: floorBundle });

    await runPhase(ctx, makeSlot("adversarial-review"), {}, {}, false);

    expect(dispatchedCtx?.contextBundle).toBe(floorBundle);
  });
});

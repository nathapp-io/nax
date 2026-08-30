/**
 * nax#1773 — runPhase renders the per-stage phaseBundle into the actual
 * dispatched PROMPT, not just `dispatchCtx.contextBundle`.
 *
 * `run-phase-context-bundle.test.ts` already proves `dispatchCtx.contextBundle`
 * carries the right bundle object — that assertion passed even on the broken
 * code, because the bug is downstream: `write-test.ts` / `implement.ts` /
 * `verify.ts` render `input.promptMarkdown` (a string baked once at plan-input
 * time), and `semantic-review.ts` / `adversarial-review.ts` render
 * `input.featureCtxBlock` (same). Neither op ever reads `ctx.contextBundle`.
 * These tests assert on the dispatched INPUT — the thing the agent actually
 * sees — for two stages whose bundles differ.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCallOp, makeContextBundle, makeMockCallContext, makeStory } from "@test/helpers";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution/story-orchestrator";
import type { RunOperation } from "@/operations";

function makeSlot(opName: string, input: unknown): AnySlot {
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
  return { op, input };
}

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let dispatchedInput: unknown;

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  dispatchedInput = undefined;
  _storyOrchestratorDeps.callOp = makeCallOp({
    fallback: { passed: true, success: true },
    onDispatch: (_op, _ctx, input) => {
      dispatchedInput = input;
    },
  });
  _storyOrchestratorDeps.captureGitRef = async () => "HEAD";
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
});

describe("runPhase — phase-bundle prompt rendering (nax#1773)", () => {
  test("a TDD implementer phase renders the stage-assembled bundle into promptMarkdown, not the plan-baked one", async () => {
    const story = makeStory({ id: "US-777" });
    const stageBundle = makeContextBundle({ pushMarkdown: "## STAGE-BUNDLE-CONTENT tdd-implementer" });
    const ctx = makeMockCallContext({
      story,
      phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" },
      assembleStageBundle: async (stage: string) => (stage === "tdd-implementer" ? stageBundle : undefined),
    });
    const planTimeInput = {
      story,
      // Simulates the stale value assemblePlanInputsFromCtx baked once, before
      // any per-stage bundle existed — must NOT survive to dispatch.
      promptMarkdown: "## PLAN-TIME-CONTENT stale bundle\n\nTask body.",
    };

    await runPhase(ctx, makeSlot("implementer", planTimeInput), {}, {}, true);

    const sent = dispatchedInput as { promptMarkdown?: string };
    expect(sent.promptMarkdown).toContain("STAGE-BUNDLE-CONTENT");
    expect(sent.promptMarkdown).not.toContain("PLAN-TIME-CONTENT stale bundle");
  });

  test("two stages with different stage bundles produce different rendered prompts for the same op", async () => {
    const story = makeStory({ id: "US-778" });
    const planTimeInput = {
      story,
      promptMarkdown: "## PLAN-TIME-CONTENT\n\nTask body.",
    };

    const ctxA = makeMockCallContext({
      story,
      phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" },
      assembleStageBundle: async () => makeContextBundle({ pushMarkdown: "## BUNDLE-A-ONLY" }),
    });
    await runPhase(ctxA, makeSlot("implementer", planTimeInput), {}, {}, true);
    const promptA = (dispatchedInput as { promptMarkdown?: string }).promptMarkdown ?? "";

    const ctxB = makeMockCallContext({
      story,
      phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" },
      assembleStageBundle: async () => makeContextBundle({ pushMarkdown: "## BUNDLE-B-ONLY" }),
    });
    await runPhase(ctxB, makeSlot("implementer", planTimeInput), {}, {}, true);
    const promptB = (dispatchedInput as { promptMarkdown?: string }).promptMarkdown ?? "";

    expect(promptA).not.toBe(promptB);
    expect(promptA).toContain("BUNDLE-A-ONLY");
    expect(promptB).toContain("BUNDLE-B-ONLY");
  });

  test("semantic-review renders the stage bundle into featureCtxBlock, not the plan-baked one", async () => {
    const story = makeStory({ id: "US-779" });
    const stageBundle = makeContextBundle({ pushMarkdown: "## STAGE-BUNDLE-CONTENT review-semantic" });
    const ctx = makeMockCallContext({
      story,
      assembleStageBundle: async (stage: string) => (stage === "review-semantic" ? stageBundle : undefined),
    });
    const planTimeInput = {
      story,
      workdir: "/tmp/test",
      featureCtxBlock: "## PLAN-TIME-CONTENT stale block\n\n---\n\n",
    };

    await runPhase(ctx, makeSlot("semantic-review", planTimeInput), {}, {}, false);

    const sent = dispatchedInput as { featureCtxBlock?: string };
    expect(sent.featureCtxBlock).toContain("STAGE-BUNDLE-CONTENT");
    expect(sent.featureCtxBlock).not.toContain("PLAN-TIME-CONTENT stale block");
  });

  test("an unmapped op's input is left untouched even when a bundle is somehow present", async () => {
    const story = makeStory({ id: "US-780" });
    const ctx = makeMockCallContext({ story, contextBundle: makeContextBundle({ pushMarkdown: "## floor" }) });
    const planTimeInput = { story, promptMarkdown: "## unrelated content" };

    await runPhase(ctx, makeSlot("lint-check", planTimeInput), {}, {}, true);

    expect(dispatchedInput).toBe(planTimeInput);
  });
});

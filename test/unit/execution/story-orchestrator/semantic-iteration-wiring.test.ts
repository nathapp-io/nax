/**
 * runPhase — semantic-review round history wiring (F1b-a).
 *
 * `priorSemanticIterations` was declared on PipelineContext, threaded through
 * plan-inputs, accepted by semanticReviewOp, and rendered by
 * ReviewPromptBuilder — every layer built and unit-tested — but the only
 * assignment anywhere in src/ was `ctx.priorSemanticIterations = undefined`.
 * Nothing ever populated it, so the semantic reviewer never saw its own prior
 * rounds while the adversarial reviewer did. See
 * `docs/findings/2026-08-01-review-pipeline-gap-analysis.md`.
 */

import { describe, expect, test } from "bun:test";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution";
import type { Finding, Iteration } from "@/findings";
import { makeMockCallContext } from "@test/helpers";

function makeSlot(opName: string): AnySlot {
  return {
    op: {
      kind: "run" as const,
      name: opName,
      stage: "review" as const,
      session: { role: "reviewer-semantic" as const, lifetime: "fresh" as const },
      build: () => ({ prompt: "" }),
      parse: () => ({}),
    } as any,
    input: {},
  };
}

function semanticFinding(issue: string): Finding {
  return {
    source: "semantic-review",
    severity: "error",
    file: "src/thing.ts",
    message: issue,
  } as any;
}

/** Runs one semantic-review phase, returning the input the op was dispatched with. */
async function dispatchSemanticPhase(
  store: Map<string, Iteration[]>,
  output: unknown,
): Promise<Record<string, unknown>> {
  const origCallOp = _storyOrchestratorDeps.callOp;
  let seenInput: Record<string, unknown> = {};
  _storyOrchestratorDeps.callOp = (async (_ctx: unknown, _op: unknown, input: unknown) => {
    seenInput = input as Record<string, unknown>;
    return output;
  }) as any;
  try {
    const ctx = makeMockCallContext({ storyId: "US-001" });
    (ctx.runtime as any).semanticIterations = store;
    await runPhase(ctx, makeSlot("semantic-review"), {}, {});
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
  }
  return seenInput;
}

describe("runPhase — semantic-review iteration history", () => {
  test("injects priorSemanticIterations from the runtime store", async () => {
    const store = new Map<string, Iteration[]>();
    const prior: Iteration = {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: [],
      findingsAfter: [semanticFinding("round one finding")],
      outcome: "fixes-applied",
      startedAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:01.000Z",
    } as any;
    store.set("US-001", [prior]);

    const input = await dispatchSemanticPhase(store, { passed: true, findings: [] });

    expect(input.priorSemanticIterations).toEqual([prior]);
  });

  test("records this round's findings so the next round can see them", async () => {
    const store = new Map<string, Iteration[]>();

    await dispatchSemanticPhase(store, {
      passed: false,
      findings: [],
      normalizedFindings: [semanticFinding("first round defect")],
    });

    const recorded = store.get("US-001");
    expect(recorded).toHaveLength(1);
    expect(recorded?.[0].findingsAfter).toEqual([semanticFinding("first round defect")]);
  });

  test("injects an empty history on the first round rather than undefined", async () => {
    const input = await dispatchSemanticPhase(new Map(), { passed: true, findings: [] });
    expect(input.priorSemanticIterations).toEqual([]);
  });
});

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
import { makeFinding, makeIteration, makeMockCallContext } from "@test/helpers";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution/story-orchestrator";
import type { Finding, Iteration } from "@/findings";

function makeSlot(opName: string): AnySlot {
  return {
    op: {
      kind: "run",
      name: opName,
      stage: "review",
      config: [],
      session: { role: "reviewer-semantic", lifetime: "fresh" },
      build: () => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: "", overridable: false },
      }),
      parse: () => ({}),
    },
    input: {},
  };
}

function semanticFinding(issue: string): Finding {
  return makeFinding({ source: "semantic-review", severity: "error", file: "src/thing.ts", message: issue });
}

/** Runs one semantic-review phase, returning the input the op was dispatched with. */
async function dispatchSemanticPhase(
  store: Map<string, Iteration[]>,
  output: unknown,
): Promise<Record<string, unknown>> {
  const origCallOp = _storyOrchestratorDeps.callOp;
  let seenInput: Record<string, unknown> = {};
  // The dep slot is generic (<I, O, C>), so Object.assign replaces it without
  // an assertion while parameter types still derive from the slot.
  Object.assign(_storyOrchestratorDeps, {
    callOp: async (
      _ctx: Parameters<typeof origCallOp>[0],
      _op: Parameters<typeof origCallOp>[1],
      input: Parameters<typeof origCallOp>[2],
    ) => {
      seenInput = input as Record<string, unknown>;
      return output;
    },
  });
  try {
    const ctx = makeMockCallContext({ storyId: "US-001" });
    Object.assign(ctx.runtime, { semanticIterations: store });
    await runPhase(ctx, makeSlot("semantic-review"), {}, {});
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
  }
  return seenInput;
}

describe("runPhase — semantic-review iteration history", () => {
  test("injects priorSemanticIterations from the runtime store", async () => {
    const store = new Map<string, Iteration[]>();
    const prior: Iteration = makeIteration({
      findingsAfter: [semanticFinding("round one finding")],
      startedAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:01.000Z",
    });
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

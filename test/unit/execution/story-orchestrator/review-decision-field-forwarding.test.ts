/**
 * Guard test — every optional field a review op's real verify() populates must
 * survive `emitReviewDecision` onto the dispatched `ReviewDecisionEvent`.
 *
 * This is the seam F3 of docs/findings/2026-08-01-review-pipeline-gap-analysis.md
 * diagnosed for `advisoryFindings` / `diffAvailable` / `adversarialDropAnalysis` /
 * `adversarialAcceptAnalysis`: both ops compute a field, `ReviewDecisionEvent`
 * declares it, the audit middleware forwards it — and `emitReviewDecision` alone
 * drops it, so 100% of persisted review-audit records carry it as null. `acks`
 * and `blockingThreshold` were the same bug, never added to that rescued list
 * (this is the third pass over the seam).
 *
 * Drives the REAL `adversarialReviewOp.verify()` / `semanticReviewOp.verify()`
 * (not a hand-authored fixture — see the audit-shape.test.ts rationale) so a
 * field renamed or added on an op output fails this test immediately rather
 * than silently vanishing at the emit call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockCallContext, opSelector, withTempDir } from "@test/helpers";
import { emitReviewDecision } from "@/execution/story-orchestrator/review-decision";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { SemanticReviewInput, SemanticReviewOutput } from "@/operations/semantic-review";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { NaxRuntime } from "@/runtime";
import type { ReviewDecisionEvent } from "@/runtime/dispatch-events";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function captureEmittedEvent(): {
  ctx: ReturnType<typeof makeMockCallContext>;
  getEvent: () => ReviewDecisionEvent | undefined;
} {
  const ctx = makeMockCallContext();
  createdRuntimes.push(ctx.runtime);
  let captured: ReviewDecisionEvent | undefined;
  ctx.runtime.dispatchEvents.onReviewDecision((event) => {
    captured = event;
  });
  return { ctx, getEvent: () => captured };
}

function makeVerifyCtx(
  op: typeof adversarialReviewOp | typeof semanticReviewOp,
  ctx: ReturnType<typeof makeMockCallContext>,
) {
  return {
    packageView: ctx.packageView,
    config: ctx.packageView.select(opSelector(op.config)),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

const ADVERSARIAL_STORY = {
  id: "STORY-FWD-01",
  title: "Field forwarding story",
  description: "Drives adversarialReviewOp.verify() -> emitReviewDecision",
  acceptanceCriteria: ["AC1: auth login security must not allow SQL injection attacks"],
};

const ADVERSARIAL_BASE_INPUT: AdversarialReviewInput = {
  workdir: "/tmp/review-decision-forwarding-adversarial",
  story: ADVERSARIAL_STORY,
  adversarialConfig: {
    model: "balanced" as const,
    diffMode: "ref" as const,
    rules: [],
    timeoutMs: 600_000,
    parallel: false,
    maxConcurrentSessions: 2,
    substantiation: { requote: true, maxRequotes: 5 },
  },
  mode: "ref",
  blockingThreshold: "warning",
};

function makeAdversarialOutput(overrides: Partial<AdversarialReviewOutput> = {}): AdversarialReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}

const SEMANTIC_STORY = {
  id: "STORY-FWD-02",
  title: "Field forwarding story",
  description: "Drives semanticReviewOp.verify() -> emitReviewDecision",
  acceptanceCriteria: ["AC0: returns 200 on success"],
};

const SEMANTIC_BASE_INPUT: SemanticReviewInput = {
  workdir: "/tmp/review-decision-forwarding-semantic",
  story: SEMANTIC_STORY,
  semanticConfig: {
    model: "balanced" as const,
    diffMode: "embedded" as const,
    resetRefOnRerun: false,
    rules: [],
    timeoutMs: 600_000,
    substantiation: { requote: true, maxRequotes: 5 },
  },
  mode: "embedded",
  blockingThreshold: "warning",
};

function makeSemanticOutput(overrides: Partial<SemanticReviewOutput> = {}): SemanticReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}

/**
 * A warning-severity finding: non-blocking at the "error" threshold, so it
 * survives substantiation and AC-grounding (both blocking-only) and carries
 * verify() all the way down the main return path.
 */
const SUB_THRESHOLD_FINDING = {
  severity: "warning",
  category: "quality",
  file: "src/auth.ts",
  line: 1,
  issue: "Logging is missing on the failure path",
  suggestion: "Add a log line",
};

/** See the canary tests below — update only alongside a routing decision. */
const ADVERSARIAL_OUTPUT_KEYS = [
  "acDropped",
  "advisoryFindings",
  "blockingThreshold",
  "findings",
  "modelPassed",
  "normalizedFindings",
  "passed",
];
const SEMANTIC_OUTPUT_KEYS = [
  "acDropped",
  "advisoryFindings",
  "blockingThreshold",
  "findings",
  "normalizedFindings",
  "passed",
];

describe("emitReviewDecision — op-output field canary", () => {
  // The named assertions below cover the fields known to have been dropped at
  // this seam. They cannot catch the NEXT one: a field added to an op output and
  // not routed through emitReviewDecision would pass every test in this file.
  //
  // These canaries close that gap. They pin the key set a real verify() emits, so
  // adding a field to an op output fails here and forces a conscious decision —
  // route it onto ReviewDecisionEvent, or judge it not worth persisting. Three
  // fields (advisoryFindings, acDropped, unparsedPreview) were silently dropped
  // here before F3; acks and blockingThreshold were the next two. Update the
  // expected list only together with that decision.
  // Driven down the MAIN return path (a surviving sub-threshold finding), not a
  // short-circuit: that is where the richest key set lives and where a new field
  // is most likely to be added.
  test("adversarial verify() emits a known key set", async () => {
    return withTempDir(async (workdir) => {
      const { ctx } = captureEmittedEvent();
      const verifyCtx = makeVerifyCtx(adversarialReviewOp, ctx);
      const input: AdversarialReviewInput = { ...ADVERSARIAL_BASE_INPUT, workdir, blockingThreshold: "error" };
      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const output = await verify(
        makeAdversarialOutput({ passed: false, findings: [SUB_THRESHOLD_FINDING] }),
        input,
        verifyCtx,
      );
      assertDefined(output, "verify() result");
      expect(Object.keys(output).sort()).toEqual(ADVERSARIAL_OUTPUT_KEYS);
    });
  });

  test("semantic verify() emits a known key set", async () => {
    return withTempDir(async (workdir) => {
      const { ctx } = captureEmittedEvent();
      const verifyCtx = makeVerifyCtx(semanticReviewOp, ctx);
      const input: SemanticReviewInput = { ...SEMANTIC_BASE_INPUT, workdir, blockingThreshold: "error" };
      const { verify } = semanticReviewOp;
      assertDefined(verify, "semanticReviewOp.verify");
      const output = await verify(
        makeSemanticOutput({ passed: false, findings: [SUB_THRESHOLD_FINDING] }),
        input,
        verifyCtx,
      );
      assertDefined(output, "verify() result");
      expect(Object.keys(output).sort()).toEqual(SEMANTIC_OUTPUT_KEYS);
    });
  });
});

describe("emitReviewDecision — forwards acks (adversarial-review)", () => {
  test("populated: an ack produced by the op survives onto the dispatched event", async () => {
    return withTempDir(async (workdir) => {
      const { ctx, getEvent } = captureEmittedEvent();
      const verifyCtx = makeVerifyCtx(adversarialReviewOp, ctx);
      const input: AdversarialReviewInput = { ...ADVERSARIAL_BASE_INPUT, workdir };
      const parsed = makeAdversarialOutput({
        passed: true,
        findings: [],
        acks: [{ priorFinding: "src/auth.ts:1", status: "addressed", note: "fixed in this round" }],
      });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const output = await verify(parsed, input, verifyCtx);
      assertDefined(output, "verify() result");

      emitReviewDecision(ctx, "adversarial-review", output);
      const event = getEvent();
      assertDefined(event, "emitted ReviewDecisionEvent");
      expect(event.acks).toEqual([{ priorFinding: "src/auth.ts:1", status: "addressed", note: "fixed in this round" }]);
    });
  });

  test("empty: an op output with no acks emits acks as undefined, not a stale value", async () => {
    return withTempDir(async (workdir) => {
      const { ctx, getEvent } = captureEmittedEvent();
      const verifyCtx = makeVerifyCtx(adversarialReviewOp, ctx);
      const input: AdversarialReviewInput = { ...ADVERSARIAL_BASE_INPUT, workdir };
      const parsed = makeAdversarialOutput({ passed: true, findings: [] });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const output = await verify(parsed, input, verifyCtx);
      assertDefined(output, "verify() result");

      emitReviewDecision(ctx, "adversarial-review", output);
      const event = getEvent();
      assertDefined(event, "emitted ReviewDecisionEvent");
      expect(event.acks).toBeUndefined();
    });
  });
});

describe("emitReviewDecision — forwards blockingThreshold (both reviewers, all branches)", () => {
  test("populated: adversarial main-path verdict carries the resolved threshold", async () => {
    return withTempDir(async (workdir) => {
      const { ctx, getEvent } = captureEmittedEvent();
      const verifyCtx = makeVerifyCtx(adversarialReviewOp, ctx);
      const input: AdversarialReviewInput = { ...ADVERSARIAL_BASE_INPUT, workdir, blockingThreshold: "warning" };
      const parsed = makeAdversarialOutput({ passed: true, findings: [] });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const output = await verify(parsed, input, verifyCtx);
      assertDefined(output, "verify() result");

      emitReviewDecision(ctx, "adversarial-review", output);
      const event = getEvent();
      assertDefined(event, "emitted ReviewDecisionEvent");
      expect(event.blockingThreshold).toBe("warning");
    });
  });

  // The critical branch (#1889): semantic's empty-findings short-circuit is 47.2%
  // of August reviews. A fix that only rescues the main-path return leaves the
  // large majority of records with blockingThreshold still null.
  test("populated: semantic empty-findings short-circuit still carries the threshold", async () => {
    return withTempDir(async (workdir) => {
      const { ctx, getEvent } = captureEmittedEvent();
      const verifyCtx = makeVerifyCtx(semanticReviewOp, ctx);
      const input: SemanticReviewInput = { ...SEMANTIC_BASE_INPUT, workdir, blockingThreshold: "info" };
      const parsed = makeSemanticOutput({ passed: true, findings: [] });

      const { verify } = semanticReviewOp;
      assertDefined(verify, "semanticReviewOp.verify");
      const output = await verify(parsed, input, verifyCtx);
      assertDefined(output, "verify() result");

      emitReviewDecision(ctx, "semantic-review", output);
      const event = getEvent();
      assertDefined(event, "emitted ReviewDecisionEvent");
      expect(event.blockingThreshold).toBe("info");
    });
  });

  // A fail-open / looksLikeFail give-up under a mis-set threshold is exactly the
  // case #1889 needs this data for — must not be gated behind `parsed`.
  test("populated: a failOpen give-up still carries the threshold (not gated behind parsed)", () => {
    const { ctx, getEvent } = captureEmittedEvent();
    const output: SemanticReviewOutput & Record<string, unknown> = {
      passed: true,
      findings: [],
      normalizedFindings: [],
      acDropped: [],
      failOpen: true,
      blockingThreshold: "error",
    };

    emitReviewDecision(ctx, "semantic-review", output);
    const event = getEvent();
    assertDefined(event, "emitted ReviewDecisionEvent");
    expect(event.parsed).toBe(false);
    expect(event.failOpen).toBe(true);
    expect(event.blockingThreshold).toBe("error");
  });

  test("populated: a looksLikeFail give-up still carries the threshold (not gated behind parsed)", () => {
    const { ctx, getEvent } = captureEmittedEvent();
    const output: AdversarialReviewOutput & Record<string, unknown> = {
      passed: false,
      findings: [],
      normalizedFindings: [],
      acDropped: [],
      looksLikeFail: true,
      blockingThreshold: "warning",
    };

    emitReviewDecision(ctx, "adversarial-review", output);
    const event = getEvent();
    assertDefined(event, "emitted ReviewDecisionEvent");
    expect(event.parsed).toBe(false);
    expect(event.looksLikeFail).toBe(true);
    expect(event.blockingThreshold).toBe("warning");
  });

  test("empty: an unrecognised blockingThreshold value narrows to undefined, never a wrong-but-valid value", () => {
    const { ctx, getEvent } = captureEmittedEvent();
    // Deliberately a bare record, not the op's output type: this simulates a
    // malformed value crossing the `output: unknown` seam, which
    // toReviewDecisionPayload must narrow defensively rather than trust.
    const output: Record<string, unknown> = {
      passed: true,
      findings: [],
      normalizedFindings: [],
      acDropped: [],
      blockingThreshold: "not-a-real-threshold",
    };

    emitReviewDecision(ctx, "semantic-review", output);
    const event = getEvent();
    assertDefined(event, "emitted ReviewDecisionEvent");
    expect(event.blockingThreshold).toBeUndefined();
  });
});

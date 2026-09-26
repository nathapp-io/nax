/**
 * US-001 — the `fix-review` branch of the review-decision seam.
 *
 * `toReviewDecisionPayload` / `emitReviewDecision`
 * (src/execution/story-orchestrator/review-decision.ts) translate an operation's
 * output into the dispatched `ReviewDecisionEvent` the review-audit subscriber
 * persists. The seeded reviewers (semantic, adversarial) hand it
 * `{ passed, findings, ... }`; the scoped fix review hands it a *verdict* —
 * `FixReviewOpOutput` carries no `findings`, `acDropped`, `acks` or
 * `advisoryFindings`, so the fix branch must be taken before any branch that
 * reads those fields, and must synthesize the finding list the audit expects
 * (`[]` on a pass, one entry naming the reason on a fail).
 *
 * Split out of `review-decision.test.ts` by concern: that file covers the
 * seeded-reviewer seam and is already at the ~650-line split target.
 *
 * These tests drive `emitReviewDecision` (the ACs' entry point) and assert on
 * the emitted event, because the bug class this seam keeps producing is a field
 * that some op computes and the emitter then drops on the floor.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext } from "@test/helpers";
import { emitReviewDecision } from "@/execution/story-orchestrator/review-decision";
import type { FixReviewOpOutput } from "@/review/fix-review";
import type { NaxRuntime } from "@/runtime";
import type { ReviewDecisionEvent } from "@/runtime/dispatch-events";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
  createdRuntimes.length = 0;
});

/** A CallContext wired to write into the real dispatch bus, plus the events it saw. */
function captureEmittedDecisions(): { ctx: ReturnType<typeof makeMockCallContext>; events: ReviewDecisionEvent[] } {
  const ctx = makeMockCallContext();
  createdRuntimes.push(ctx.runtime);
  const events: ReviewDecisionEvent[] = [];
  ctx.runtime.dispatchEvents.onReviewDecision((event) => {
    events.push(event);
  });
  return { ctx, events };
}

describe("emitReviewDecision — fix-review pass (US-001)", () => {
  test('US-001 AC11: a passing verdict emits ONE event for reviewer "fix" with empty findings', () => {
    const { ctx, events } = captureEmittedDecisions();
    const output: FixReviewOpOutput = { parsed: true, passed: true, reason: "ok" };

    emitReviewDecision(ctx, "fix-review", output);

    expect(events).toHaveLength(1);
    expect(events[0].reviewer).toBe("fix");
    expect(events[0].parsed).toBe(true);
    expect(events[0].passed).toBe(true);
    expect(events[0].result).toEqual({ passed: true, findings: [] });
  });

  test("US-001 AC11 boundary: an operation named anything else still emits nothing", () => {
    const { ctx, events } = captureEmittedDecisions();

    emitReviewDecision(ctx, "fix-review-extra", { parsed: true, passed: true, reason: "ok" });

    expect(events).toHaveLength(0);
  });
});

describe("emitReviewDecision — fix-review contradiction (US-001)", () => {
  test("US-001 AC12: a failing verdict emits exactly one finding carrying reason, acIndex and file", () => {
    const { ctx, events } = captureEmittedDecisions();
    const output: FixReviewOpOutput = {
      parsed: true,
      passed: false,
      reason: "adds mkdir",
      acIndex: 4,
      file: "src/a.ts",
    };

    emitReviewDecision(ctx, "fix-review", output);

    expect(events).toHaveLength(1);
    expect(events[0].reviewer).toBe("fix");
    expect(events[0].parsed).toBe(true);
    expect(events[0].passed).toBe(false);
    expect(events[0].result?.passed).toBe(false);
    expect(events[0].result?.findings).toEqual([
      expect.objectContaining({ message: "adds mkdir", acIndex: 4, file: "src/a.ts" }),
    ]);
  });

  test("US-001 AC12 boundary: a fail that names no AC/file still yields one finding with the reason", () => {
    const { ctx, events } = captureEmittedDecisions();
    const output: FixReviewOpOutput = { parsed: true, passed: false, reason: "contradicts the spec" };

    emitReviewDecision(ctx, "fix-review", output);

    expect(events).toHaveLength(1);
    expect(events[0].result?.findings).toEqual([expect.objectContaining({ message: "contradicts the spec" })]);
  });
});

describe("emitReviewDecision — fix-review unparsed output (US-001)", () => {
  test("US-001 AC13: an unparsed verdict emits parsed:false, result:null and the preview", () => {
    const { ctx, events } = captureEmittedDecisions();
    const output: FixReviewOpOutput = { parsed: false, unparsedPreview: "garbage" };

    emitReviewDecision(ctx, "fix-review", output);

    expect(events).toHaveLength(1);
    expect(events[0].reviewer).toBe("fix");
    expect(events[0].parsed).toBe(false);
    expect(events[0].result).toBeNull();
    expect(events[0].unparsedPreview).toBe("garbage");
  });

  test("US-001 AC13 boundary: a partial-JSON preview is reported verbatim, never coerced", () => {
    const { ctx, events } = captureEmittedDecisions();

    emitReviewDecision(ctx, "fix-review", { parsed: false, unparsedPreview: '{"passed": tru' });

    expect(events).toHaveLength(1);
    expect(events[0].parsed).toBe(false);
    expect(events[0].result).toBeNull();
    expect(events[0].unparsedPreview).toBe('{"passed": tru');
  });
});

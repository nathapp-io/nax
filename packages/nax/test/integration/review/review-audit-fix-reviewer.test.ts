/**
 * US-001 — the fix review's verdict reaches the persisted review-audit trail.
 *
 * AC14 drives the real subscriber (`attachReviewAuditSubscriber`) and the real
 * writer (`ReviewAuditor`) end-to-end over the real dispatch bus, into a temp
 * output dir: the claim is "a review-decision event whose reviewer is fix
 * produces one JSON record under review-audit/<feature>/", and only the bus →
 * subscriber → writer chain can make that claim false.
 *
 * The second test is the other half of the same wiring: a fix-reviewer *session*
 * dispatch has to be attributable to reviewer `"fix"` (US-001's
 * `reviewerFromRole` mapping), otherwise the record loses the session metadata
 * every other reviewer's record carries.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { ReviewAuditor } from "@/review/review-audit";
import type { ReviewDecisionEvent, SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachReviewAuditSubscriber } from "@/runtime/middleware/review-audit";

const FEATURE = "fix-review";
const FIX_SESSION_NAME = "nax-fix-feat-us-001-reviewer-fix";

const PERMS = { mode: "approve-reads" as const, bashApproval: "raw" as const };

function makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: FIX_SESSION_NAME,
    sessionRole: "reviewer-fix",
    prompt: "Review this fix",
    response: JSON.stringify({ passed: true, reason: "ok" }),
    agentName: "claude",
    stage: "review",
    storyId: "US-001",
    featureName: FEATURE,
    workdir: "/tmp/w",
    projectDir: "/tmp/p",
    resolvedPermissions: PERMS,
    roundTrips: 1,
    roundTripUnit: "agent-run",
    protocolIds: { sessionId: "sid-fix", recordId: "rid-fix" },
    origin: "runAsSession",
    durationMs: 150,
    timestamp: 1000,
    ...overrides,
  };
}

/** Every review-audit JSON record written under `<root>/review-audit/<feature>/`. */
async function readAuditRecords(root: string): Promise<Record<string, unknown>[]> {
  const dir = join(root, "review-audit", FEATURE);
  const names: string[] = [];
  for await (const name of new Bun.Glob("*.json").scan({ cwd: dir })) names.push(name);
  const records: Record<string, unknown>[] = [];
  for (const name of names) {
    records.push(await Bun.file(join(dir, name)).json());
  }
  return records;
}

function makeFixDecisionEvent(overrides: Partial<ReviewDecisionEvent> = {}): ReviewDecisionEvent {
  return {
    kind: "review-decision",
    runId: "run-fix-1",
    reviewer: "fix",
    sessionName: FIX_SESSION_NAME,
    workdir: "/tmp/w",
    projectDir: "/tmp/p",
    storyId: "US-001",
    featureName: FEATURE,
    timestamp: Date.now(),
    parsed: true,
    passed: true,
    result: { passed: true, findings: [] },
    ...overrides,
  };
}

describe("review-audit subscriber — fix reviewer (US-001)", () => {
  test('US-001 AC14: a reviewer:"fix" decision writes one record carrying reviewer "fix"', async () => {
    await withTempDir(async (outputDir) => {
      const bus = new DispatchEventBus();
      const auditor = new ReviewAuditor("run-fix-1", outputDir);
      const unsubscribe = attachReviewAuditSubscriber(bus, auditor, "run-fix-1");

      bus.emitReviewDecision(makeFixDecisionEvent());
      await auditor.flush();
      unsubscribe();

      const records = await readAuditRecords(outputDir);
      expect(records).toHaveLength(1);
      expect(records[0].reviewer).toBe("fix");
      expect(records[0].parsed).toBe(true);
      expect(records[0].result).toEqual({ passed: true, findings: [] });
    });
  });

  test('US-001 AC15 (integration): a fix-reviewer session dispatch is attributed to reviewer "fix"', async () => {
    await withTempDir(async (outputDir) => {
      const bus = new DispatchEventBus();
      const auditor = new ReviewAuditor("run-fix-1", outputDir);
      const unsubscribe = attachReviewAuditSubscriber(bus, auditor, "run-fix-1");

      // No sessionName on the decision: the writer has to take the session
      // metadata from the dispatch the subscriber recorded for this reviewer.
      bus.emitDispatch(makeSessionTurnEvent());
      bus.emitReviewDecision(makeFixDecisionEvent({ sessionName: undefined }));
      await auditor.flush();
      unsubscribe();

      const records = await readAuditRecords(outputDir);
      expect(records).toHaveLength(1);
      expect(records[0].reviewer).toBe("fix");
      expect(records[0].sessionName).toBe(FIX_SESSION_NAME);
      expect(records[0].sessionId).toBe("sid-fix");
    });
  });

  test("US-001 AC14 boundary: an unparsed fix verdict is persisted with result null", async () => {
    await withTempDir(async (outputDir) => {
      const bus = new DispatchEventBus();
      const auditor = new ReviewAuditor("run-fix-2", outputDir);
      const unsubscribe = attachReviewAuditSubscriber(bus, auditor, "run-fix-2");

      bus.emitReviewDecision(
        makeFixDecisionEvent({
          parsed: false,
          passed: false,
          result: null,
          unparsedPreview: "garbage",
        }),
      );
      await auditor.flush();
      unsubscribe();

      const records = await readAuditRecords(outputDir);
      expect(records).toHaveLength(1);
      expect(records[0].reviewer).toBe("fix");
      expect(records[0].parsed).toBe(false);
      expect(records[0].result).toBeNull();
      expect(records[0].unparsedPreview).toBe("garbage");
    });
  });
});

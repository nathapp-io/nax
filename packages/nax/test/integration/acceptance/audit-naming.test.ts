/**
 * Audit file naming regression test for a multi-segment session role
 * (ADR-020 Wave 1, D6 fix).
 *
 * Asserts that a CompleteDispatchEvent with sessionRole:"plan-refine" produces
 * an audit file named *-plan-refine-complete.txt — not *-plan-complete.txt.
 *
 * Before Wave 1's typed SessionRole, the dispatch path passed a free-form role
 * string that could be truncated or misspelled, yielding the wrong file name.
 * The dispatch event now carries the canonical SessionRole and the sessionName
 * (which encodes the role) is derived from it, so the audit file name reflects
 * the correct role.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { CompleteDispatchEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachAuditSubscriber } from "@/runtime/middleware/audit";
import { PromptAuditor } from "@/runtime/prompt-auditor";

const PERMS = { mode: "approve-reads" as const, bashApproval: "raw" as const };

function makeMultiSegmentRoleEvent(): CompleteDispatchEvent {
  return {
    kind: "complete",
    sessionName: "nax-abcd1234-my-feat-US-001-plan-refine",
    sessionRole: "plan-refine",
    prompt: "generate acceptance tests",
    response: "describe('...')",
    agentName: "claude",
    stage: "complete",
    storyId: "US-001",
    featureName: "my-feat",
    resolvedPermissions: PERMS,
    durationMs: 80,
    timestamp: 1_700_000_000_000,
  };
}

describe("multi-segment role audit naming (D6 regression)", () => {
  test("CompleteDispatchEvent with a multi-segment role produces *-<role>-complete.txt", async () => {
    await withTempDir(async (tmpDir) => {
      const auditor = new PromptAuditor("run-acc-001", tmpDir, "my-feat");
      const bus = new DispatchEventBus();
      const unsub = attachAuditSubscriber(bus, auditor, "run-acc-001");

      const event = makeMultiSegmentRoleEvent();
      bus.emitDispatch(event);
      await auditor.flush();

      unsub();

      const g = new Bun.Glob("*.txt");
      const files: string[] = [];
      for (const f of g.scanSync({ cwd: join(tmpDir, "my-feat"), absolute: false })) {
        files.push(f);
      }

      expect(files.length).toBeGreaterThanOrEqual(1);

      const hasCorrectName = files.some((f) => f.includes("plan-refine") && f.endsWith("complete.txt"));
      expect(hasCorrectName).toBe(true);

      const hasWrongName = files.some((f) => f.includes("-plan-complete.txt"));
      expect(hasWrongName).toBe(false);
    });
  });

  test("sessionRole typed as plan-refine (not plan) satisfies SessionRole type", () => {
    const event = makeMultiSegmentRoleEvent();
    // The role must be the full "plan-refine" string — compile-time and runtime check.
    expect(event.sessionRole).toBe("plan-refine");
    expect(event.sessionName).toContain("plan-refine");
  });
});

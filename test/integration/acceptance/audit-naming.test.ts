/**
 * Acceptance-gen audit file naming regression test (ADR-020 Wave 1, D6 fix).
 *
 * Asserts that a CompleteDispatchEvent with sessionRole:"acceptance-gen" produces
 * an audit file named *-acceptance-gen-complete.txt — not *-acceptance-complete.txt.
 *
 * Before Wave 1's typed SessionRole, the acceptance generator passed a free-form
 * role string that could be truncated or misspelled, yielding the wrong file name.
 * The dispatch event now carries SessionRole typed "acceptance-gen" and the
 * sessionName (which encodes the role) is derived from opts.sessionRole, so the
 * audit file name reflects the correct role.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CompleteDispatchEvent } from "../../../src/runtime/dispatch-events";
import { DispatchEventBus } from "../../../src/runtime/dispatch-events";
import { attachAuditSubscriber } from "../../../src/runtime/middleware/audit";
import { PromptAuditor } from "../../../src/runtime/prompt-auditor";
import { withTempDir } from "../../helpers/temp";

const PERMS = { mode: "approve-reads" as const, skipPermissions: false };

function makeAcceptanceGenEvent(): CompleteDispatchEvent {
  return {
    kind: "complete",
    sessionName: "nax-abcd1234-my-feat-US-001-acceptance-gen",
    sessionRole: "acceptance-gen",
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

describe("acceptance-gen audit naming (D6 regression)", () => {
  test("CompleteDispatchEvent with acceptance-gen role produces *-acceptance-gen-complete.txt", async () => {
    await withTempDir(async (tmpDir) => {
      const auditor = new PromptAuditor("run-acc-001", tmpDir, "my-feat");
      const bus = new DispatchEventBus();
      const unsub = attachAuditSubscriber(bus, auditor, "run-acc-001");

      const event = makeAcceptanceGenEvent();
      bus.emitDispatch(event);
      await auditor.flush();

      unsub();

      const g = new Bun.Glob("*.txt");
      const files: string[] = [];
      for (const f of g.scanSync({ cwd: join(tmpDir, "my-feat"), absolute: false })) {
        files.push(f);
      }

      expect(files.length).toBeGreaterThanOrEqual(1);

      const hasCorrectName = files.some((f) => f.includes("acceptance-gen") && f.endsWith("complete.txt"));
      expect(hasCorrectName).toBe(true);

      const hasWrongName = files.some((f) => f.includes("-acceptance-complete.txt"));
      expect(hasWrongName).toBe(false);
    });
  });

  test("sessionRole typed as acceptance-gen (not acceptance) satisfies SessionRole type", () => {
    const event = makeAcceptanceGenEvent();
    // The role must be the full "acceptance-gen" string — compile-time and runtime check.
    expect(event.sessionRole).toBe("acceptance-gen");
    expect(event.sessionName).toContain("acceptance-gen");
  });
});

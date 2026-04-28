/**
 * TDD per-role audit file naming regression test (ADR-020 Wave 1, tactical patch).
 *
 * Asserts that SessionTurnDispatchEvents emitted with TDD session roles produce
 * audit files named with the correct per-role suffix:
 *   *-test-writer-run-t01.txt
 *   *-implementer-run-t01.txt
 *   *-verifier-run-t01.txt
 *
 * Before ADR-020 Wave 1, runTrackedSession wrote sessionHint into runOptions and
 * the audit middleware read it back. After Wave 1, runTrackedSession emits a typed
 * SessionTurnDispatchEvent with sessionRole and sessionName populated from the
 * session descriptor. This test locks in the D1/D5 contract so regressions in the
 * emit path surface immediately.
 *
 * The test exercises the same subscriber chain the production runtime uses:
 *   DispatchEventBus → attachAuditSubscriber → PromptAuditor → per-role .txt file
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SessionTurnDispatchEvent } from "../../../src/runtime/dispatch-events";
import { DispatchEventBus } from "../../../src/runtime/dispatch-events";
import { attachAuditSubscriber } from "../../../src/runtime/middleware/audit";
import { PromptAuditor } from "../../../src/runtime/prompt-auditor";
import type { SessionRole } from "../../../src/runtime/session-role";
import { withTempDir } from "../../helpers/temp";

const PERMS = { mode: "approve-reads" as const, skipPermissions: false };

function makeTddTurnEvent(role: SessionRole, turn = 1): SessionTurnDispatchEvent {
  const sessionName = `nax-abcd1234-tdd-calc-US-001-${role}`;
  return {
    kind: "session-turn",
    sessionName,
    sessionRole: role,
    prompt: `${role} prompt`,
    response: `${role} output`,
    agentName: "claude",
    stage: "run",
    storyId: "US-001",
    featureName: "tdd-calc",
    resolvedPermissions: PERMS,
    turn,
    protocolIds: { sessionId: null },
    origin: "runTrackedSession",
    durationMs: 200,
    timestamp: 1_700_000_000_000,
  };
}

describe("TDD per-role audit file naming (ADR-020 Wave 1 regression)", () => {
  const tddRoles: SessionRole[] = ["test-writer", "implementer", "verifier"];

  for (const role of tddRoles) {
    test(`${role} dispatch event produces *-${role}-run-t01.txt audit file`, async () => {
      await withTempDir(async (tmpDir) => {
        const auditor = new PromptAuditor("run-tdd-001", tmpDir, "tdd-calc");
        const bus = new DispatchEventBus();
        const unsub = attachAuditSubscriber(bus, auditor, "run-tdd-001");

        bus.emitDispatch(makeTddTurnEvent(role, 1));
        await auditor.flush();
        unsub();

        const g = new Bun.Glob("*.txt");
        const files: string[] = [];
        for (const f of g.scanSync({ cwd: join(tmpDir, "tdd-calc"), absolute: false })) {
          files.push(f);
        }

        expect(files.length).toBeGreaterThanOrEqual(1);
        // Must contain the full role name and the stage+turn suffix.
        const expectedPattern = `-${role}-run-t01.txt`;
        const hasExpected = files.some((f) => f.endsWith(expectedPattern));
        expect(hasExpected).toBe(true);
      });
    });
  }

  test("no run-run-US-001 files (original #771 symptom absent)", async () => {
    await withTempDir(async (tmpDir) => {
      const auditor = new PromptAuditor("run-tdd-001", tmpDir, "tdd-calc");
      const bus = new DispatchEventBus();
      const unsub = attachAuditSubscriber(bus, auditor, "run-tdd-001");

      for (const role of tddRoles) {
        bus.emitDispatch(makeTddTurnEvent(role, 1));
      }
      await auditor.flush();
      unsub();

      const g = new Bun.Glob("*.txt");
      const files: string[] = [];
      for (const f of g.scanSync({ cwd: join(tmpDir, "tdd-calc"), absolute: false })) {
        files.push(f);
      }

      // None of the files should use the generic "run-run-US-001" pattern.
      const badFiles = files.filter((f) => f.includes("run-run-"));
      expect(badFiles).toHaveLength(0);

      // All three roles must be represented.
      for (const role of tddRoles) {
        const hasRole = files.some((f) => f.includes(`-${role}-`));
        expect(hasRole).toBe(true);
      }
    });
  });
});

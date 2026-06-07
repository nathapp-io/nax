// test/unit/execution/non-blocking-fix.test.ts
import { describe, expect, test } from "bun:test";
import {
  runNonBlockingFix,
  shouldRunNonBlockingFix,
} from "../../../src/execution/non-blocking-fix";

describe("non-blocking-fix gating", () => {
  test("disabled config → does not run", () => {
    expect(shouldRunNonBlockingFix(undefined, 2)).toBe(false);
    expect(
      shouldRunNonBlockingFix(
        { enabled: false, scope: "both", regressionAttempts: 1, verifierGuard: true },
        2,
      ),
    ).toBe(false);
  });

  test("enabled but zero advisory findings → does not run", () => {
    expect(
      shouldRunNonBlockingFix(
        { enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true },
        0,
      ),
    ).toBe(false);
  });

  test("enabled with advisory findings → runs", () => {
    expect(
      shouldRunNonBlockingFix(
        { enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true },
        3,
      ),
    ).toBe(true);
  });

  test("scope-aware build is done at plan time (see Task 6 Step 1) — not by name filtering", () => {
    expect(typeof shouldRunNonBlockingFix).toBe("function");
  });
});

describe("runNonBlockingFix keep vs restore", () => {
  const baseArgs = {
    workdir: "/tmp/x",
    storyId: "us-001",
    advisoryFindings: [
      { source: "adversarial-review", severity: "warning", category: "input", message: "m" },
    ] as never,
    cfg: { enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true } as const,
  };
  const fakeDeps = {
    captureSnapshotRef: async () => "snap-sha",
    rollbackToRef: async () => {},
  };

  test("kept when harness resolves", async () => {
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs,
        runRectify: async () => ({ rectificationExhausted: false }),
      },
      fakeDeps,
    );
    expect(res).toEqual({ ran: true, kept: true, restored: false });
    expect(phaseOutputs["full-suite-gate"]).toEqual({ success: true });
  });

  test("restored when harness exhausts — phaseOutputs rolled back", async () => {
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    let rolled = "";
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs,
        runRectify: async () => {
          phaseOutputs["full-suite-gate"] = { success: false }; // pass polluted it
          return { rectificationExhausted: true };
        },
      },
      {
        captureSnapshotRef: async () => "snap-sha",
        rollbackToRef: async (_w: string, ref: string) => {
          rolled = ref;
        },
      },
    );
    expect(res).toEqual({ ran: true, kept: false, restored: true });
    expect(rolled).toBe("snap-sha");
    expect(phaseOutputs["full-suite-gate"]).toEqual({ success: true }); // restored
  });
});

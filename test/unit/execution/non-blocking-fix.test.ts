// test/unit/execution/non-blocking-fix.test.ts
import { describe, expect, test } from "bun:test";
import {
  nonBlockingExtraPhases,
  runNonBlockingFix,
  shouldRunNonBlockingFix,
} from "../../../src/execution/non-blocking-fix";

describe("non-blocking-fix gating", () => {
  test("disabled config → does not run", () => {
    expect(shouldRunNonBlockingFix(undefined, 2)).toBe(false);
    expect(
      shouldRunNonBlockingFix({ enabled: false, scope: "both", regressionAttempts: 1, verifierGuard: true }, 2),
    ).toBe(false);
  });

  test("enabled but zero advisory findings → does not run", () => {
    expect(
      shouldRunNonBlockingFix({ enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true }, 0),
    ).toBe(false);
  });

  test("enabled with advisory findings → runs", () => {
    expect(
      shouldRunNonBlockingFix({ enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true }, 3),
    ).toBe(true);
  });

  test("scope-aware build is done at plan time — not by name filtering", () => {
    const enabled = {
      enabled: true,
      scope: "both" as const,
      regressionAttempts: 1,
      verifierGuard: true,
    };
    expect(shouldRunNonBlockingFix(enabled, 1)).toBe(true);
    expect(shouldRunNonBlockingFix(enabled, -1)).toBe(false);
  });
});

describe("runNonBlockingFix keep vs restore", () => {
  const baseArgs = {
    workdir: "/tmp/x",
    storyId: "us-001",
    advisoryFindings: [{ source: "adversarial-review", severity: "warning", category: "input", message: "m" }] as never,
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

describe("nonBlockingExtraPhases with triage scope", () => {
  test("phases: scope 'triage' + verifierGuard true → ['verifier']", () => {
    const phases = nonBlockingExtraPhases({
      enabled: true,
      scope: "triage",
      regressionAttempts: 1,
      verifierGuard: true,
    });
    expect(phases).toEqual(["verifier"]);
  });

  test("phases: scope 'triage' + verifierGuard false → []", () => {
    const phases = nonBlockingExtraPhases({
      enabled: true,
      scope: "triage",
      regressionAttempts: 1,
      verifierGuard: false,
    });
    expect(phases).toEqual([]);
  });
});

describe("runNonBlockingFix sourceDiffCap", () => {
  const advisory = [{ source: "adversarial-review", severity: "warning", category: "input", message: "m" }] as never;

  test("AC-2: source diff exceeding maxLines → restored over kept", async () => {
    let rolled = "";
    const res = await runNonBlockingFix(
      {
        workdir: "/tmp/x",
        storyId: "us-002",
        advisoryFindings: advisory,
        cfg: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 50 },
        },
        phaseOutputs: {},
        runRectify: async () => ({ rectificationExhausted: false }),
      },
      {
        captureSnapshotRef: async () => "snap-sha",
        rollbackToRef: async (_w: string, ref: string) => {
          rolled = ref;
        },
        measureSourceDiff: async () => ({ fileCount: 1, sourceLineCount: 100 }),
      },
    );
    expect(res).toEqual({ ran: true, kept: false, restored: true });
    expect(rolled).toBe("snap-sha");
  });

  test("source diff exceeding maxFiles → restored (maxFiles branch coverage)", async () => {
    let rolled = "";
    const res = await runNonBlockingFix(
      {
        workdir: "/tmp/x",
        storyId: "us-maxfiles",
        advisoryFindings: advisory,
        cfg: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 5, maxLines: 500 },
        },
        phaseOutputs: {},
        runRectify: async () => ({ rectificationExhausted: false }),
      },
      {
        captureSnapshotRef: async () => "snap-sha",
        rollbackToRef: async (_w: string, ref: string) => {
          rolled = ref;
        },
        measureSourceDiff: async () => ({ fileCount: 20, sourceLineCount: 10 }),
      },
    );
    expect(res).toEqual({ ran: true, kept: false, restored: true });
    expect(rolled).toBe("snap-sha");
  });

  test("AC-3: source diff within cap → kept", async () => {
    let rolled = "";
    const res = await runNonBlockingFix(
      {
        workdir: "/tmp/x",
        storyId: "us-003",
        advisoryFindings: advisory,
        cfg: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 200 },
        },
        phaseOutputs: {},
        runRectify: async () => ({ rectificationExhausted: false }),
      },
      {
        captureSnapshotRef: async () => "snap-sha",
        rollbackToRef: async (_w: string, ref: string) => {
          rolled = ref;
        },
        measureSourceDiff: async () => ({ fileCount: 2, sourceLineCount: 100 }),
      },
    );
    expect(res).toEqual({ ran: true, kept: true, restored: false });
    expect(rolled).toBe("");
  });

  test("AC-4: measureSourceDiff throws → restored (fail-safe)", async () => {
    let rolled = "";
    const res = await runNonBlockingFix(
      {
        workdir: "/tmp/x",
        storyId: "us-004",
        advisoryFindings: advisory,
        cfg: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 200 },
        },
        phaseOutputs: {},
        runRectify: async () => ({ rectificationExhausted: false }),
      },
      {
        captureSnapshotRef: async () => "snap-sha",
        rollbackToRef: async (_w: string, ref: string) => {
          rolled = ref;
        },
        measureSourceDiff: async () => {
          throw new Error("git diff failed");
        },
      },
    );
    expect(res).toEqual({ ran: true, kept: false, restored: true });
    expect(rolled).toBe("snap-sha");
  });

  test("AC-5: all changes in test files → kept when within cap", async () => {
    let rolled = "";
    const res = await runNonBlockingFix(
      {
        workdir: "/tmp/x",
        storyId: "us-005",
        advisoryFindings: advisory,
        cfg: {
          enabled: true,
          scope: "triage",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 200 },
        },
        phaseOutputs: {},
        runRectify: async () => ({ rectificationExhausted: false }),
      },
      {
        captureSnapshotRef: async () => "snap-sha",
        rollbackToRef: async (_w: string, ref: string) => {
          rolled = ref;
        },
        measureSourceDiff: async () => ({ fileCount: 2, sourceLineCount: 0 }),
      },
    );
    expect(res).toEqual({ ran: true, kept: true, restored: false });
    expect(rolled).toBe("");
  });
});

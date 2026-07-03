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
    phaseCosts: {} as Record<string, number>,
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

  test("restored when kept tree regressed the full-suite gate (ADR-024 §3 deterministic red → revert)", async () => {
    // The inner rectify cycle can return not-exhausted via the verifier-SSOT exemption
    // even though its revalidation left the full-suite-gate RED. Keeping such a fix
    // violates ADR-024 §3 (deterministic red → revert) and the downstream staleness
    // guard (ExecutionPlan.run) would then fail the story — breaking the §1/§5
    // "can never fail the story" floor. `keptTreeRegressed` reuses the exact staleness
    // predicate the final verdict applies, so keep and verdict cannot disagree.
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    let rolled = "";
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs,
        runRectify: async () => {
          phaseOutputs["full-suite-gate"] = { success: false }; // fix broke a test
          return { rectificationExhausted: false }; // but cycle exempted the gate (verifier passed)
        },
        keptTreeRegressed: () => (phaseOutputs["full-suite-gate"] as { success?: boolean }).success === false,
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
    expect(phaseOutputs["full-suite-gate"]).toEqual({ success: true }); // restored to adversarial-passed
  });

  test("kept when keptTreeRegressed predicate reports no regression", async () => {
    // Guard the non-restorative branch: a supplied predicate that returns false must
    // not force a restore — the resolved, gate-green fix is kept.
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    let rolled = "";
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs,
        runRectify: async () => ({ rectificationExhausted: false }),
        keptTreeRegressed: () => false,
      },
      {
        captureSnapshotRef: async () => "snap-sha",
        rollbackToRef: async (_w: string, ref: string) => {
          rolled = ref;
        },
      },
    );
    expect(res).toEqual({ ran: true, kept: true, restored: false });
    expect(rolled).toBe("");
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

  test("snapshot capture fails → returns ran:false and does NOT throw (audit #1)", async () => {
    // A non-git workdir or transient git failure makes captureSnapshotRef throw. The pass
    // must degrade to "did not run" — never propagate the throw into the caller's verdict
    // path (the module contract). runRectify must not even be invoked (no rollback point).
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const phaseCosts: Record<string, number> = { implementer: 0.1 };
    let rectifyCalled = false;
    let rolled = false;
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs,
        phaseCosts,
        runRectify: async () => {
          rectifyCalled = true;
          return { rectificationExhausted: false };
        },
      },
      {
        captureSnapshotRef: async () => {
          throw new Error("git rev-parse HEAD failed in non-blocking-fix snapshot");
        },
        rollbackToRef: async () => {
          rolled = true;
        },
      },
    );
    expect(res).toEqual({ ran: false, kept: false, restored: false });
    expect(rectifyCalled).toBe(false); // never started — no safe undo point
    expect(rolled).toBe(false);
    // Tree state untouched: no rectify ran, so phaseOutputs/phaseCosts are unchanged.
    expect(phaseOutputs["full-suite-gate"]).toEqual({ success: true });
    expect(phaseCosts).toEqual({ implementer: 0.1 });
  });

  test("restored → phaseCosts rolled back to entry snapshot (no inflation from discarded pass)", async () => {
    // The best-effort rectify pass accrues cost into the shared phaseCosts map. On
    // rollback that cost must be reverted alongside phaseOutputs, so a discarded pass
    // leaves the result's per-phase cost breakdown symmetric with its outputs.
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const phaseCosts: Record<string, number> = { implementer: 0.10 };
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs,
        phaseCosts,
        runRectify: async () => {
          phaseCosts.implementer = 0.35; // pass spent more
          phaseCosts["adversarial-review"] = 0.20; // and added a new phase
          return { rectificationExhausted: true };
        },
      },
      fakeDeps,
    );
    expect(res).toEqual({ ran: true, kept: false, restored: true });
    // Reverted to the entry snapshot — the discarded pass's cost is gone, the new key removed.
    expect(phaseCosts).toEqual({ implementer: 0.10 });
  });

  test("kept → phaseCosts retains the best-effort pass cost", async () => {
    // When the pass is kept (resolved, within cap), its cost is real work and stays.
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const phaseCosts: Record<string, number> = { implementer: 0.10 };
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs,
        phaseCosts,
        runRectify: async () => {
          phaseCosts.implementer = 0.35;
          return { rectificationExhausted: false };
        },
      },
      fakeDeps,
    );
    expect(res).toEqual({ ran: true, kept: true, restored: false });
    expect(phaseCosts).toEqual({ implementer: 0.35 });
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
        phaseCosts: {},
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
        phaseCosts: {},
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
        phaseCosts: {},
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
        phaseCosts: {},
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
        phaseCosts: {},
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

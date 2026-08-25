// test/unit/execution/non-blocking-fix.test.ts
import { describe, expect, test } from "bun:test";
import {
  actionableAdvisoryFindings,
  nonBlockingExtraPhases,
  runNonBlockingFix,
  shouldRunNonBlockingFix,
} from "@/execution/non-blocking-fix";
import type { Finding } from "@/findings";
import { withInfoSpy } from "@test/helpers";

describe("non-blocking-fix gating", () => {
  test("disabled config → does not run", () => {
    expect(shouldRunNonBlockingFix(undefined, 2)).toBe(false);
    expect(
      shouldRunNonBlockingFix(
        {
          enabled: false,
          scope: "both",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
        },
        2,
      ),
    ).toBe(false);
  });

  test("enabled but zero advisory findings → does not run", () => {
    expect(
      shouldRunNonBlockingFix(
        {
          enabled: true,
          scope: "both",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
        },
        0,
      ),
    ).toBe(false);
  });

  test("enabled with advisory findings → runs", () => {
    expect(
      shouldRunNonBlockingFix(
        {
          enabled: true,
          scope: "both",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
        },
        3,
      ),
    ).toBe(true);
  });

  test("scope-aware build is done at plan time — not by name filtering", () => {
    const enabled = {
      enabled: true,
      scope: "both" as const,
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
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
    cfg: {
      enabled: true,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
    } as const,
    phaseCosts: {} as Record<string, number>,
  };
  const fakeDeps = {
    captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
    rollbackToRef: async () => {},
  };

  test("skips the pass when the worktree may hold an unreverted mutation", async () => {
    // The snapshot is itself a commit — it would capture the injected defect
    // AND leave the tree clean, so every later autoCommitIfDirty guard would
    // see nothing to block. The check must therefore precede the snapshot.
    let snapshots = 0;
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs: {},
        blockedWorktrees: new Set(["/tmp/x"]),
        runRectify: async () => ({ rectificationExhausted: false }),
      },
      {
        ...fakeDeps,
        captureSnapshotRef: async () => {
          snapshots += 1;
          return { sha: "snap-sha", untrackedBefore: [] };
        },
      },
    );
    expect(res).toEqual({ ran: false, kept: false, restored: false });
    expect(snapshots).toBe(0);
  });

  test("runs normally when the blocked set names an unrelated worktree", async () => {
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs: { "full-suite-gate": { success: true } },
        blockedWorktrees: new Set(["/tmp/other-repo"]),
        runRectify: async () => ({ rectificationExhausted: false }),
      },
      fakeDeps,
    );
    expect(res).toEqual({ ran: true, kept: true, restored: false });
  });

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
        keptTreeRegressed: () => ({
          regressed: (phaseOutputs["full-suite-gate"] as { success?: boolean }).success === false,
          regressedKeys: ["broke.test.ts::t-new"],
          memoExcludedKeys: [],
          baselineKeySize: 0,
          keyless: false,
        }),
      },
      {
        captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
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
        keptTreeRegressed: () => ({
          regressed: false,
          regressedKeys: [],
          memoExcludedKeys: [],
          baselineKeySize: 0,
          keyless: false,
        }),
      },
      {
        captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
        rollbackToRef: async (_w: string, ref: string) => {
          rolled = ref;
        },
      },
    );
    expect(res).toEqual({ ran: true, kept: true, restored: false });
    expect(rolled).toBe("");
  });

  // #1382 — the rollback used to log `storyId` only, so an operator saw a revert with
  // no cause and the evidence was unrecoverable afterwards (phaseOutputs are wiped and
  // the offending edit is hard-reset away). The regressing identity must be in the log.
  test("regression restore names the regressing keys in the log (#1382)", async () => {
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const record = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        {
          ...baseArgs,
          phaseOutputs,
          runRectify: async () => ({ rectificationExhausted: false }),
          keptTreeRegressed: () => ({
            regressed: true,
            regressedKeys: ["broke.test.ts::renders empty state"],
            memoExcludedKeys: [],
            baselineKeySize: 2,
            keyless: false,
          }),
        },
        fakeDeps,
      );
      return infoSpy.mock.calls.find((c) => String(c[1]).includes("kept tree regressed"));
    });

    expect(record).toBeDefined();
    const data = record?.[2] as Record<string, unknown>;
    expect(data.regressedKeys).toEqual(["broke.test.ts::renders empty state"]);
    expect(data.regressedKeyCount).toBe(1);
    expect(data.baselineKeySize).toBe(2);
    expect(data.keyless).toBe(false);
    // Structured-log convention: storyId is the FIRST key so parallel-mode runs stay
    // correlatable (.claude/rules/project-conventions.md).
    expect(Object.keys(data)[0]).toBe("storyId");
  });

  // #1401 — once the gate regression became visible to the cycle, a pass that spends
  // `regressionAttempts` and still fails exits EXHAUSTED, so the restore arrives on the
  // exhausted path instead of the keptTreeRegressed one above. Without a log there, the
  // #1382 diagnostic silently vanishes in the case that most warrants it: a regression
  // real enough to survive a repair attempt.
  test("exhausted restore also names the regressing keys when the gate is red (#1401)", async () => {
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: false } };
    const record = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        {
          ...baseArgs,
          phaseOutputs,
          // The repair attempt ran and failed — the cycle exhausted its budget.
          runRectify: async () => ({ rectificationExhausted: true }),
          keptTreeRegressed: () => ({
            regressed: true,
            regressedKeys: ["still-broke.test.ts::renders empty state"],
            memoExcludedKeys: [],
            baselineKeySize: 3,
            keyless: false,
          }),
        },
        fakeDeps,
      );
      return infoSpy.mock.calls.find((c) => String(c[1]).includes("exhausted with the full-suite gate red"));
    });

    expect(record).toBeDefined();
    const data = record?.[2] as Record<string, unknown>;
    expect(data.regressedKeys).toEqual(["still-broke.test.ts::renders empty state"]);
    expect(data.regressedKeyCount).toBe(1);
    expect(data.baselineKeySize).toBe(3);
    expect(data.keyless).toBe(false);
    expect(Object.keys(data)[0]).toBe("storyId");
  });

  test("exhausted restore stays quiet when the gate did NOT regress (ordinary exhaustion)", async () => {
    // Guards the log above from degrading into noise on every exhausted pass — the
    // common case is "the fix just didn't land", which has no gate regression to name.
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const record = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        {
          ...baseArgs,
          phaseOutputs,
          runRectify: async () => ({ rectificationExhausted: true }),
          keptTreeRegressed: () => ({
            regressed: false,
            regressedKeys: [],
            memoExcludedKeys: [],
            baselineKeySize: 0,
            keyless: false,
          }),
        },
        fakeDeps,
      );
      return infoSpy.mock.calls.find((c) => String(c[1]).includes("exhausted with the full-suite gate red"));
    });

    expect(record).toBeUndefined();
  });

  test("keyless regression is logged as such, with an empty key list (#1382)", async () => {
    // A timeout / execution-failure yields no comparable identity. The log must say so
    // rather than showing an empty `regressedKeys` that reads as "nothing regressed".
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        {
          ...baseArgs,
          phaseOutputs,
          runRectify: async () => ({ rectificationExhausted: false }),
          keptTreeRegressed: () => ({
            regressed: true,
            regressedKeys: [],
            memoExcludedKeys: [],
            baselineKeySize: 0,
            keyless: true,
          }),
        },
        fakeDeps,
      );
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("kept tree regressed"));
      return call?.[2] as Record<string, unknown>;
    });

    expect(data?.keyless).toBe(true);
    expect(data?.regressedKeys).toEqual([]);
    expect(data?.regressedKeyCount).toBe(0);
  });

  test("logged key list is capped, but the true count is reported (#1382)", async () => {
    // An unbounded key list can dwarf every other field in the JSONL record when a
    // whole suite goes red. Cap the sample; never lose the magnitude.
    const many = Array.from({ length: 25 }, (_, i) => `f${i}.test.ts::t${i}`);
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        {
          ...baseArgs,
          phaseOutputs,
          runRectify: async () => ({ rectificationExhausted: false }),
          keptTreeRegressed: () => ({
            regressed: true,
            regressedKeys: many,
            memoExcludedKeys: [],
            baselineKeySize: 0,
            keyless: false,
          }),
        },
        fakeDeps,
      );
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("kept tree regressed"));
      return call?.[2] as Record<string, unknown>;
    });

    expect((data?.regressedKeys as string[]).length).toBe(10);
    expect(data?.regressedKeyCount).toBe(25);
  });

  // Backward-compatible/no-probe path: diagnostics must report that triage did not run,
  // while preserving the count of failures excluded by an existing memo.
  test("restore log reports an untriaged pass and its memo exclusions", async () => {
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        {
          ...baseArgs,
          phaseOutputs,
          runRectify: async () => ({ rectificationExhausted: false }),
          keptTreeRegressed: () => ({
            regressed: true,
            regressedKeys: ["broke.test.ts::real"],
            memoExcludedKeys: ["flaky.test.ts::sometimes", "other.test.ts::rarely"],
            baselineKeySize: 0,
            keyless: false,
          }),
        },
        fakeDeps,
      );
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("kept tree regressed"));
      return call?.[2] as Record<string, unknown>;
    });

    expect(data?.memoExcludedKeyCount).toBe(2);
    // Stated so an operator can tell a possible flake from a proven break.
    expect(data?.flakeTriageRan).toBe(false);
    expect(data?.regressedKeys).toEqual(["broke.test.ts::real"]);
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
        captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
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
    const phaseCosts: Record<string, number> = { implementer: 0.1 };
    const res = await runNonBlockingFix(
      {
        ...baseArgs,
        phaseOutputs,
        phaseCosts,
        runRectify: async () => {
          phaseCosts.implementer = 0.35; // pass spent more
          phaseCosts["adversarial-review"] = 0.2; // and added a new phase
          return { rectificationExhausted: true };
        },
      },
      fakeDeps,
    );
    expect(res).toEqual({ ran: true, kept: false, restored: true });
    // Reverted to the entry snapshot — the discarded pass's cost is gone, the new key removed.
    expect(phaseCosts).toEqual({ implementer: 0.1 });
  });

  test("kept → phaseCosts retains the best-effort pass cost", async () => {
    // When the pass is kept (resolved, within cap), its cost is real work and stays.
    const phaseOutputs: Record<string, unknown> = { "full-suite-gate": { success: true } };
    const phaseCosts: Record<string, number> = { implementer: 0.1 };
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
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
    });
    expect(phases).toEqual(["verifier"]);
  });

  test("phases: scope 'triage' + verifierGuard false → []", () => {
    const phases = nonBlockingExtraPhases({
      enabled: true,
      scope: "triage",
      regressionAttempts: 1,
      verifierGuard: false,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
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
        captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
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
        captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
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
        captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
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
        captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
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
        captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
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

// ─── actionability filter (#1359) ─────────────────────────────────────────────

describe("actionableAdvisoryFindings", () => {
  const advisory = (overrides: Partial<Finding> = {}): Finding => ({
    source: "adversarial-review",
    severity: "warning",
    category: "input",
    message: "m",
    ...overrides,
  });

  test("drops findings the reviewer marked as requiring no action", () => {
    const kept = actionableAdvisoryFindings([
      advisory({ message: "real issue" }),
      advisory({ message: "compliance confirmation", actionRequired: false }),
    ]);
    expect(kept.map((f) => f.message)).toEqual(["real issue"]);
  });

  test("keeps findings that omit actionRequired — absent means actionable", () => {
    // Every producer predating #1359 omits the field; none of them may be dropped.
    expect(actionableAdvisoryFindings([advisory(), advisory({ actionRequired: true })])).toHaveLength(2);
  });

  test("an all-compliance advisory bucket closes the NBF gate", () => {
    // The observed US-004 case: one advisory finding, and it asked for nothing.
    // NBF must not open a paid pass for it.
    const cfg = {
      enabled: true,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
    } as const;
    const actionable = actionableAdvisoryFindings([advisory({ actionRequired: false })]);
    expect(shouldRunNonBlockingFix(cfg, actionable.length)).toBe(false);
  });
});

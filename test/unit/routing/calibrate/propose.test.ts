/**
 * proposeAdjustments — US-003 pure adjustment proposal logic
 *
 * Covers the 8 acceptance criteria for the calibration proposal step.
 * Threshold defaults mirror the upstream `config.autoRoute` schema:
 *   minSamples: 8
 *   upgradeEscalationRate: 0.3
 *   upgradeMismatchRate: 0.25
 *   downgradeEscalationRate: 0.05
 *   downgradeFirstPassRate: 0.9
 *
 * Final-tiers must lie within the built-in ladder fast -> balanced -> powerful.
 * Only one rung may move per adjustment.
 */

import { describe, expect, test } from "bun:test";
import type { Complexity, ModelTier } from "@/config/schema-types";
import { proposeAdjustments } from "@/routing/calibrate/propose";
import type {
  BandStat,
  CalibrationProposal,
  CalibrationThresholds,
  KeywordHint,
  SkippedBand,
  TierAdjustment,
} from "@/routing/calibrate/types";

const DEFAULT_THRESHOLDS: Required<CalibrationThresholds> = {
  minSamples: 8,
  upgradeEscalationRate: 0.3,
  upgradeMismatchRate: 0.25,
  downgradeEscalationRate: 0.05,
  downgradeFirstPassRate: 0.9,
};

const MAPPING: Record<Complexity, ModelTier> = {
  simple: "fast",
  medium: "balanced",
  complex: "powerful",
  expert: "powerful",
};

function band(overrides: Partial<BandStat>): BandStat {
  return {
    complexity: "simple",
    sampleCount: 10,
    escalationRate: 0,
    firstPassRate: 1,
    mismatchRate: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1: high escalation + mismatch → upgrade one rung
// ---------------------------------------------------------------------------

describe("proposeAdjustments - upgrade path", () => {
  test("AC-1: simple/fast with escalationRate=0.4 + mismatchRate=0.3 → upgrade to balanced", () => {
    const stats: BandStat[] = [
      band({
        complexity: "simple",
        sampleCount: 10,
        escalationRate: 0.4,
        mismatchRate: 0.3,
        firstPassRate: 0.6,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    const adjustment = proposal.adjustments.find((a) => a.band === "simple");
    expect(adjustment).toBeDefined();
    expect(adjustment?.from).toBe("fast");
    expect(adjustment?.to).toBe("balanced");
    expect(adjustment?.direction).toBe("upgrade");
  });
});

// ---------------------------------------------------------------------------
// AC-2: high firstPassRate + low escalation + tier usage below current
//       → downgrade one rung
// ---------------------------------------------------------------------------

describe("proposeAdjustments - downgrade path", () => {
  test("AC-2: complex/powerful band with firstPassRate=0.95, escalationRate=0.02, observed finalTiers all at or below balanced → downgrade to balanced", () => {
    // AC-2 scenario: the band consistently lands at or below balanced even
    // though the mapping says powerful — encoded by mismatchRate ≈ 1 (every
    // observed run's finalTier differs from the mapped powerful tier, and the
    // observed finalTiers sit at balanced or below).
    const stats: BandStat[] = [
      band({
        complexity: "complex",
        sampleCount: 20,
        firstPassRate: 0.95,
        escalationRate: 0.02,
        mismatchRate: 1,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    const adjustment = proposal.adjustments.find((a) => a.band === "complex");
    expect(adjustment).toBeDefined();
    expect(adjustment?.to).toBe("balanced");
    expect(adjustment?.direction).toBe("downgrade");
  });

  test("AC-2 negative control: complex/powerful band with observed finalTiers at powerful (mismatchRate=0) → no downgrade", () => {
    // Same band, same firstPassRate and escalationRate as AC-2, but observed
    // finalTiers all stayed at powerful (mismatchRate=0). The AC requires the
    // downgrade to hinge on the observed-tier condition, so this band must NOT
    // be downgraded even though the scalar rates alone would qualify.
    const stats: BandStat[] = [
      band({
        complexity: "complex",
        sampleCount: 20,
        firstPassRate: 0.95,
        escalationRate: 0.02,
        mismatchRate: 0,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    expect(proposal.adjustments.find((a) => a.band === "complex")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-3: sampleCount below minSamples → skip
// ---------------------------------------------------------------------------

describe("proposeAdjustments - skipped bands", () => {
  test("AC-3: sampleCount below minSamples → skipped with sampleCount + minSamples", () => {
    const stats: BandStat[] = [
      band({
        complexity: "simple",
        sampleCount: 3,
        escalationRate: 0.9,
        mismatchRate: 0.9,
        firstPassRate: 0.1,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, { ...DEFAULT_THRESHOLDS, minSamples: 8 });

    expect(proposal.adjustments.find((a) => a.band === "simple")).toBeUndefined();
    const skipped = proposal.skipped.find((s) => s.complexity === "simple");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toBe("insufficient-samples");
    expect(skipped?.sampleCount).toBe(3);
    expect(skipped?.minSamples).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// AC-4: already on fast and downgrade criteria met → no downgrade
// AC-5: already on powerful and upgrade criteria met → no upgrade
// ---------------------------------------------------------------------------

describe("proposeAdjustments - boundary clamps", () => {
  test("AC-4: already mapped to 'fast' and downgrade criteria met → no downgrade", () => {
    const stats: BandStat[] = [
      band({
        complexity: "expert",
        sampleCount: 20,
        firstPassRate: 0.99,
        escalationRate: 0,
        mismatchRate: 1,
      }),
    ];
    // expert → fast. Downgrade criteria met, but already at floor → no move.
    const mapping: Record<Complexity, ModelTier> = {
      ...MAPPING,
      expert: "fast",
    };

    const proposal = proposeAdjustments(stats, mapping, DEFAULT_THRESHOLDS);

    expect(proposal.adjustments.find((a) => a.band === "expert" && a.direction === "downgrade")).toBeUndefined();
  });

  test("AC-5: already mapped to 'powerful' and upgrade criteria met → no upgrade", () => {
    const stats: BandStat[] = [
      band({
        complexity: "expert",
        sampleCount: 20,
        escalationRate: 1,
        mismatchRate: 1,
        firstPassRate: 0,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    expect(proposal.adjustments.find((a) => a.band === "expert" && a.direction === "upgrade")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-6: extreme bad band → only one rung (clamp at one rung)
// ---------------------------------------------------------------------------

describe("proposeAdjustments - one-rung clamp", () => {
  test("AC-6: simple/fast with escalationRate=0.9 + mismatchRate=0.9 → propose balanced, not powerful", () => {
    const stats: BandStat[] = [
      band({
        complexity: "simple",
        sampleCount: 20,
        escalationRate: 0.9,
        mismatchRate: 0.9,
        firstPassRate: 0.1,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    const adjustment = proposal.adjustments.find((a) => a.band === "simple");
    expect(adjustment).toBeDefined();
    expect(adjustment?.to).toBe("balanced");
    expect(adjustment?.to).not.toBe("powerful");
    expect(adjustment?.direction).toBe("upgrade");
  });
});

// ---------------------------------------------------------------------------
// AC-7: below upgrade triggers AND below firstPassFloor → no adjustment
// ---------------------------------------------------------------------------

describe("proposeAdjustments - no adjustment", () => {
  test("AC-7: escalationRate=0.15 and firstPassRate=0.7 → no adjustment", () => {
    const stats: BandStat[] = [
      band({
        complexity: "medium",
        sampleCount: 10,
        escalationRate: 0.15,
        firstPassRate: 0.7,
        mismatchRate: 0.1,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    expect(proposal.adjustments.find((a) => a.band === "medium")).toBeUndefined();
    expect(proposal.skipped.find((s) => s.complexity === "medium")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-8: large sample + high mismatch → KeywordHint referencing classify.ts
//       and exposes no from/to field
// ---------------------------------------------------------------------------

describe("proposeAdjustments - keyword hints", () => {
  test("AC-8: large sample + high mismatch → emits a KeywordHint referencing classify.ts without from/to", () => {
    const stats: BandStat[] = [
      band({
        complexity: "complex",
        sampleCount: 50,
        escalationRate: 0.6,
        mismatchRate: 0.8,
        firstPassRate: 0.2,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    const hint = proposal.hints[0];
    expect(hint).toBeDefined();
    expect(typeof hint.message).toBe("string");
    expect(hint.message).toContain("classify.ts");
    // KeywordHint is just an advisory signal — it must not carry a tier move.
    const typedHint = hint as KeywordHint & { from?: unknown; to?: unknown };
    expect(typedHint.from).toBeUndefined();
    expect(typedHint.to).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Type-surface regression: existing types still compose with the new helper
// ---------------------------------------------------------------------------

describe("proposeAdjustments - type surface", () => {
  test("returns a CalibrationProposal compatible with the shared types", () => {
    const stats: BandStat[] = [
      band({
        complexity: "simple",
        sampleCount: 20,
        escalationRate: 0.5,
        mismatchRate: 0.4,
        firstPassRate: 0.5,
      }),
    ];

    const proposal: CalibrationProposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);
    const _: {
      adjustments: TierAdjustment[];
      hints: KeywordHint[];
      skipped: SkippedBand[];
      bandStats: BandStat[];
    } = proposal;
    expect(_).toBe(proposal);
  });
});

// ---------------------------------------------------------------------------
// Adversarial-rectification regressions: pin the asymmetric threshold split
// and the purity guarantees of the helper.
// ---------------------------------------------------------------------------

describe("proposeAdjustments - asymmetric triggers (adversarial #1)", () => {
  test("upgrade and downgrade use distinct escalation triggers; an intermediate escalation rate that satisfies the upgrade trigger does not satisfy the downgrade ceiling", () => {
    // At escalationRate=0.15 (between 0.05 and 0.3), a "balanced"-mapped
    // band that is mostly first-passing (firstPassRate=0.95) and observing
    // mismatches must NOT be downgraded — the band IS escalating enough to
    // require its current tier. With a single shared trigger this would have
    // been an over-downgrade.
    const stats: BandStat[] = [
      band({
        complexity: "medium",
        sampleCount: 20,
        escalationRate: 0.15,
        firstPassRate: 0.95,
        mismatchRate: 0.6,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    expect(proposal.adjustments.find((a) => a.band === "medium" && a.direction === "downgrade")).toBeUndefined();
  });
});

describe("proposeAdjustments - direction-of-mismatches safeguard (adversarial #2)", () => {
  test("balanced band whose escalations push finalTier above the mapping does NOT downgrade", () => {
    // A balanced-mapped band that frequently escalates to powerful has a
    // mismatchRate > 0 (mismatches go upward) and a high firstPassRate at the
    // current tier — without the asymmetry gate its mismatch signal would
    // look indistinguishable from AC-2's under-utilized band. The downgrade
    // must be blocked by escalationRate > downgradeEscalationRate.
    const stats: BandStat[] = [
      band({
        complexity: "medium",
        sampleCount: 25,
        escalationRate: 0.25,
        firstPassRate: 0.95,
        mismatchRate: 0.4,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    expect(proposal.adjustments.find((a) => a.band === "medium" && a.direction === "downgrade")).toBeUndefined();
  });
});

describe("proposeAdjustments - hint threshold flows from caller (adversarial #3)", () => {
  test("a caller-supplied upgradeMismatchRate shifts the hint emission boundary", () => {
    const stats: BandStat[] = [
      band({
        complexity: "simple",
        sampleCount: 20,
        escalationRate: 0.5,
        firstPassRate: 0.5,
        mismatchRate: 0.3,
      }),
    ];

    // Default (0.25) → hint fires.
    const atDefault = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);
    expect(atDefault.hints.length).toBe(1);

    // Raised caller threshold (0.5) → hint does NOT fire even though
    // mismatchRate=0.3 still satisfies AC-1's upgrade (escalationRate=0.5
    // also meets the bumped upgrade trigger). This proves the threshold is
    // a single source of truth for both adjustments AND hints.
    const raised: CalibrationThresholds = { upgradeMismatchRate: 0.5 };
    const atRaised = proposeAdjustments(stats, MAPPING, raised);
    expect(atRaised.hints.length).toBe(0);
  });
});

describe("proposeAdjustments - purity (adversarial #4)", () => {
  test("identical inputs produce identical outputs (no wall-clock reads)", () => {
    const stats: BandStat[] = [
      band({
        complexity: "simple",
        sampleCount: 20,
        escalationRate: 0.4,
        mismatchRate: 0.3,
        firstPassRate: 0.6,
      }),
    ];

    const a = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);
    const b = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    expect(a).toEqual(b);
    expect(a.generatedAt).toBe("");
  });
});

describe("@/routing/calibrate barrel (adversarial #5)", () => {
  test("re-exports proposeAdjustments and the calibration types", () => {
    // Runtime surface guard: a broken barrel can ship green otherwise.
    const surface = require("@/routing/calibrate") as Record<string, unknown>;

    expect(typeof surface.proposeAdjustments).toBe("function");

    // Type-only references are checked by tsc; we still exercise them so the
    // symbols are actually imported (no `unused import` elimination).
    const _: {
      proposeAdjustments: typeof proposeAdjustments;
      BandStat: BandStat;
      TierAdjustment: TierAdjustment;
      KeywordHint: KeywordHint;
      SkippedBand: SkippedBand;
      CalibrationProposal: CalibrationProposal;
      CalibrationThresholds: CalibrationThresholds;
    } = {} as never;
    expect(_).toBeDefined();
  });
});

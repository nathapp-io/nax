/**
 * proposeAdjustments — US-003 pure adjustment proposal logic
 *
 * Covers the 8 acceptance criteria for the calibration proposal step.
 * All thresholds default to the upstream autoRoute values:
 *   minSamples: 8
 *   escalationTrigger: 0.3
 *   mismatchTrigger: 0.25
 *   firstPassFloor: 0.9
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
  escalationTrigger: 0.3,
  mismatchTrigger: 0.25,
  firstPassFloor: 0.9,
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
  test("AC-2: complex/powerful band with firstPassRate=0.95, escalationRate=0.02 → downgrade to balanced", () => {
    const stats: BandStat[] = [
      band({
        complexity: "complex",
        sampleCount: 20,
        firstPassRate: 0.95,
        escalationRate: 0.02,
        mismatchRate: 0.95,
      }),
    ];

    const proposal = proposeAdjustments(stats, MAPPING, DEFAULT_THRESHOLDS);

    const adjustment = proposal.adjustments.find((a) => a.band === "complex");
    expect(adjustment).toBeDefined();
    expect(adjustment?.to).toBe("balanced");
    expect(adjustment?.direction).toBe("downgrade");
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

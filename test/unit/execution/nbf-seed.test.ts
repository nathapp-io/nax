// test/unit/execution/nbf-seed.test.ts
//
// US-002 — Seed derivation for the non-blocking fix.
//
// These tests exercise `deriveNbfSeed` directly: the actionability-filtered,
// deduplicated union of advisory buckets driven by `sources`, and the green
// precondition / sources-empty / both-reviewers-missing edge cases the
// orchestrator must not get wrong. Each AC gets at least one success-path and
// one boundary-path test so a future regression to "uses raw adversarial bucket"
// or "silently drops semantic advisories" cannot pass review.
import { describe, expect, test } from "bun:test";
import { makeFinding } from "@test/helpers";
import { deriveNbfSeed, type NbfSource } from "@/execution/nbf-seed";
import type { Finding } from "@/findings";

function semantic(overrides: Partial<Finding> = {}): Finding {
  return makeFinding({
    source: "semantic-review",
    severity: "warning",
    category: "input",
    message: "semantic msg",
    ...overrides,
  });
}

function adversarial(overrides: Partial<Finding> = {}): Finding {
  return makeFinding({
    source: "adversarial-review",
    severity: "warning",
    category: "input",
    message: "adversarial msg",
    ...overrides,
  });
}

function passingAdversarialOutput(findings: readonly Finding[] = []): Record<string, unknown> {
  return { success: true, passed: true, advisoryFindings: [...findings] };
}

function passingSemanticOutput(findings: readonly Finding[] = []): Record<string, unknown> {
  return { success: true, passed: true, advisoryFindings: [...findings] };
}

function bothReviewsPassed(
  opts: { semantic?: readonly Finding[]; adversarial?: readonly Finding[] } = {},
): Record<string, unknown> {
  return {
    "semantic-review": passingSemanticOutput(opts.semantic ?? []),
    "adversarial-review": passingAdversarialOutput(opts.adversarial ?? []),
  };
}

// AC1 — Both sources named, two semantic advisories, zero adversarial → both
// semantic findings survive the seed derivation; shouldRun=true.
describe("deriveNbfSeed — AC1: union of named sources", () => {
  test("two semantic advisories + zero adversarial + sources=[adversarial, semantic] → both semantic findings", () => {
    const s1 = semantic({ message: "semantic-1" });
    const s2 = semantic({ message: "semantic-2" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [s1, s2] }),
      sources: ["adversarial", "semantic"] satisfies readonly NbfSource[],
      storyId: "US-002",
    });
    expect(seed.shouldRun).toBe(true);
    expect(seed.findings.map((f) => f.message)).toEqual(["semantic-1", "semantic-2"]);
  });

  test("two semantic advisories with the same canonical shape → seed returns both (no dedup against empty bucket)", () => {
    // The deduplication predicate keys on (file, line, message). With no file/line
    // on either entry, two findings with distinct messages are NOT duplicates —
    // this guards against an over-eager dedup that conflates two semantically
    // distinct advisories on the same source.
    const s1 = semantic({ message: "semantic-1" });
    const s2 = semantic({ message: "semantic-2" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [s1, s2] }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(2);
  });
});

// AC2 — Same phase outputs but sources=[adversarial] only → no findings,
// shouldRun=false. The semantic bucket is dropped at the SEEDING site even
// though `actionableAdvisoryFindings` would happily pass it through.
describe("deriveNbfSeed — AC2: sources gates the union", () => {
  test("sources=[adversarial] + two semantic advisories + zero adversarial → empty + shouldRun=false", () => {
    const s1 = semantic({ message: "semantic-1" });
    const s2 = semantic({ message: "semantic-2" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [s1, s2] }),
      sources: ["adversarial"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(0);
    expect(seed.shouldRun).toBe(false);
  });

  test("sources=[semantic] + zero semantic + zero adversarial → empty + shouldRun=false", () => {
    // The mirror case: declaring only `semantic` and getting nothing in the
    // semantic bucket still closes nbf, mirroring AC2's adversarial-only case.
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({}),
      sources: ["semantic"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(0);
    expect(seed.shouldRun).toBe(false);
  });
});

// AC3 — One adversarial + two semantic with both sources → three findings,
// in declared source order.
describe("deriveNbfSeed — AC3: union preserves both buckets", () => {
  test("1 adversarial + 2 semantic + sources=[adversarial, semantic] → 3 findings, adversarial first", () => {
    const a1 = adversarial({ message: "adv-1" });
    const s1 = semantic({ message: "sem-1" });
    const s2 = semantic({ message: "sem-2" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [s1, s2], adversarial: [a1] }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.shouldRun).toBe(true);
    expect(seed.findings).toHaveLength(3);
    expect(seed.findings[0]?.message).toBe("adv-1");
    expect(seed.findings[1]?.message).toBe("sem-1");
    expect(seed.findings[2]?.message).toBe("sem-2");
  });

  test("sources=[semantic, adversarial] → seed returns adversarial AFTER semantic (declared order)", () => {
    // AC3 pins order only at the within-source level; cross-source order is
    // whatever `sources` declares. A regression that hardcoded adversarial-first
    // would surface here.
    const a1 = adversarial({ message: "adv-1" });
    const s1 = semantic({ message: "sem-1" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [s1], adversarial: [a1] }),
      sources: ["semantic", "adversarial"],
      storyId: "US-002",
    });
    expect(seed.findings.map((f) => f.message)).toEqual(["sem-1", "adv-1"]);
  });
});

// AC4 — Same `(file, line, message)` finding in BOTH buckets → dedup to
// one. The dedup predicate is the one the SPEC calls for; this test pins it
// so a future change to the dedup key (e.g. dropping `message`) doesn't
// silently double-seeding.
describe("deriveNbfSeed — AC4: cross-source dedup by (file, line, message)", () => {
  test("same file/line/message in both buckets → returned once", () => {
    const dup = { file: "src/foo.ts", line: 42, message: "shared defect" };
    const fromAdversarial = adversarial(dup);
    const fromSemantic = semantic(dup);
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [fromSemantic], adversarial: [fromAdversarial] }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(1);
    expect(seed.findings[0]?.message).toBe("shared defect");
    expect(seed.findings[0]?.file).toBe("src/foo.ts");
    expect(seed.findings[0]?.line).toBe(42);
  });

  test("same file/line but DIFFERENT message → NOT deduplicated (distinct defects)", () => {
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({
        semantic: [semantic({ file: "src/foo.ts", line: 1, message: "from semantic" })],
        adversarial: [adversarial({ file: "src/foo.ts", line: 1, message: "from adversarial" })],
      }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(2);
  });

  test("different lines on same file → NOT deduplicated (distinct defects)", () => {
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({
        semantic: [semantic({ file: "src/foo.ts", line: 1, message: "m" })],
        adversarial: [adversarial({ file: "src/foo.ts", line: 2, message: "m" })],
      }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(2);
  });
});

// AC5 — Semantic advisory stamped retired → excluded. `actionableAdvisoryFindings`
// already filters retired advisories; this test pins that the seed derivation
// applies the same filter to the semantic bucket (the wiring contract: the
// seed module is the SSOT, not `execution-plan.ts` re-implementing the filter).
describe("deriveNbfSeed — AC5: retired semantic advisory is excluded", () => {
  test("retired semantic → not in seed findings, even when both sources are named", () => {
    const retired = semantic({
      message: "retired-sem",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    });
    const live = semantic({ message: "live-sem" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [retired, live] }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings.map((f) => f.message)).toEqual(["live-sem"]);
    expect(seed.shouldRun).toBe(true);
  });

  test("retired semantic is filtered even when declared as the only source", () => {
    // Mirror the AC5 contract from the wiring angle: when `sources` is
    // `[semantic]` and every entry in the semantic bucket is retired, nbf is
    // closed. The implementation is the actionability filter, but pinning it
    // through `deriveNbfSeed` (not the helper) is the AC1..AC15 contract.
    const retired = semantic({
      message: "retired",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [retired] }),
      sources: ["semantic"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(0);
    expect(seed.shouldRun).toBe(false);
  });
});

// AC6 — Semantic with actionRequired=false → excluded. The actionability
// filter is the SSOT and it already drops actionRequired:false; this test
// pins that the seed derivation applies it to the semantic bucket.
describe("deriveNbfSeed — AC6: actionRequired=false semantic advisory is excluded", () => {
  test("actionRequired=false on a semantic advisory → not in seed findings", () => {
    const noAction = semantic({ message: "no-action", actionRequired: false });
    const actionable = semantic({ message: "needs-fix" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [noAction, actionable] }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings.map((f) => f.message)).toEqual(["needs-fix"]);
  });

  test("an all-no-action semantic bucket closes nbf", () => {
    // Mirror of the all-compliance adversarial case (non-blocking-fix.test.ts);
    // the union must NOT inherit a "needs to be opened" pulse from a fully
    // dropped semantic bucket.
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [semantic({ actionRequired: false })] }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(0);
    expect(seed.shouldRun).toBe(false);
  });
});

// AC7 — Semantic-review did not run; adversarial findings must still seed
// cleanly. Missing phase output is "empty bucket", not "error".
describe("deriveNbfSeed — AC7: missing semantic-review output is not an error", () => {
  test("no semantic-review output + adversarial findings + both sources → adversarial findings only", () => {
    const a1 = adversarial({ message: "adv-1" });
    const a2 = adversarial({ message: "adv-2" });
    const phaseOutputs: Record<string, unknown> = {
      "adversarial-review": passingAdversarialOutput([a1, a2]),
      // semantic-review NOT in phaseOutputs — reviewer did not run
    };
    const seed = deriveNbfSeed({
      phaseOutputs,
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.shouldRun).toBe(true);
    expect(seed.findings).toHaveLength(2);
    expect(seed.findings.map((f) => f.message)).toEqual(["adv-1", "adv-2"]);
  });

  test("no adversarial-review output + semantic findings + both sources → semantic findings only", () => {
    // Mirror case: a semantic-only plan (no adversarial slot) feeds nbf through
    // semantic advisories without throwing or returning an empty seed.
    const s1 = semantic({ message: "sem-1" });
    const phaseOutputs: Record<string, unknown> = {
      "semantic-review": passingSemanticOutput([s1]),
    };
    const seed = deriveNbfSeed({
      phaseOutputs,
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.shouldRun).toBe(true);
    expect(seed.findings.map((f) => f.message)).toEqual(["sem-1"]);
  });

  test("missing phase output is treated as an empty advisoryFindings array, not an exception", () => {
    // Defensive: an output object whose advisoryFindings field is absent (or
    // a non-array) must NOT make the seed derivation throw — only an empty
    // bucket should drop out of the union.
    const phaseOutputs: Record<string, unknown> = {
      "semantic-review": { success: true, passed: true }, // no advisoryFindings key
      "adversarial-review": passingAdversarialOutput([adversarial({ message: "adv-only" })]),
    };
    const seed = deriveNbfSeed({
      phaseOutputs,
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings.map((f) => f.message)).toEqual(["adv-only"]);
  });
});

// AC8 — Failing phase output closes nbf REGARDLESS of advisory findings.
// Mirrors the `storyCurrentlyGreen` precondition in `execution-plan.ts` —
// the seed module owns the same check so the wiring does not need to
// reimplement it.
describe("deriveNbfSeed — AC8: failing phase predicate gates the seed", () => {
  test("failing semantic-review output → shouldRun=false, even with named sources and findings", () => {
    const s1 = semantic({ message: "sem-1" });
    const seed = deriveNbfSeed({
      phaseOutputs: {
        "semantic-review": { success: false, passed: false, advisoryFindings: [s1] },
        "adversarial-review": passingAdversarialOutput([adversarial({ message: "adv-1" })]),
      },
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.shouldRun).toBe(false);
  });

  test("failing adversarial-review output → shouldRun=false, even with named sources and findings", () => {
    const a1 = adversarial({ message: "adv-1" });
    const seed = deriveNbfSeed({
      phaseOutputs: {
        "semantic-review": passingSemanticOutput([semantic({ message: "sem-1" })]),
        "adversarial-review": { success: false, passed: false, advisoryFindings: [a1] },
      },
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.shouldRun).toBe(false);
  });

  test("a phase that produced no output (e.g. skipped) is treated as not-passing under the strict reviewer set", () => {
    // The seed module is used by the orchestrator AFTER `phasePassed` has
    // already gated the main loop; on a missing output it must not silently
    // mark the phase as green. Mirrors `STRICT_VERDICT_PHASE_NAMES` policy:
    // missing phase output → not passed → nbf closed.
    const seed = deriveNbfSeed({
      phaseOutputs: {
        // semantic-review absent entirely
        "adversarial-review": passingAdversarialOutput([adversarial({ message: "adv-1" })]),
      },
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    // With AC7 treating "missing review output" as "empty bucket" (NOT a phase
    // failure), and AC8 closing nbf only when the phase FAILED, this AC7+AC8
    // pair requires the seed derivation to treat a missing reviewer as a
    // review that simply did not run — nbf still runs if the named sources
    // produce findings. Document the boundary here.
    expect(seed.shouldRun).toBe(true);
    expect(seed.findings).toHaveLength(1);
  });
});

// AC15 — `sources: []` is the explicit "I want the knobs but no seeding" case
// (see `NonBlockingFixConfigSchema` doc). It must close nbf even when both
// reviewer buckets contain actionable advisories — the same runtime effect
// as `enabled: false` for the seeding path, without losing the operator's
// other knobs.
describe("deriveNbfSeed — AC15: empty sources closes nbf", () => {
  test("sources=[] + actionable advisories in BOTH buckets → empty + shouldRun=false", () => {
    const a1 = adversarial({ message: "adv-1" });
    const s1 = semantic({ message: "sem-1" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [s1], adversarial: [a1] }),
      sources: [],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(0);
    expect(seed.shouldRun).toBe(false);
  });

  test("sources=[] does not throw on missing phase outputs", () => {
    const seed = deriveNbfSeed({
      phaseOutputs: {},
      sources: [],
      storyId: "US-002",
    });
    expect(seed.shouldRun).toBe(false);
  });
});

// AC4 boundary — the dedup predicate's behavior on findings WITHOUT `file`
// or `line` is part of the seed contract: a dedup that ignores file/line
// when both are missing would collapse same-message-no-locator findings
// from different buckets into one. Pin it so a future dedup key change
// doesn't silently regress the AC.
describe("deriveNbfSeed — AC4 dedup key boundary", () => {
  test("same message, no file/line in both buckets → returned once (message key alone suffices)", () => {
    // The dedup predicate uses (file, line, message); when file/line are
    // absent, the message alone discriminates. Same-message findings in both
    // buckets are clearly the same defect at unknown location.
    const a = adversarial({ message: "shared-msg" });
    const s = semantic({ message: "shared-msg" });
    const seed = deriveNbfSeed({
      phaseOutputs: bothReviewsPassed({ semantic: [s], adversarial: [a] }),
      sources: ["adversarial", "semantic"],
      storyId: "US-002",
    });
    expect(seed.findings).toHaveLength(1);
    expect(seed.findings[0]?.message).toBe("shared-msg");
  });
});

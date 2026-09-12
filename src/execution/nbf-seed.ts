/**
 * US-002 — Non-blocking fix seed derivation.
 *
 * Pure function that takes the phase-completion state (`phaseOutputs`) and the
 * `sources` list declared by `review.nonBlockingFix.sources`, and produces
 * the actionability-filtered, deduplicated union of advisory buckets plus a
 * `shouldRun` verdict.
 *
 * Splitting this out of `execution-plan.ts` was load-bearing, not stylistic:
 * that file is exactly 600 lines (the `SRC_LIMIT` enforced by
 * `scripts/check-file-sizes.ts`), and is not grandfathered in
 * `scripts/baselines/file-sizes-baseline.json` — zero headroom, any added
 * line fails the ratchet. The extraction also gives a single seam to unit-test
 * the mixed-threshold / semantic-advisory seeding behaviour without booting
 * the full orchestrator.
 *
 * Behavior:
 *   - Reads advisory buckets from `phaseOutputs["semantic-review"]` and
 *     `phaseOutputs["adversarial-review"]`, in `sources` declared order.
 *   - Each bucket is filtered through `actionableAdvisoryFindings` (drops
 *     `actionRequired === false`, `acDropped === true`, and any retired stamp).
 *   - The two (or zero) filtered buckets are concatenated and deduplicated by
 *     `(file, line, message)`. `actionableAdvisoryFindings` filters on
 *     `actionRequired`, `acDropped`, and recurrence-retirement ONLY — never
 *     on `category`, so an adversarial `out-of-scope` finding is seeded today
 *     and still will be after the union.
 *   - A phase that failed the `phasePassed` predicate (green precondition)
 *     gates the whole seed to "do not run" — nbf's restore-to-adversarial-passed
 *     floor is meaningless when the entry state is red. Mirrors the
 *     `storyCurrentlyGreen` check in `execution-plan.ts`.
 *   - Missing phase outputs (the reviewer did not run) are treated as empty
 *     buckets, not as errors.
 */
import type { NonBlockingFixConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { actionableAdvisoryFindings } from "./non-blocking-fix";

/** A reviewer whose advisory bucket the seed derivation may pull from. */
export type NbfSource = "adversarial" | "semantic";

/**
 * Map of phase output name → phase output value, mirroring what
 * `ExecutionPlan.run` keeps in `phaseOutputs`. Typed loosely so the seed
 * derivation does not depend on the orchestrator's exact `Record<string,
 * unknown>` shape.
 */
export type PhaseOutputsLike = Record<string, unknown>;

/** Output of `deriveNbfSeed`. */
export interface NbfSeed {
  /** Actionability-filtered, deduplicated, in-`sources`-order findings. */
  readonly findings: readonly Finding[];
  /**
   * Whether nbf should run. False when:
   *   - any required phase output fails the `phasePassed` predicate, OR
   *   - `sources` is empty, OR
   *   - no findings survive the actionability + deduplication filters.
   */
  readonly shouldRun: boolean;
}

export interface DeriveNbfSeedInput {
  phaseOutputs: PhaseOutputsLike;
  sources: readonly NbfSource[];
  /** Required for the green precondition (phasePassed gates run). */
  storyId?: string;
}

/** Phase name for each named source. */
const SOURCE_TO_PHASE: Readonly<Record<NbfSource, string>> = Object.freeze({
  adversarial: "adversarial-review",
  semantic: "semantic-review",
});

/** A phase output shape carrying an `advisoryFindings` array. */
interface AdvisoryFindingsCarrier {
  advisoryFindings?: readonly Finding[];
}

function readAdvisoryBucket(output: unknown): readonly Finding[] {
  if (output === null || output === undefined || typeof output !== "object") return [];
  const r = output as AdvisoryFindingsCarrier;
  return Array.isArray(r.advisoryFindings) ? r.advisoryFindings : [];
}

/**
 * Defensive shape match for an op's success/passed verdict, mirroring the
 * defensive behaviour of `phasePassed` for the reviewer phases (which are NOT
 * in `STRICT_VERDICT_PHASE_NAMES`). A missing output passes the predicate —
 * the reviewer simply did not run. A present output that carries neither
 * `success` nor `passed` defaults to passing.
 */
function isPhasePassedLike(opName: string, output: unknown, storyId: string | undefined): boolean {
  if (output === null || output === undefined) return true;
  if (typeof output !== "object") return true;
  const r = output as Record<string, unknown>;
  if ("success" in r) return r.success !== false;
  if ("passed" in r) return r.passed !== false;
  // No verdict field — defer to phasePassed's defensive default (reviewers are
  // non-strict, so a malformed envelope passes rather than failing closed).
  void opName;
  void storyId;
  return true;
}

/** Build the (file, line, message) dedup key. Missing file/line collapses to message-only. */
function dedupKey(f: Finding): string {
  return JSON.stringify([f.file ?? null, f.line ?? null, f.message]);
}

/**
 * Union of actionable advisory findings across the declared sources,
 * deduplicated by (file, line, message) and gated on the green precondition
 * (no phase that produced output may have failed).
 *
 * Returns `{ findings, shouldRun }`. `shouldRun` is false when:
 *   - `sources` is empty (explicit no-seed),
 *   - any phase output (not just the named sources) fails `phasePassed`
 *     (AC8 — red tree, do not act; mirrors `storyCurrentlyGreen`),
 *   - or no findings survive actionability + dedup.
 */
export function deriveNbfSeed(input: DeriveNbfSeedInput): NbfSeed {
  const { phaseOutputs, sources, storyId } = input;

  if (sources.length === 0) {
    return { findings: [], shouldRun: false };
  }

  // AC8 — green precondition: EVERY phase that produced output must have
  // passed. A failing non-source phase (e.g. full-suite-gate, verifier,
  // lint-check, typecheck-check) closes nbf regardless of advisory findings,
  // mirroring `storyCurrentlyGreen` in `execution-plan.ts`. Phases absent
  // from `phaseOutputs` (the reviewer did not run) are skipped — they
  // aren't "failed", they simply weren't dispatched.
  for (const [name, output] of Object.entries(phaseOutputs)) {
    if (!isPhasePassedLike(name, output, storyId)) {
      return { findings: [], shouldRun: false };
    }
  }

  // First pass: read each declared source's advisory bucket. A missing
  // reviewer output is "did not run" (empty bucket, not a failure — mirrors
  // `phasePassed`'s defensive behaviour for non-strict reviewers).
  const buckets: Finding[][] = [];
  for (const source of sources) {
    const phaseName = SOURCE_TO_PHASE[source];
    const output = phaseOutputs[phaseName];
    if (output === undefined) {
      buckets.push([]);
      continue;
    }
    buckets.push([...actionableAdvisoryFindings(readAdvisoryBucket(output))]);
  }

  // Second pass: concatenate in declared source order, dedup by (file, line,
  // message). First occurrence wins so declared order is preserved.
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const bucket of buckets) {
    for (const f of bucket) {
      const key = dedupKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
  }

  return { findings, shouldRun: findings.length > 0 };
}

/** Re-export `NonBlockingFixConfig` for type-only consumers. */
export type { NonBlockingFixConfig };
/** Re-export `actionableAdvisoryFindings` so tests can target a single import. */
export { actionableAdvisoryFindings };

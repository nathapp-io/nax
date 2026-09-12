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
 *
 * Implementation lives here in session 1 (this file is a STUB). The
 * orchestrator-side wiring call site is updated in session 2.
 */
import type { NonBlockingFixConfig } from "../config/selectors";
import { NaxError } from "../errors";
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

export function deriveNbfSeed(_input: DeriveNbfSeedInput): NbfSeed {
  // STUB — implemented in session 2. Throws so the AC1..AC15 tests fail with
  // an assertion-level error (the test reaches the call, the function then
  // surfaces "not implemented"); a silently-empty seed would let every AC
  // pass without exercising the real logic.
  throw new NaxError("[nbf-seed] deriveNbfSeed not implemented", "NOT_IMPLEMENTED", { stage: "nbf-seed" });
}

/** Re-export `NonBlockingFixConfig` for type-only consumers. */
export type { NonBlockingFixConfig };
/** Re-export `actionableAdvisoryFindings` so tests can target a single import. */
export { actionableAdvisoryFindings };

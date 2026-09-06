import type { TurnResult } from "../agents/types";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import type { HopBodyContext } from "./types";

/**
 * One disk-keyed self-heal step inside a `hopBody`. The deviation type `D` is
 * captured inside `makeSelfHealStep` and erased here, so heterogeneous steps
 * (different `D` per step) compose in a single `runSelfHealChain` array without
 * `any`.
 */
export interface SelfHealStep<I> {
  /** Returns the corrective TurnResult, or null when nothing needed healing. */
  readonly run: (ctx: HopBodyContext<I>) => Promise<TurnResult | null>;
}

/** Declarative spec for a self-heal step. `detect` reads disk; [] means healthy. */
export interface SelfHealSpec<I, D> {
  /** Disk-aware deviation detector. Empty result = no corrective turn. */
  readonly detect: (input: I) => Promise<readonly D[]>;
  /** Builds the single corrective re-prompt sent via `ctx.send`. */
  readonly buildRepair: (deviations: readonly D[], input: I) => string;
  /** Optional structured log emitted once, only when a corrective turn fires. */
  readonly log?: {
    readonly kind: string;
    readonly message: string;
    readonly meta?: (input: I, deviations: readonly D[]) => Record<string, unknown>;
  };
}

/**
 * Build a `SelfHealStep<I>` from a typed spec. The deviation type `D` stays
 * internal — `detect`'s output feeds `buildRepair` with full typing, and the
 * returned step erases `D` so the chain can hold steps with differing `D`.
 */
export function makeSelfHealStep<I, D>(spec: SelfHealSpec<I, D>): SelfHealStep<I> {
  return {
    async run(ctx) {
      const deviations = await spec.detect(ctx.input);
      if (deviations.length === 0) return null;
      if (spec.log) {
        getSafeLogger()?.info(spec.log.kind, spec.log.message, spec.log.meta?.(ctx.input, deviations) ?? {});
      }
      return ctx.send(spec.buildRepair(deviations, ctx.input));
    },
  };
}

/**
 * Run `seed`'s session through `steps` in order, inside one hop. Each step that
 * detects deviations issues exactly one corrective turn via `ctx.send`. Cost is
 * accumulated onto the returned TurnResult; the most recent corrective turn (or
 * the seed, if none fired) becomes the returned output.
 *
 * US-001: a seed carrying `adapterFailure` is the only signal a failed dispatch
 * left on the chain. A corrective step replaces the seed wholesale when it fires,
 * which silently drops that signal — see AC1. The chain therefore carries the most
 * recently observed `adapterFailure` forward onto each replacement; a corrective
 * turn that carries its own keeps it and becomes the new carrier. This is the
 * single point of loss on the path (US-001 spec).
 *
 * The op's `verify` should re-check the same conditions and warn on residual
 * deviations — see `planRefineOp` for the canonical pairing.
 */
export async function runSelfHealChain<I>(
  ctx: HopBodyContext<I>,
  seed: TurnResult,
  steps: readonly SelfHealStep<I>[],
): Promise<TurnResult> {
  let last = seed;
  let totalCost = seed.estimatedCostUsd ?? 0;
  // The most recently observed adapterFailure on the chain — the seed's to begin
  // with, then any corrective turn's own. Tracking it (rather than re-reading the
  // seed each iteration) keeps multi-step chains consistent with single-step ones:
  // a later clean turn carries the latest real failure forward, not a stale one.
  let lastFailure = seed.adapterFailure;
  for (const step of steps) {
    try {
      const turn = await step.run(ctx);
      if (turn) {
        totalCost += turn.estimatedCostUsd ?? 0;
        // A corrective turn that carries its own adapterFailure keeps it, and it
        // becomes the carrier (AC2). Otherwise the carried failure is preserved
        // onto the replacement — the only signal a failed dispatch left behind
        // (US-001 AC1).
        if (turn.adapterFailure) {
          lastFailure = turn.adapterFailure;
          last = turn;
        } else if (lastFailure) {
          last = { ...turn, adapterFailure: lastFailure };
        } else {
          last = turn;
        }
      }
    } catch (err) {
      getSafeLogger()?.warn("self-heal", "step threw — skipping", { error: errorMessage(err) });
    }
  }
  return { ...last, estimatedCostUsd: totalCost };
}

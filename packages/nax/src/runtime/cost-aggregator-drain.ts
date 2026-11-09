/**
 * The write-pass loop behind `CostAggregator.drain()` (US-004).
 *
 * Split out of `cost-aggregator.ts`, which is at its 600-line limit. It imports
 * nothing from that module — not even `_costAggDeps` — so no runtime import cycle
 * is added: the write seam and the logger arrive as parameters. The type-only
 * import below is erased at compile time and cannot participate in one.
 *
 * The loop exists because a single write pass is not enough: an event recorded
 * while a write is in flight (BUG-29) must reach the file before the drain
 * returns, so the loop keeps taking the caller's in-flight buffer and rewriting
 * until a pass observes nothing new. The pass bound is a safety ceiling — a
 * steady trickle of late events must not turn shutdown into an unbounded
 * resort/rewrite loop over the full committed set.
 */
import { mkdirSync } from "node:fs";
import type { CostErrorEvent, CostEvent } from "./cost-aggregator";

/** One ledger row. The loop orders rows by `ts` and serialises them whole. */
export type DrainRow = CostEvent | CostErrorEvent;

/** The `write` seam (`_costAggDeps.write`), passed in rather than imported. */
export type DrainWrite = (path: string, data: string) => Promise<number>;

/** The slice of the project logger this loop needs. */
export interface DrainLogger {
  warn(stage: string, message: string, data?: Record<string, unknown>): void;
}

/** Safety ceiling on the write-until-empty loop (see the file header). */
const MAX_DRAIN_PASSES = 20;

export interface DrainPassesOptions {
  /** Directory the ledger lives in; created if missing. */
  readonly dir: string;
  /** Ledger file — rewritten whole on every pass. */
  readonly path: string;
  /**
   * The rows this drain writes. Mutable on purpose: the loop appends late rows to
   * it, so a later pass rewrites the whole ledger including them.
   */
  readonly committed: DrainRow[];
  /** Splices whatever landed in the caller's in-flight buffer since the last pass. */
  readonly takeInFlight: () => DrainRow[];
  readonly inFlightCount: () => { readonly events: number; readonly errors: number };
  readonly write: DrainWrite;
  readonly logger?: DrainLogger | null;
}

/**
 * Write `committed` to `path`, then keep writing while the caller's in-flight
 * buffer keeps producing rows. Always writes at least once, so an initial batch
 * with nothing late still lands on disk. Rejects with the write's error.
 */
export async function drainWritePasses(opts: DrainPassesOptions): Promise<void> {
  mkdirSync(opts.dir, { recursive: true });
  const hasLate = (): boolean => {
    const { events, errors } = opts.inFlightCount();
    return events > 0 || errors > 0;
  };

  let first = true;
  let pass = 0;
  while (first || hasLate()) {
    if (++pass > MAX_DRAIN_PASSES) {
      const { events, errors } = opts.inFlightCount();
      opts.logger?.warn("cost-aggregator", "drain exceeded max passes — late events keep arriving", {
        pass,
        inFlightEvents: events,
        inFlightErrors: errors,
      });
      break;
    }
    first = false;
    opts.committed.push(...opts.takeInFlight());
    opts.committed.sort((a, b) => a.ts - b.ts);
    await opts.write(opts.path, `${opts.committed.map((e) => JSON.stringify(e)).join("\n")}\n`);
  }
}

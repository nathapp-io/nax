/**
 * ADR-022 — per-finding strategy retirement for `runFixCycle`.
 *
 * Owns the answer to one question: given that a strategy has answered UNRESOLVED
 * before, may it be dispatched again now?
 *
 * scope: repo-scoped (pure bookkeeping over findings; no I/O, no config)
 */

import type { FixStrategy } from "./cycle-types";
import type { Finding } from "./types";
import { findingKey } from "./types";

/**
 * Ledger of which findings each strategy has declined.
 *
 * UNRESOLVED means "I cannot fix THIS", not "I cannot fix anything" — so retirement
 * is scoped to the findings the strategy was actually given. Retiring cycle-wide
 * (#1369's original shape) meant a later, unrelated finding routed only to that
 * strategy exited the cycle `no-strategy` and the caller discarded the whole pass;
 * on otel-telemetry-expansion US-006 that orphaned a one-line barrel export because
 * of a refusal about an unrelated scoping decision (#1384).
 *
 * The declined unit is the DISPATCHED BATCH: a strategy receives every finding it
 * claims in one call and answers once, so one UNRESOLVED declines all of them. That
 * over-retires within the batch, which is harmless — findings the agent did fix
 * leave the cycle's finding list anyway — and errs in the conservative direction.
 *
 * Termination: a strategy can decline any given finding at most once and the
 * declined set only grows, so the selectable set still shrinks monotonically over a
 * fixed finding set. `findingKey` includes `message`, so a re-emitted finding with
 * LLM-rephrased text mints a new key and becomes dispatchable again — accepted,
 * because the drift is in the "try again" direction and the cycle's
 * `maxAttempts` caps still bind.
 */
export interface DeclineLedger<F extends Finding> {
  /**
   * Record that `strategy` declined every finding it claims out of `dispatched` —
   * i.e. the input batch it just answered UNRESOLVED for.
   */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are opaque to the cycle
  recordDeclined(strategy: FixStrategy<F, any, any, any>, dispatched: readonly F[]): void;
  /**
   * Is `strategy` retired with respect to `findings`? True only once it has declined
   * EVERY remaining finding it claims — declining one must not retire it for others.
   * A strategy that claims none of `findings` is not "retired"; it is simply inactive,
   * which `selectActiveStrategies` decides.
   */
  // biome-ignore lint/suspicious/noExplicitAny: see above
  isRetiredFor(strategy: FixStrategy<F, any, any, any>, findings: readonly F[]): boolean;
  /** Names of strategies retired with respect to `findings` — for the orphan-exit log. */
  // biome-ignore lint/suspicious/noExplicitAny: see above
  retiredNames(strategies: readonly FixStrategy<F, any, any, any>[], findings: readonly F[]): string[];
}

/** Create an empty per-cycle decline ledger. */
export function createDeclineLedger<F extends Finding>(): DeclineLedger<F> {
  const declinedByStrategy = new Map<string, Set<string>>();

  const hasDeclined = (strategyName: string, finding: F): boolean =>
    declinedByStrategy.get(strategyName)?.has(findingKey(finding)) === true;

  const isRetiredFor: DeclineLedger<F>["isRetiredFor"] = (strategy, findings) => {
    const claimed = findings.filter((f) => strategy.appliesTo(f));
    return claimed.length > 0 && claimed.every((f) => hasDeclined(strategy.name, f));
  };

  return {
    recordDeclined(strategy, dispatched) {
      const declined = declinedByStrategy.get(strategy.name) ?? new Set<string>();
      for (const f of dispatched.filter((x) => strategy.appliesTo(x))) declined.add(findingKey(f));
      declinedByStrategy.set(strategy.name, declined);
    },
    isRetiredFor,
    retiredNames(strategies, findings) {
      return strategies.filter((s) => isRetiredFor(s, findings)).map((s) => s.name);
    },
  };
}

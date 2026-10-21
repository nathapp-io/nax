import { type CiWaitResult, ciAllowsReady } from "../workflow/ci-wait";
import type { RecordRulingsOutcome } from "./rulings";

export type WorkflowPrReadiness = { ready: true } | { ready: false; reason: string };

/** The durable index and rulings, not body ticks, decide whether CI may promote a draft. */
export function workflowPrReadiness(input: { outcome?: RecordRulingsOutcome; ci: CiWaitResult }): WorkflowPrReadiness {
  const { outcome, ci } = input;
  if (!outcome) return { ready: false, reason: "rulings could not be read" };
  if (!outcome.index) return { ready: false, reason: "no nax item index on this PR" };
  const present = new Set([...outcome.settled, ...outcome.open].map((item) => item.key));
  const missing = outcome.index.keys
    .filter((key) => !present.has(key))
    .map((key) => key.slice(2, key.lastIndexOf(".")));
  if (missing.length)
    return { ready: false, reason: `${missing.length} item(s) without a thread: ${missing.join(", ")}` };
  if (outcome.open.length)
    return {
      ready: false,
      reason: `${outcome.open.length} open item(s): ${outcome.open.map((item) => item.itemId).join(", ")}`,
    };
  if (!ciAllowsReady(ci.outcome)) return { ready: false, reason: `CI ${ci.outcome}: ${ci.detail}` };
  return { ready: true };
}

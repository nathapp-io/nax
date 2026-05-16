/**
 * Selector strategy registry.
 */

import { NaxError } from "@/errors";
import { dialogueVerdictSelector } from "./dialogue-verdict";
import { judgeSelector } from "./judge";
import { majorityFailClosedSelector, majorityFailOpenSelector } from "./majority";
import { synthesisSelector } from "./synthesis";
import type { Selector } from "./types";
import { verifierPickSelector } from "./verifier-pick";

const STRATEGIES: Record<string, Selector> = {};

export function resolveSelector(kind: string): Selector {
  const strategy = STRATEGIES[kind];
  if (!strategy) {
    throw new NaxError(`Unknown selector kind: ${kind}`, "SELECTOR_UNKNOWN", { kind });
  }
  return strategy;
}

export function registerSelector(kind: string, strategy: Selector): void {
  STRATEGIES[kind] = strategy;
}

// Register built-in strategies at module load
registerSelector("synthesis", synthesisSelector);
registerSelector("majority-fail-closed", majorityFailClosedSelector);
registerSelector("majority-fail-open", majorityFailOpenSelector);
registerSelector("judge", judgeSelector);
registerSelector("dialogue-verdict", dialogueVerdictSelector);
registerSelector("verifier-pick", (ctx) => verifierPickSelector(ctx));

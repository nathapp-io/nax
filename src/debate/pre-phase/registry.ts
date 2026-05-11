/**
 * Pre-debate phase strategy registry.
 */

import { NaxError } from "@/errors";
import { grounderStrategy } from "./grounder";
import type { PreDebatePhase } from "./types";

const STRATEGIES: Record<string, PreDebatePhase> = {};

export function resolvePreDebatePhase(kind: string): PreDebatePhase {
  const strategy = STRATEGIES[kind];
  if (!strategy) {
    throw new NaxError(`Unknown pre-debate phase kind: ${kind}`, "PRE_DEBATE_PHASE_UNKNOWN", { kind });
  }
  return strategy;
}

export function registerPreDebatePhase(kind: string, strategy: PreDebatePhase): void {
  STRATEGIES[kind] = strategy;
}

// Register built-in strategies at module load
registerPreDebatePhase("grounder", grounderStrategy);

/**
 * Post-debate verifier strategy registry.
 */

import { NaxError } from "@/errors";
import { planChecklistVerifier } from "./plan-checklist";
import type { PostDebateVerifier } from "./types";

const STRATEGIES: Record<string, PostDebateVerifier> = {};

export function resolvePostDebateVerifier(kind: string): PostDebateVerifier {
  const strategy = STRATEGIES[kind];
  if (!strategy) {
    throw new NaxError(`Unknown post-debate verifier kind: ${kind}`, "POST_DEBATE_VERIFIER_UNKNOWN", { kind });
  }
  return strategy;
}

export function registerPostDebateVerifier(kind: string, strategy: PostDebateVerifier): void {
  STRATEGIES[kind] = strategy;
}

// Register built-in verifiers at module load
registerPostDebateVerifier("plan-checklist", planChecklistVerifier);

/**
 * Selector strategy registry.
 */

import { NaxError } from "@/errors";
import type { Selector } from "./types";

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

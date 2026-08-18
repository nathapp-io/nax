/**
 * Public barrel for `src/finish/` — the first this module gets.
 *
 * Nothing before Task 8 needed one: every prior module imported its siblings
 * by relative path. This exports only what a consumer outside the module
 * needs to drive a finish (Plan 4's wiring) or implement `FinishOps` (Plan 3):
 * the machine entry point, context/state construction, the `FinishOps`
 * contract, and the types a caller reads results through. Internal `_*Deps`
 * seams stay unexported — those are wiring details of their own module, not
 * part of this module's public surface.
 */
export { loadFinishContext } from "./context";
export type { FinishContext } from "./context";
export { runFinishMachine } from "./machine";
export type { FinishMachineDeps } from "./machine";
export type { FinishOps, FixOutcome, FixRequest, ReviewRequest } from "./ops";
export { createFinishState } from "./state";
export type { FinishState, FinishStateInit, FinishStatus } from "./state";
export type {
  AcceptanceGateResult,
  Finding,
  FindingDisposition,
  FinishPhase,
  FinishResult,
  FinishRound,
  FinishTimeouts,
  QualityGateResult,
} from "./types";

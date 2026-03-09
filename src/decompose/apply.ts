/**
 * PRD Mutation — Apply Decomposition (SD-003)
 *
 * STUB — not implemented. Tests import this to verify the function signature.
 * Real implementation added by the implementer session.
 */

import type { PRD } from "../prd";
import type { DecomposeResult } from "./types";

/**
 * Apply a decomposition result to a PRD:
 * - Marks the original story as 'decomposed'
 * - Inserts substories after the original with status 'pending' and parentStoryId
 * - Re-routes each substory via routeTask()
 */
export function applyDecomposition(_prd: PRD, _result: DecomposeResult): void {
  throw new Error("applyDecomposition: not implemented (SD-003)");
}

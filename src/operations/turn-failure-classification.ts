/**
 * Empty-output failure classification — extracted from sendWithFileOutput
 * (src/operations/call.ts). Pure function: takes a TurnResult and returns the
 * AdapterFailure the wiring layer should attach when the agent produced no
 * usable output.
 *
 * Rules (per US-001 design notes):
 *   - When the turn result already carries an adapterFailure, return it
 *     unchanged. Existing failures take precedence (AC9).
 *   - When the trimmed output has length > 0, return null. Only "no usable
 *     output" (empty or whitespace-only) is classified.
 *   - When output is empty (or whitespace-only) and timedOut is true,
 *     synthesise a retriable `quality / fail-timeout` failure (AC4–AC6).
 *   - When output is empty (or whitespace-only) and timedOut is false or
 *     absent, synthesise a retriable `availability / fail-stale` failure with
 *     `reason: "empty-output"` — verbatim from the original sendWithFileOutput
 *     block (AC7, AC8).
 *
 * Whitespace-only output is classified as empty here for parity with the
 * legacy `!output?.trim()` check in `sendWithFileOutput` (callOp:316).
 */

import type { TurnResult } from "../agents/types";
import type { AdapterFailure } from "../context/engine";

export function classifyEmptyOutputFailure(turn: TurnResult): AdapterFailure | null {
  if (turn.adapterFailure) return turn.adapterFailure;
  if (turn.output && turn.output.trim().length > 0) return null;

  if (turn.timedOut) {
    return {
      category: "quality",
      outcome: "fail-timeout",
      retriable: true,
      message: "[callOp] agent timed out before producing output",
      reason: "wall-clock-timeout",
    };
  }

  return {
    category: "availability",
    outcome: "fail-stale",
    retriable: true,
    message: "[callOp] agent returned no output",
    reason: "empty-output",
  };
}

/**
 * Empty-output failure classification — extracted from sendWithFileOutput
 * (src/operations/call.ts). Pure function: takes a TurnResult and returns the
 * AdapterFailure the wiring layer should attach when the agent produced no
 * usable output.
 *
 * Rules (per US-001 design notes):
 *   - When the turn result already carries an adapterFailure, return it
 *     unchanged. Existing failures take precedence (AC9).
 *   - When the turn reports a transport fact (`timedOut`, then
 *     `invalidCallBudgetExceeded`, then `turnIncomplete`), classify from that
 *     fact regardless of output. A truncated turn usually HAS prose, so
 *     checking output first hid it.
 *   - Otherwise, when the trimmed output has length > 0, return null.
 *   - When output is empty (or whitespace-only) and timedOut is false or
 *     absent, synthesise a retriable `availability / fail-stale` failure with
 *     `reason: "empty-output"` — verbatim from the original sendWithFileOutput
 *     block (AC7, AC8).
 *
 * Whitespace-only output is classified as empty here for parity with the
 * legacy `!output?.trim()` check in `sendWithFileOutput` (callOp:316).
 */

import type { InvalidToolCallDetail } from "../agents/session-types";
import type { TurnResult } from "../agents/types";
import type { AdapterFailure } from "../context/engine";
import { tryParseLLMJson } from "../utils/llm-json";

export function classifyEmptyOutputFailure(turn: TurnResult): AdapterFailure | null {
  if (turn.adapterFailure) return turn.adapterFailure;

  // Transport facts are consulted BEFORE the output check. A turn that ran out
  // of budget mid-work almost always has prose in `output`, so short-circuiting
  // on "output is non-empty" classified the common truncation case as a clean
  // success — the defect that hid it for 44% of native run calls.
  if (turn.timedOut) {
    return {
      category: "quality",
      outcome: "fail-timeout",
      retriable: true,
      message: "[callOp] agent timed out before completing its turn",
      reason: "wall-clock-timeout",
    };
  }

  // nax#2200: the invalid-call budget also leaves the turn incomplete, but it
  // is not a truncation and never a timeout. Classified ahead of
  // `turnIncomplete` so the retry prompt names the rejected call instead of
  // telling the model it ran out of time — the model was never told which
  // property was wrong, and repeated the call.
  if (turn.invalidCallBudgetExceeded) return invalidToolCallFailure(turn.invalidToolCall);

  if (turn.turnIncomplete) {
    // fail-incomplete, not fail-quality (nax#2054): fail-quality's policy row
    // is sameAgentRetry "none" + swap "quality-gated", and a repo that disables
    // agent.fallback.onQualityFailure would hard-fail with no retry and no
    // swap — turning a truncated turn into a story failure instead of the
    // retry this case calls for.
    return {
      category: "quality",
      outcome: "fail-incomplete",
      retriable: true,
      message: "[callOp] agent turn ended with tool calls outstanding",
      reason: "turn-incomplete",
    };
  }

  if (turn.output && turn.output.trim().length > 0) return null;

  return {
    category: "availability",
    outcome: "fail-stale",
    retriable: true,
    message: "[callOp] agent returned no output",
    reason: "empty-output",
  };
}

/** `AdapterFailure.message` is documented as at most 500 characters. */
const MAX_FAILURE_MESSAGE_CHARS = 500;

function invalidToolCallFailure(detail: InvalidToolCallDetail | undefined): AdapterFailure {
  const what =
    detail === undefined
      ? "the same invalid tool call"
      : `an invalid ${detail.tool} call (property "${detail.property}" expected ${detail.expected}, got ${detail.actual})`;
  return {
    category: "quality",
    outcome: "fail-invalid-tool-call",
    retriable: true,
    message: `[callOp] agent turn ended after repeating ${what}`.slice(0, MAX_FAILURE_MESSAGE_CHARS),
    reason: "invalid-call-budget",
    ...(detail !== undefined ? { invalidToolCall: detail } : {}),
  };
}

/**
 * A provider capacity refusal returned as ordinary turn output rather than
 * raised as a transport error — e.g. "Selected model is at capacity. Please
 * try a different model." Measured over 4570 review-audit records (nax#1550
 * follow-up, "BUG-62"): 9 of 10 unparseable review give-ups attributed to
 * this exact literal, none were genuine review verdicts.
 *
 * Anchored to the start of the (trimmed) output, length-capped, and rejected
 * outright when the output parses as LLM JSON — a genuine verdict payload
 * (which may legitimately quote this phrase as review-finding evidence) can
 * never match, since it neither starts with the literal nor fails to parse.
 * `parseAgentError` deliberately excludes free-text inference for structured
 * transport errors; this is the one place a free-text match is warranted,
 * because the refusal never reaches the transport layer as an error at all.
 */
const PROVIDER_REFUSAL_PATTERN = /^selected model is at capacity\b/i;
const MAX_REFUSAL_OUTPUT_CHARS = 300;

export function classifyProviderRefusalFailure(output: string): AdapterFailure | null {
  const trimmed = output.trim();
  if (!trimmed || trimmed.length > MAX_REFUSAL_OUTPUT_CHARS) return null;
  if (!PROVIDER_REFUSAL_PATTERN.test(trimmed)) return null;
  if (tryParseLLMJson(trimmed) !== null) return null;
  return {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: trimmed.slice(0, 500),
  };
}

/**
 * Reprompt-marker plumbing for the adversarial review op.
 *
 * When the ungrounded-drop reprompt runs, its outcome has to survive the turn
 * boundary between the wrapper and `parse()`. It rides along as a `_repromptInfo`
 * key on the JSON output: `validateAdversarialShape` ignores unknown keys, so the
 * marker is invisible to the shape validator and readable by `parse()`.
 *
 * Extracted from adversarial-review.ts to keep that file under the 600-line limit.
 */

import { tryParseLLMJson } from "../utils/llm-json";

export type RepromptInfo = {
  dropCount: number;
  outcome: "recovered-blocking" | "recovered-advisory-only" | "still-dropped" | "parse-failed";
  costUsd: number;
};

/**
 * Embed a `_repromptInfo` marker into a JSON output string. `validateAdversarialShape`
 * ignores unknown keys, so the marker is invisible to the shape validator but readable
 * by `parse()`. No-ops for non-JSON output.
 */
export function withRepromptMarker(output: string, info: RepromptInfo): string {
  const parsed = tryParseLLMJson<Record<string, unknown>>(output);
  if (!parsed || typeof parsed !== "object") return output;
  return JSON.stringify({ ...parsed, _repromptInfo: info });
}

export function extractRepromptInfo(raw: Record<string, unknown> | null | undefined): RepromptInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const info = raw._repromptInfo;
  if (!info || typeof info !== "object") return undefined;
  const i = info as Record<string, unknown>;
  if (typeof i.dropCount !== "number" || typeof i.costUsd !== "number" || typeof i.outcome !== "string") {
    return undefined;
  }
  return {
    dropCount: i.dropCount,
    costUsd: i.costUsd,
    outcome: i.outcome as RepromptInfo["outcome"],
  };
}

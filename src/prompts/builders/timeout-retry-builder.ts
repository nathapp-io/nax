/**
 * timeoutRetry — informed retry prompt for wall-clock-timed-out attempts (US-003).
 *
 * Composes the retry prompt from a generic timeout preamble plus git-derived
 * guidance about what landed on disk during the timed-out attempt:
 *   - Non-empty `changedFiles` → names each path and instructs the agent to
 *     continue from the existing state.
 *   - Empty `changedFiles` → states the previous attempt produced no file
 *     changes and instructs the agent to change its approach.
 * Always includes the elapsed duration of the timed-out attempt and the
 * original prompt text. Degrades to the generic preamble when changedFiles is
 * empty (pre-attempt ref unavailable or capture failed).
 *
 * The timeout lane is shared (see `failure-policy.ts`). When the failure that
 * opened it was an invalid tool call (nax#2200), the preamble says so — naming
 * the tool, the property and what the schema expects — instead of reporting a
 * timeout that never happened: told "you timed out", the model repeated the
 * same rejected call.
 */

import type { AdapterFailure } from "@/context/engine";

export interface TimeoutRetryInput {
  prompt: string;
  changedFiles: string[];
  elapsedMs: number;
  /** 1-based retry attempt number (the hop's `attempt` field is the retry count, so the story is on attempt + 1). */
  attempt: number;
  /** The failure that opened the retry lane, when the hop carried it. */
  failure?: AdapterFailure;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function timeoutRetry(input: TimeoutRetryInput): string {
  const { prompt, changedFiles, elapsedMs, attempt, failure } = input;
  if (failure?.outcome === "fail-invalid-tool-call") return invalidToolCallRetry(input, failure);
  const duration = formatDuration(elapsedMs);
  const attemptNumber = attempt + 1;

  if (changedFiles.length === 0) {
    return `The previous attempt hit a timeout after ${elapsedMs}ms (${duration}) with no file changes on disk.
This is attempt ${attemptNumber} of the same story — the previous attempt left nothing behind, so the approach was wrong.
Change your approach: pick a narrower scope, fewer file edits, or a different angle on the acceptance criteria.

---

${prompt}`;
  }

  const fileList = changedFiles.map((p) => `- ${p}`).join("\n");
  return `The previous attempt hit a timeout after ${elapsedMs}ms (${duration}), but left these files on disk:

${fileList}

This is attempt ${attemptNumber} of the same story — continue from the existing state above.
Read the files listed, pick up where the previous attempt stopped, and finish the story.
Do NOT delete or revert the existing work; treat the working tree as the starting point.

---

${prompt}`;
}

/**
 * The invalid-tool-call variant (nax#2200). Names the rejected call when the
 * failure carries it; otherwise says only that a tool call was rejected.
 */
function invalidToolCallRetry(input: TimeoutRetryInput, failure: AdapterFailure): string {
  const { prompt, changedFiles, attempt } = input;
  const detail = failure.invalidToolCall;
  const rejected =
    detail === undefined
      ? "The previous attempt was stopped because it kept repeating the same invalid tool call. The tool rejected that input every time and never ran it."
      : `The previous attempt was stopped because it kept repeating the same invalid \`${detail.tool}\` call: property \`${detail.property}\` expected ${detail.expected}, got ${detail.actual}. The tool rejected that input every time and never ran it.`;
  const fix =
    detail === undefined
      ? "Before calling a tool, check its input schema. If an optional property has no value, leave it out entirely."
      : `Before calling \`${detail.tool}\` again, make \`${detail.property}\` match its schema (${detail.expected}). If it is optional and you have no value for it, leave it out entirely.`;
  const state =
    changedFiles.length === 0
      ? "The previous attempt left no file changes on disk."
      : `The previous attempt left these files on disk. Continue from them; do not revert them:\n\n${changedFiles.map((p) => `- ${p}`).join("\n")}`;
  return `${rejected}
This was not a timeout. This is attempt ${attempt + 1} of the same story.
${fix}

${state}

---

${prompt}`;
}

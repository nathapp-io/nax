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
 */

export interface TimeoutRetryInput {
  prompt: string;
  changedFiles: string[];
  elapsedMs: number;
  /** 1-based retry attempt number (the hop's `attempt` field is the retry count, so the story is on attempt + 1). */
  attempt: number;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function timeoutRetry(input: TimeoutRetryInput): string {
  const { prompt, changedFiles, elapsedMs, attempt } = input;
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

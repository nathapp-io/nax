/**
 * timeoutRetry — informed retry prompt for wall-clock-timed-out attempts (US-003).
 *
 * Composes the retry prompt from a generic timeout preamble plus git-derived
 * guidance about what landed on disk during the timed-out attempt:
 *   - Non-empty `changedFiles` → names each path and instructs the agent to
 *     continue from the existing state rather than restart.
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
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function timeoutRetry(input: TimeoutRetryInput): string {
  const { prompt, changedFiles, elapsedMs } = input;
  const duration = formatDuration(elapsedMs);

  if (changedFiles.length === 0) {
    return `The previous attempt timed out after ${duration} with no file changes on disk.
This is attempt 2 of the same story — the previous attempt left nothing behind, so the approach was wrong.
Change your approach: pick a narrower scope, fewer file edits, or a different angle on the acceptance criteria.

---

${prompt}`;
  }

  const fileList = changedFiles.map((p) => `- ${p}`).join("\n");
  return `The previous attempt timed out after ${duration}, but left these files on disk:

${fileList}

This is attempt 2 of the same story — continue from the existing state above rather than restart.
Read the files listed, pick up where the previous attempt stopped, and finish the story.
Do NOT delete or revert the existing work; treat the working tree as the starting point.

---

${prompt}`;
}

/**
 * Queue file parsing.
 *
 * Reads the mid-run control file (PAUSE / ABORT / SKIP / RETRY / PRIORITY /
 * INJECT) that `src/execution/queue-handler.ts` polls between stories.
 */

import type { QueueCommand, QueueFileResult } from "./types";

/**
 * Parse queue file content into commands and guidance.
 *
 * Commands:
 * - PAUSE: Pause execution after current story
 * - ABORT: Mark all remaining stories as skipped and stop
 * - SKIP US-XXX: Skip a specific story
 * - RETRY US-XXX: Reset a failed/skipped story back to pending
 * - PRIORITY US-XXX <n>: Set a story's scheduling priority
 * - INJECT <path>: Add a new story from a JSON file (path relative to workdir)
 *
 * Everything else after "--- PENDING ---" is treated as guidance text.
 */
export function parseQueueFile(content: string): QueueFileResult {
  const commands: QueueCommand[] = [];
  const guidance: string[] = [];

  const lines = content.split("\n");
  let inPendingSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      continue;
    }

    // Check for pending section marker
    if (trimmed === "--- PENDING ---") {
      inPendingSection = true;
      continue;
    }

    // Parse commands (case-insensitive)
    const upper = trimmed.toUpperCase();

    if (upper === "PAUSE") {
      commands.push({ type: "PAUSE" });
    } else if (upper === "ABORT") {
      commands.push({ type: "ABORT" });
    } else if (upper.startsWith("SKIP ")) {
      // Extract story ID after "SKIP"
      const storyId = trimmed.substring(5).trim();
      if (storyId) {
        commands.push({ type: "SKIP", storyId });
      } else {
        // No story ID, treat as guidance
        guidance.push(trimmed);
      }
    } else if (upper === "SKIP") {
      // SKIP with no story ID, treat as guidance
      guidance.push(trimmed);
    } else if (upper.startsWith("RETRY ")) {
      const storyId = trimmed.substring(6).trim();
      if (storyId) {
        commands.push({ type: "RETRY", storyId });
      } else {
        guidance.push(trimmed);
      }
    } else if (upper === "RETRY") {
      // RETRY with no story ID, treat as guidance
      guidance.push(trimmed);
    } else if (upper.startsWith("PRIORITY ")) {
      const rest = trimmed.substring(9).trim();
      const parts = rest.split(/\s+/);
      const storyId = parts[0];
      const value = parts[1] !== undefined ? Number(parts[1]) : Number.NaN;
      if (storyId && parts.length === 2 && Number.isFinite(value)) {
        commands.push({ type: "PRIORITY", storyId, value });
      } else {
        // Missing/malformed storyId or value, treat as guidance
        guidance.push(trimmed);
      }
    } else if (upper === "PRIORITY") {
      // PRIORITY with no arguments, treat as guidance
      guidance.push(trimmed);
    } else if (upper.startsWith("INJECT ")) {
      // Extract file path after "INJECT" — take the full remainder (paths may contain spaces)
      const storyFile = trimmed.substring(7).trim();
      if (storyFile) {
        commands.push({ type: "INJECT", storyFile });
      } else {
        guidance.push(trimmed);
      }
    } else if (upper === "INJECT") {
      // INJECT with no file path, treat as guidance
      guidance.push(trimmed);
    } else {
      // Not a command, treat as guidance if in pending section
      if (inPendingSection) {
        guidance.push(trimmed);
      }
    }
  }

  return { commands, guidance };
}

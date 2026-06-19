/**
 * Log-format module — human-facing presentation layer.
 *
 * Formats `LogEntry` records (from `src/logger`) and run summaries into
 * human-friendly output with multiple verbosity levels. This is distinct from
 * `src/logger`, which is the structured JSONL logging *facility* that produces
 * the `LogEntry` records consumed here.
 */

export {
  formatLogEntry,
  formatRunSummary,
  formatTimestamp,
  formatDuration,
  formatCost,
  type FormattedEntry,
} from "./formatter.js";
export {
  EMOJI,
  type VerbosityMode,
  type FormatterOptions,
  type RunSummary,
  type StoryStartData,
  type StageResultData,
} from "./types.js";

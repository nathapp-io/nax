/**
 * Log-format module — human-facing presentation layer.
 *
 * Formats `LogEntry` records (from `src/logger`) and run summaries into
 * human-friendly output with multiple verbosity levels. This is distinct from
 * `src/logger`, which is the structured JSONL logging *facility* that produces
 * the `LogEntry` records consumed here.
 */

export {
  type FormattedEntry,
  formatAdvisorySummary,
  formatCost,
  formatDuration,
  formatLogEntry,
  formatRunSummary,
  formatTimestamp,
} from "./formatter.js";
export { formatMutationSummary } from "./mutation-summary.js";
export {
  EMOJI,
  type FormatterOptions,
  type RunSummary,
  type StageResultData,
  type StoryStartData,
  type VerbosityMode,
} from "./types.js";

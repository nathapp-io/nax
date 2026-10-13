/**
 * The workflow's voice in the run log (nax#2491): one place that turns what the workflow
 * decides into `workflow`-tagged info lines, so a reader needs the log and nothing else.
 * Every line carries `storyId` as its first data key (the logger convention).
 */
import { formatDuration } from "@/log-format";
import { getSafeLogger } from "@/logger";
import { FEATURE_SCOPE } from "./advisor-live";

const MAX_ISSUE_CHARS = 60;

interface DescribedFinding {
  readonly id?: string;
  readonly severity: string;
  readonly issue: string;
}

export function logWorkflow(storyId: string, message: string, data: Record<string, unknown> = {}): void {
  getSafeLogger()?.info("workflow", message, { storyId, ...data });
}

/** The ledger's mirror in the log: same text, so the log and ledger.md never disagree. */
export function mirrorLedger(storyId: string, text: string): void {
  logWorkflow(storyId, `${storyId}: ${text}`, { ledger: true });
}

function shortIssue(issue: string): string {
  const flat = issue.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ISSUE_CHARS ? `${flat.slice(0, MAX_ISSUE_CHARS - 3)}...` : flat;
}

const SEVERITY_ORDER = ["critical", "important", "minor"];

/** `3 important, 1 minor (F1 first gap, ...)`. */
export function describeFindings(findings: readonly DescribedFinding[]): string {
  if (findings.length === 0) return "no findings";
  const counts = SEVERITY_ORDER.map((sev) => [sev, findings.filter((f) => f.severity === sev).length] as const)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${sev}`);
  const items = findings.map((f) => (f.id ? `${f.id} ${shortIssue(f.issue)}` : shortIssue(f.issue)));
  return `${counts.join(", ")} (${items.join(", ")})`;
}

export interface StepLog {
  /** Logs `<storyId> <label>: <text>  <elapsed>` and returns the elapsed ms. */
  done(text: string, data?: Record<string, unknown>): number;
}

export interface StepLogOptions {
  readonly now?: () => number;
  /** False for steps that make no agent call (gates, publish): only the result line is logged. */
  readonly announce?: boolean;
  /** `done` text is joined to the label with a space instead of a colon (`repo-gates green`). */
  readonly bare?: boolean;
}

/**
 * Logs `<storyId> <label> start` now; `done` logs the outcome with the step's wall time.
 * The feature scope has no story, so its lines omit the id (`branch-review start`).
 */
export function startStep(storyId: string, label: string, options: StepLogOptions = {}): StepLog {
  const now = options.now ?? Date.now;
  const prefix = storyId === FEATURE_SCOPE ? "" : `${storyId} `;
  const startedAt = now();
  if (options.announce !== false) logWorkflow(storyId, `${prefix}${label} start`, { step: label });
  return {
    done(text, data = {}) {
      const durationMs = now() - startedAt;
      const joiner = options.bare ? " " : ": ";
      logWorkflow(storyId, `${prefix}${label}${joiner}${text}  ${formatDuration(durationMs)}`, {
        step: label,
        durationMs,
        ...data,
      });
      return durationMs;
    },
  };
}

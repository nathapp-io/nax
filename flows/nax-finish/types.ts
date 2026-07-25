/** One acceptance-test group as reported by `nax features resolve --json`. */
export interface AcceptanceGroup {
  packageDir: string;
  testPath: string;
  exists: boolean;
  command?: string;
  language: string;
}

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export interface Finding {
  severity: Severity;
  title: string;
  problem: string;
  fix: string;
}
export interface ReviewVerdict {
  /**
   * `clean` is not a model-produced route — the review nodes' `parse` rewrites
   * `proceed` with zero findings to `clean` so the graph can skip the fix node
   * entirely instead of prompting an agent to "apply fixes" for nothing.
   */
  route: "proceed" | "escalate" | "clean";
  findings: Finding[];
  escalationReason?: string;
}
/** Wall-clock budgets, forwarded from `finish.autoFlow.timeouts` by the plugin. */
export interface FinishTimeouts {
  acceptanceMs?: number;
  gateMs?: number;
}
export interface FinishInput {
  feature: string;
  workdir: string;
  branch: string;
  prdPath: string;
  /**
   * True only when Telegram escalation is both enabled *and* credentialed, as
   * determined by the plugin. When true the flow skips the PR/MR comment
   * fallback (and does not open a draft to hold one) — the plugin sends the
   * Telegram message from the result file instead.
   */
  escalateTelegram: boolean;
  timeouts?: FinishTimeouts;
}
export interface FinishResult {
  feature: string;
  status: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";
  url?: string;
  escalationReason?: string;
}
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export type RunFn = (cmd: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunResult>;
export type ShellRunFn = (command: string, opts: { cwd: string; timeoutMs?: number }) => Promise<RunResult>;

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
/** The four fix-and-reverify loops, in graph order. */
export type FinishPhase = "acceptance" | "spec" | "quality" | "gate";

/**
 * One completed fix round, appended to the audit trail as it happens.
 *
 * Rounds are appended at `commit_<phase>` as they happen rather than
 * reconstructed by a terminal node from `ctx.state.steps` (which does retain
 * every step's output). Appending live is what makes the trail survive a flow
 * that is killed or times out: no terminal node runs on those paths, and a
 * finish that died mid-loop is exactly when the record of what it already
 * changed on the branch matters most.
 */
export interface FinishRound {
  ts: string;
  phase: FinishPhase;
  /** 1-based; the Nth time this phase's fix node has run. */
  attempt: number;
  /** True when the fix produced a commit; false when it changed nothing. */
  committed: boolean;
  /** Reviewer findings this round set out to fix (spec/quality phases). */
  findings: Finding[];
  /** Gate commands that were red this round (gate phase). */
  failing?: string[];
}

export interface FinishInput {
  feature: string;
  workdir: string;
  branch: string;
  prdPath: string;
  /**
   * Directory for this feature's finish-audit artifacts, e.g.
   * `~/.nax/<project>/finish-audit/<feature>`. Supplied by the plugin, which
   * owns nax's path SSOT (`src/runtime/paths.ts`) that this module may not
   * import. Absent → the flow falls back to a repo-local directory.
   */
  auditDir?: string;
  /** Run id, used to name this run's audit files. Absent → "run". */
  runId?: string;
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
  /**
   * The findings behind an escalation. Persisted because the reason alone is a
   * bare count ("3 finding(s) after 3 fix attempts"), and on the Telegram
   * channel the composed PR comment — the only other thing carrying them — is
   * never posted. Without this the findings survived only in acpx's run bundle.
   */
  findings?: Finding[];
  /**
   * Set when the escalation could not be delivered to its channel (forge
   * comment failed, remote unrecognised). The result file is written before
   * delivery is attempted, so an undelivered escalation is still reported
   * rather than lost.
   */
  deliveryError?: string;
  /**
   * Every fix round the flow ran, on *all* terminal statuses — not just
   * escalations. A successful finish that took four rounds to get there is the
   * case worth auditing (it says the run's own review gates missed four
   * defects), and it was previously the one case that recorded nothing.
   */
  rounds?: FinishRound[];
}
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export type RunFn = (cmd: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunResult>;
export type ShellRunFn = (command: string, opts: { cwd: string; timeoutMs?: number }) => Promise<RunResult>;

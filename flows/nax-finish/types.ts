import type { TemplateMode } from "./pr-template-merge";

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
   * Neither `clean` nor `reprompt` is a model-produced route.
   *
   * `clean` — `parse` rewrites `proceed` with zero findings, so the graph can
   * skip the fix node instead of prompting an agent to "apply fixes" for nothing.
   *
   * `reprompt` — `parse` could not read JSON out of the reply at all. Returning
   * this rather than throwing is deliberate: a throw fails the acp node and kills
   * the whole flow with no result file, bypassing the `escalate` sink that exists
   * to report exactly this kind of dead end.
   */
  route: "proceed" | "escalate" | "clean" | "reprompt";
  findings: Finding[];
  escalationReason?: string;
  /** Bounded tail of an unparseable reply; set only when `route` is `reprompt`. */
  raw?: string;
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
/**
 * What produced a round — the difference between "a reviewer read this and
 * approved it" and "nothing read this".
 *
 * Rounds used to be appended only where a fix produced a commit, so a review
 * that passed left no record at all and was indistinguishable from a review
 * that never ran (#1507). Every phase that executes now records a round, and
 * this field says which of the five things happened.
 *
 * Optional because rounds recorded by earlier versions have no `outcome`, and
 * the PR body still has to render those without claiming more than it knows.
 */
export type FinishRoundOutcome =
  /** A reviewer reported findings and this phase's fix node ran. */
  | "fixed"
  /** A reviewer ran and reported nothing. The only value that means "approved". */
  | "passed"
  /** The reviewer replied, but no verdict could be read out of it. */
  | "unparseable"
  /** Handed off to a human — an explicit escalate, a cap, or a node that emitted nothing. */
  | "escalated"
  /**
   * This phase has no reviewer at all (`gate`, `acceptance`). Distinct from
   * `passed`: an empty finding list here means "nobody looked", and rendering it
   * as "no findings" manufactures evidence of a review that does not exist.
   */
  | "no-reviewer"
  /**
   * A re-review was owed and deliberately skipped.
   *
   * **No longer emitted.** It described the `gate` → `tests-only` route, which
   * skipped `review_quality` as a cost tradeoff; #1510 closed that hole, so
   * every committed gate fix is now re-reviewed and nothing writes this.
   *
   * Retained because the audit trail is read, not just written: a project that
   * ran an earlier nax can hold rounds carrying this outcome, and dropping it
   * from the union would make those unrenderable. Do not reuse the name for a
   * new meaning — a reader hitting it in an old artifact must still be told
   * what it meant when it was written.
   */
  | "review-skipped";

export interface FinishRound {
  ts: string;
  phase: FinishPhase;
  /** 1-based; the Nth time this phase's fix node has run. */
  attempt: number;
  /** True when the fix produced a commit; false when it changed nothing. */
  committed: boolean;
  /** What produced this round; absent on rounds written before it existed. */
  outcome?: FinishRoundOutcome;
  /** Reviewer findings this round set out to fix (spec/quality phases). */
  findings: Finding[];
  /** Gate commands that were red this round (gate phase). */
  failing?: string[];
  /**
   * The successor this round's commit routed to — `changed` / `tests-only` /
   * `unchanged` for `gate`, `changed` / `unchanged` elsewhere.
   *
   * Recorded because `outcome` stopped carrying it. Until #1510 a tests-only
   * gate fix was the only round writing `review-skipped`, so the outcome
   * doubled as the classification; now every committed gate fix is reviewed
   * and writes `no-reviewer`, which would leave "what did this fix touch?"
   * unanswerable from the trail. That question is the input to deciding
   * whether the re-review ever needs a cheaper, test-scoped form, so it has to
   * survive the round it was computed in.
   */
  route?: string;
  /**
   * `HEAD` SHA after this round's commit (set only when `committed`); absent
   * on no-op rounds so a reader can distinguish "no commit" from "record lost".
   * Lets "Fixed in `<sha>`" be reconstructed from the audit trail alone, rather
   * than by matching round timestamps against `git log`.
   */
  sha?: string;
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
  /** PR/MR body composition, forwarded from `finish.autoFlow.prBody`. */
  prBody?: FinishPrBodySettings;
}

/**
 * How the repo's own PR/MR template is honoured when composing the body.
 * Absent (and absent fields) mean the defaults in `pr-template-merge.ts`.
 */
export interface FinishPrBodySettings {
  /** `merge` (default) · `strict` (keep unfillable headings, empty) · `ignore`. */
  template?: TemplateMode;
  /** Normalised template heading → body-section key, layered over the defaults. */
  sectionMap?: Record<string, string>;
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

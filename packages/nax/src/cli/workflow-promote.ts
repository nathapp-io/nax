/**
 * `nax workflow promote` (SPEC-workflow-record-promote, US-004 + US-005) — the validation steps, the
 * `items-ruled` and `ci-green` checks, the dry run, and the four forge writes `--yes` runs.
 *
 * Promotion has rules a finishing tool would otherwise re-derive on every run: the record must still
 * be a draft, the PR it names must still be a draft, and every item the run left open must carry a
 * ruling and the pushed head's checks must be green. `promote` states them once and reports them as
 * two named checks, so a caller reads which rule refused instead of parsing a message.
 *
 * With `--yes` and both checks passed (US-005) the four actions run in order, each awaited before the
 * next and stopping at the first forge write that fails: `tick` rewrites the PR body's checklist
 * lines, `comment` posts one evidence comment built from the sidecar, `ready` marks the PR ready and
 * `record` rewrites the sidecar's own `outcome` to `promoted`. Everything before that point performs
 * no write, so a refusal leaves the run directory and the PR exactly as they were — and the sidecar
 * the checks and the actions read is validated first, with its entries cross-checked against the
 * run's open items, so a hand-written file cannot smuggle a ruling onto the PR (B2).
 *
 * The workflow leaves are reached by relative path, not through the `@/workflow` barrel, for the
 * reason `src/cli/workflow.ts` gives: that barrel loads `step-context`, which imports `@/cli`. HEAD
 * is read through `forgeDeps.forge.run` rather than `readHead` (`src/workflow/git.ts`) for the same
 * reason, and `src/cli/workflow.ts` is imported type-only, which is erased. US-003's `ciAllowsReady`
 * comes from the same leaf, for the same reason: the CI rule is one rule, read from one place.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { detectForge, type ForgeDeps, type ForgeKind, type ForgeRunResult } from "@/forge";
import { validateFeatureName } from "@/utils/feature-name";
import { ciAllowsReady } from "../workflow/ci-wait";
import {
  checkEntriesAgainstItems,
  type DecisionEntry,
  type DecisionsSidecar,
  isoStamp,
  newestSidecar,
  sidecarFileName,
  writeSidecar,
} from "../workflow/decisions-sidecar";
import { readPrState } from "../workflow/pr-state";
import { commentArgv, editBodyArgv, evidenceComment, markReadyArgv, tickChecklist } from "../workflow/promote";
import { type PrRulingsReport, readPromoteRulings } from "../workflow/promote-rulings";
import { type LoadedRun, loadRunVerdict } from "../workflow/run-verdict";
import type { WorkflowCliDeps } from "./workflow";
import type { WorkflowForgeDeps } from "./workflow-forge";

export interface WorkflowPromoteOptions {
  /** The project directory, as for `status`. */
  readonly dir: string;
  readonly feature: string;
  /** The promotion itself: with both checks passed, run the four actions. */
  readonly yes: boolean;
  readonly json: boolean;
}

export interface PromoteCheck {
  readonly name: "items-ruled" | "ci-green";
  readonly passed: boolean;
  /** Why the check failed; empty when it passed. */
  readonly detail: string;
}

/** One forge write `--yes` performs, in order (US-005). */
export interface PromoteAction {
  readonly name: "tick" | "comment" | "ready" | "record";
  readonly status: "done" | "skipped";
}

/** What `--json` prints. */
export interface WorkflowPromoteReport {
  readonly feature: string;
  readonly runId: string;
  readonly url: string;
  /** No forge write happened, so this call reported rather than promoted. */
  readonly dryRun: boolean;
  readonly promoted: boolean;
  readonly prRulings: PrRulingsReport;
  readonly checks: readonly PromoteCheck[];
  readonly actions: readonly PromoteAction[];
}

const PROMOTE_INVALID = "WORKFLOW_PROMOTE_INVALID";
/** US-004 does not wait for CI: the wait is one poll with no interval. */
const PROMOTE_TIMEOUT_MS = 0;
const PROMOTE_POLL_MS = 0;
const NOT_PUBLISHED = "not published";
const READY_LINE = "ready to promote; rerun with --yes";

function invalid(message: string, context: Record<string, unknown> = {}): NaxError {
  return new NaxError(message, PROMOTE_INVALID, { stage: "workflow", ...context });
}

/**
 * Steps 3 and 4: only a draft can be promoted, and a draft that names no PR has nothing to promote.
 * A record with no outcome never reached publish, which reads as `not published` (AC-12).
 */
function draftUrl(loaded: LoadedRun, feature: string): string {
  const { outcome, url } = loaded.record;
  if (outcome !== "draft") {
    throw invalid(`workflow for ${feature} ended ${outcome ?? NOT_PUBLISHED}; only a draft can be promoted`);
  }
  if (url === undefined) throw invalid("the workflow result has no PR url");
  return url;
}

/**
 * Steps 5 and 6: the forge that hosts the PR, and the PR itself still being a draft. `record` refuses
 * to record `promoted` on a draft; `promote` refuses the mirror image, an already-ready PR.
 */
async function draftForge(forgeDeps: WorkflowForgeDeps, dir: string, url: string): Promise<ForgeKind> {
  const forge = await detectForge(forgeDeps.forge, dir);
  if (forge === null) throw invalid(`no forge detected for ${dir}`);
  const state = await readPrState(forge, url, forgeDeps.forge, dir);
  if (!state.isDraft) throw invalid(`PR is already ready: ${url}`);
  return forge;
}

/** The pushed head, which `ci-green` binds the reported checks to. A failure here is exit 1. */
async function headSha(forge: ForgeDeps, cwd: string): Promise<string> {
  // nax-git-env-allow: ForgeDeps.run is defaultForgeDeps.run in production, which hardens every command
  const result = await forge.run(["git", "rev-parse", "HEAD"], { cwd });
  if (result.exitCode !== 0) {
    throw invalid(`cannot read HEAD: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout.trim();
}

/** The run's newest sidecar as `newestSidecar` returns it, or null when the run has none. */
interface FoundSidecar {
  readonly path: string;
  readonly sidecar: DecisionsSidecar;
}

/** `items-ruled`: every open item id has a local entry or a current indexed settled PR ruling. */
function itemsRuled(loaded: LoadedRun, found: FoundSidecar | null, entries: readonly DecisionEntry[]): PromoteCheck {
  const ids = loaded.openItems.map((item) => item.id);
  if (ids.length === 0) return { name: "items-ruled", passed: true, detail: "" };
  if (found === null && entries.length === 0) {
    return { name: "items-ruled", passed: false, detail: "no decisions recorded; run nax workflow record" };
  }
  const ruled = new Set(entries.map((entry) => entry.id));
  const unruled = ids.filter((id) => !ruled.has(id));
  return unruled.length === 0
    ? { name: "items-ruled", passed: true, detail: "" }
    : { name: "items-ruled", passed: false, detail: `no ruling recorded for ${unruled.join(", ")}` };
}

/**
 * `ci-green`: the pushed head's checks passed. Anything else — including a mismatch — is a refusal.
 * US-003: the decision is the one CI rule (`ciAllowsReady`), so promote cannot disagree with the
 * workflow's own publish about what "ready" means.
 */
async function ciGreen(input: {
  readonly forgeDeps: WorkflowForgeDeps;
  readonly forge: ForgeKind;
  readonly url: string;
  readonly dir: string;
  readonly expectedSha: string;
}): Promise<PromoteCheck> {
  const result = await input.forgeDeps.waitForChecks(input.forge, input.url, {
    cwd: input.dir,
    timeoutMs: PROMOTE_TIMEOUT_MS,
    pollMs: PROMOTE_POLL_MS,
    expectedSha: input.expectedSha,
  });
  return ciAllowsReady(result.outcome)
    ? { name: "ci-green", passed: true, detail: "" }
    : { name: "ci-green", passed: false, detail: `ci ${result.outcome}: ${result.detail}` };
}

const allPassed = (checks: readonly PromoteCheck[]): boolean => checks.every((check) => check.passed);

/** Everything the four actions write with: the run, its PR, the forge, and the sidecar read once. */
interface PromoteTarget {
  readonly opts: WorkflowPromoteOptions;
  readonly loaded: LoadedRun;
  readonly url: string;
  readonly forge: ForgeKind;
  readonly forgeDeps: WorkflowForgeDeps;
  /** One read serves the `items-ruled` check and all three actions that need the entries. */
  readonly found: FoundSidecar | null;
  readonly entries: readonly DecisionEntry[];
  readonly prRulings: PrRulingsReport;
}

/** The three actions that are a forge command; `record` writes to disk instead. */
type ForgeAction = "tick" | "comment" | "ready";

/** The action line the failure names, and what the forge said: its stderr, or its bare exit code. */
function stopped(action: ForgeAction, result: ForgeRunResult): NaxError {
  return invalid(`promote stopped at ${action}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

/** Runs one forge write. A non-zero exit stops the promotion there; the later actions never run. */
async function forgeWrite(target: PromoteTarget, action: ForgeAction, argv: string[]): Promise<void> {
  const result = await target.forgeDeps.forge.run(argv, { cwd: target.opts.dir });
  if (result.exitCode !== 0) throw stopped(action, result);
}

/**
 * `tick`: the body as the forge holds it *now* — read again immediately before the write, so an edit
 * a human made while the checks ran is not reverted — with every ruled entry's line ticked. Nothing
 * to tick is `skipped`, not a failure: a checklist line may have been edited away.
 */
async function tickAction(target: PromoteTarget, entries: readonly DecisionEntry[]): Promise<PromoteAction> {
  const state = await readPrState(target.forge, target.url, target.forgeDeps.forge, target.opts.dir);
  const { body, ticked } = tickChecklist(state.body, entries);
  if (ticked.length === 0) return { name: "tick", status: "skipped" };
  await forgeWrite(target, "tick", editBodyArgv(target.forge, target.url, body));
  return { name: "tick", status: "done" };
}

/** `comment`: the one evidence comment the sidecar's entries produce; a run with none posts nothing. */
async function commentAction(target: PromoteTarget, entries: readonly DecisionEntry[]): Promise<PromoteAction> {
  if (entries.length === 0) return { name: "comment", status: "skipped" };
  await forgeWrite(target, "comment", commentArgv(target.forge, target.url, evidenceComment(entries)));
  return { name: "comment", status: "done" };
}

/** `ready`: the PR itself, once its body and the evidence comment are in place. */
async function readyAction(target: PromoteTarget): Promise<PromoteAction> {
  await forgeWrite(target, "ready", markReadyArgv(target.forge, target.url));
  return { name: "ready", status: "done" };
}

/** A run with no local sidecar gets the merged entries and the outcome this promotion produced. */
function promotedSidecar(target: PromoteTarget, now: Date): DecisionsSidecar {
  return {
    artifact: `${target.loaded.runId}/result.json`,
    feature: target.opts.feature,
    resumedAt: isoStamp(now),
    reasons: target.loaded.reasons,
    decisions: target.entries,
    outcome: "promoted",
    url: target.url,
  };
}

/**
 * `record`: the run's newest sidecar — or a new one — rewritten to say `promoted`. A sidecar
 * the run already has keeps its reasons and file name, merging current PR entries beneath its
 * local entries so a human's local ruling survives. Its `outcome` is overwritten whatever it was,
 * `abandoned` included.
 */
async function recordAction(target: PromoteTarget): Promise<PromoteAction> {
  const now = target.forgeDeps.now();
  const found = target.found;
  const path = found?.path ?? join(target.loaded.runDir, sidecarFileName(now));
  const sidecar: DecisionsSidecar = found
    ? { ...found.sidecar, decisions: target.entries, outcome: "promoted", url: target.url }
    : promotedSidecar(target, now);
  await writeSidecar(path, sidecar);
  return { name: "record", status: "done" };
}

/**
 * The four actions, in the spec's order, each awaited before the next starts: a failure throws out of
 * here, so the actions after it never run — `ready` is never issued for a body that was not ticked.
 */
async function promoteActions(target: PromoteTarget): Promise<PromoteAction[]> {
  const entries = target.entries;
  const actions: PromoteAction[] = [];
  actions.push(await tickAction(target, entries));
  actions.push(await commentAction(target, entries));
  actions.push(await readyAction(target));
  actions.push(await recordAction(target));
  return actions;
}

/** The report. `promoted` is true only when the actions ran; a dry run is a report, not a promotion. */
function reportOf(input: {
  readonly target: PromoteTarget;
  readonly checks: readonly PromoteCheck[];
  readonly promoted: boolean;
  readonly actions: readonly PromoteAction[];
}): WorkflowPromoteReport {
  return {
    feature: input.target.opts.feature,
    runId: input.target.loaded.runId,
    url: input.target.url,
    dryRun: !input.promoted,
    promoted: input.promoted,
    prRulings: input.target.prRulings,
    checks: input.checks,
    actions: input.actions,
  };
}

/** The whole command, in the spec's order: every refusal happens before a check runs. */
async function promote(opts: WorkflowPromoteOptions, forgeDeps: WorkflowForgeDeps): Promise<WorkflowPromoteReport> {
  validateFeatureName(opts.feature);
  const loaded = await loadRunVerdict(opts.dir, opts.feature, forgeDeps.resolveOutputDir);
  const url = draftUrl(loaded, opts.feature);
  const forge = await draftForge(forgeDeps, opts.dir, url);
  const expectedSha = await headSha(forgeDeps.forge, opts.dir);
  const found = await newestSidecar(loaded.runDir);
  // B2: a sidecar the run's own items do not own is refused before a check runs and before any write:
  // its entries are what the tick, the evidence comment and the `promoted` record are built from.
  if (found) checkEntriesAgainstItems(found.sidecar.decisions, loaded.openItems, loaded.supplementaryItems);
  const rulings = await readPromoteRulings({
    url,
    cwd: opts.dir,
    deps: forgeDeps.forge,
    items: loaded.openItems,
    local: found?.sidecar.decisions ?? [],
  });
  const checks = [
    itemsRuled(loaded, found, rulings.entries),
    await ciGreen({ forgeDeps, forge, url, dir: opts.dir, expectedSha }),
  ];
  const target: PromoteTarget = { opts, loaded, url, forge, forgeDeps, found, ...rulings };
  if (!opts.yes || !allPassed(checks)) return reportOf({ target, checks, promoted: false, actions: [] });
  return reportOf({ target, checks, promoted: true, actions: await promoteActions(target) });
}

/** `pass  <name>` / `FAIL  <name>  <detail>` — a passing check has no detail to print. */
function checkLine(check: PromoteCheck): string {
  return check.passed ? `pass  ${check.name}` : `FAIL  ${check.name}  ${check.detail}`;
}

/** `tick  done` / `comment  skipped` — one line per action, in the order the actions ran. */
function actionLine(action: PromoteAction): string {
  return `${action.name}  ${action.status}`;
}

function printPlain(report: WorkflowPromoteReport, deps: WorkflowCliDeps): void {
  for (const check of report.checks) deps.log(checkLine(check));
  for (const action of report.actions) deps.log(actionLine(action));
  if (allPassed(report.checks)) deps.log(report.promoted ? `promoted ${report.url}` : READY_LINE);
}

/** Prints the report (or, with `--json`, `{"error": …}`) and returns the exit code. */
export async function workflowPromoteCommand(
  opts: WorkflowPromoteOptions,
  deps: WorkflowCliDeps,
  forgeDeps: WorkflowForgeDeps,
): Promise<number> {
  try {
    const report = await promote(opts, forgeDeps);
    if (opts.json) deps.log(JSON.stringify(report));
    else printPlain(report, deps);
    return allPassed(report.checks) ? 0 : 2;
  } catch (err) {
    const message = errorMessage(err);
    if (opts.json) deps.log(JSON.stringify({ error: message }));
    else deps.logErr(message);
    return 1;
  }
}

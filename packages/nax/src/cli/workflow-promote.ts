/**
 * `nax workflow promote` (SPEC-workflow-record-promote, US-004) — the validation steps, the
 * `items-ruled` and `ci-green` checks, and the dry run.
 *
 * Promotion has rules a finishing tool would otherwise re-derive on every run: the record must still
 * be a draft, the PR it names must still be a draft, and every item the run left open must carry a
 * ruling and the pushed head's checks must be green. `promote` states them once and reports them as
 * two named checks, so a caller reads which rule refused instead of parsing a message.
 *
 * This story writes nothing to the forge: with every check passing it prints the dry-run result
 * whether or not `--yes` was given, and the `--yes` writes (tick, comment, ready, record) are
 * US-005's. Every refusal happens before that point, so a failed call leaves the run directory and
 * the PR exactly as they were.
 *
 * The workflow leaves are reached by relative path, not through the `@/workflow` barrel, for the
 * reason `src/cli/workflow.ts` gives: that barrel loads `step-context`, which imports `@/cli`. HEAD
 * is read through `forgeDeps.forge.run` rather than `readHead` (`src/workflow/git.ts`) for the same
 * reason, and `src/cli/workflow.ts` is imported type-only, which is erased.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { detectForge, type ForgeDeps, type ForgeKind } from "@/forge";
import { validateFeatureName } from "@/utils/feature-name";
import { newestSidecar } from "../workflow/decisions-sidecar";
import { readPrState } from "../workflow/pr-state";
import { type LoadedRun, loadRunVerdict } from "../workflow/run-verdict";
import type { WorkflowCliDeps } from "./workflow";
import type { WorkflowForgeDeps } from "./workflow-forge";

export interface WorkflowPromoteOptions {
  /** The project directory, as for `status`. */
  readonly dir: string;
  readonly feature: string;
  /**
   * The promotion itself. US-004 performs no forge write, so this changes no output; US-005 runs the
   * tick, comment, ready and record actions behind it.
   */
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

/** `items-ruled`: every open item id carries a ruling in the run's newest sidecar. */
async function itemsRuled(loaded: LoadedRun): Promise<PromoteCheck> {
  const ids = loaded.openItems.map((item) => item.id);
  if (ids.length === 0) return { name: "items-ruled", passed: true, detail: "" };
  const found = await newestSidecar(loaded.runDir);
  if (found === null) {
    return { name: "items-ruled", passed: false, detail: "no decisions recorded; run nax workflow record" };
  }
  const ruled = new Set(found.sidecar.decisions.map((entry) => entry.id));
  const unruled = ids.filter((id) => !ruled.has(id));
  return unruled.length === 0
    ? { name: "items-ruled", passed: true, detail: "" }
    : { name: "items-ruled", passed: false, detail: `no ruling recorded for ${unruled.join(", ")}` };
}

/** `ci-green`: the pushed head's checks passed. Anything else — including a mismatch — is a refusal. */
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
  return result.outcome === "green"
    ? { name: "ci-green", passed: true, detail: "" }
    : { name: "ci-green", passed: false, detail: `ci ${result.outcome}: ${result.detail}` };
}

const allPassed = (checks: readonly PromoteCheck[]): boolean => checks.every((check) => check.passed);

/** The report. US-004 performs no forge write, so the run is always the dry run. */
function reportOf(
  opts: WorkflowPromoteOptions,
  loaded: LoadedRun,
  url: string,
  checks: PromoteCheck[],
): WorkflowPromoteReport {
  return {
    feature: opts.feature,
    runId: loaded.runId,
    url,
    dryRun: true,
    promoted: false,
    checks,
    actions: [],
  };
}

/** The whole command, in the spec's order: every refusal happens before a check runs. */
async function promote(opts: WorkflowPromoteOptions, forgeDeps: WorkflowForgeDeps): Promise<WorkflowPromoteReport> {
  validateFeatureName(opts.feature);
  const loaded = await loadRunVerdict(opts.dir, opts.feature);
  const url = draftUrl(loaded, opts.feature);
  const forge = await draftForge(forgeDeps, opts.dir, url);
  const expectedSha = await headSha(forgeDeps.forge, opts.dir);
  const checks = [await itemsRuled(loaded), await ciGreen({ forgeDeps, forge, url, dir: opts.dir, expectedSha })];
  return reportOf(opts, loaded, url, checks);
}

/** `pass  <name>` / `FAIL  <name>  <detail>` — a passing check has no detail to print. */
function checkLine(check: PromoteCheck): string {
  return check.passed ? `pass  ${check.name}` : `FAIL  ${check.name}  ${check.detail}`;
}

function printPlain(report: WorkflowPromoteReport, deps: WorkflowCliDeps): void {
  for (const check of report.checks) deps.log(checkLine(check));
  if (allPassed(report.checks)) deps.log(READY_LINE);
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

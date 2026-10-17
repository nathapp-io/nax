/**
 * `nax workflow record` (SPEC-workflow-record-promote, US-002) — the validated writer of a run's
 * decisions sidecar.
 *
 * The sidecar used to be hand-written, and nothing checked that an entry's `id` named something the
 * run actually left open. `record` makes the writer a command: it loads the newest run of the
 * feature through the same loader `status` uses, validates every entry against that run's open-item
 * ids and kinds, and only then writes. Every refusal happens before the first byte is written, so a
 * failed call leaves the run directory exactly as it was.
 *
 * The workflow leaves are reached by relative path, not through the `@/workflow` barrel, for the
 * reason `src/cli/workflow.ts` gives: that barrel loads `step-context`, which imports `@/cli`. Types
 * come from `./workflow` and `./workflow-forge`, which is a type-only edge and therefore erased
 * (`bun run check:import-cycles`).
 */
import { join, relative } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { detectForge, type ForgeKind } from "@/forge";
import { validateFeatureName } from "@/utils/feature-name";
import {
  checkEntriesAgainstItems,
  type DecisionEntry,
  type DecisionsSidecar,
  isoStamp,
  mergeDecisions,
  newestSidecar,
  parseDecisionEntries,
  SIDECAR_OUTCOMES,
  type SidecarOutcome,
  sidecarFileName,
  writeSidecar,
} from "../workflow/decisions-sidecar";
import { readPrState } from "../workflow/pr-state";
import { type LoadedRun, loadRunVerdict } from "../workflow/run-verdict";
import type { WorkflowCliDeps } from "./workflow";
import type { WorkflowForgeDeps } from "./workflow-forge";

export interface WorkflowRecordOptions {
  /** The project directory, as for `status`. */
  readonly dir: string;
  readonly feature: string;
  /** A JSON array of decision entries, when the call records any. */
  readonly decisions?: string;
  /** One of `SIDECAR_OUTCOMES`, when the call records one. Validated here, so it stays a string. */
  readonly outcome?: string;
  readonly json: boolean;
}

/** What `--json` prints. */
export interface WorkflowRecordReport {
  readonly feature: string;
  readonly runId: string;
  /** The sidecar's path relative to the project directory. */
  readonly sidecar: string;
  readonly outcome: SidecarOutcome;
  /** Entries in the sidecar after the write. */
  readonly decisions: number;
  /** The open item ids the sidecar still names no entry for. */
  readonly unruled: readonly string[];
}

const RECORD_INVALID = "WORKFLOW_RECORD_INVALID";

/** The two outcomes that claim the PR itself is where it should be, so both need the live PR read. */
const PR_OUTCOMES: readonly SidecarOutcome[] = ["promoted", "verified-ready"];

function invalid(message: string, context: Record<string, unknown> = {}): NaxError {
  return new NaxError(message, RECORD_INVALID, { stage: "workflow", ...context });
}

const isOutcome = (value: string): value is SidecarOutcome => (SIDECAR_OUTCOMES as readonly string[]).includes(value);

/** Steps 2 and 3: there must be something to record, and an outcome must be one of the four. */
function outcomeOf(opts: WorkflowRecordOptions): SidecarOutcome | undefined {
  if (opts.outcome === undefined && opts.decisions === undefined) {
    throw invalid("nothing to record: pass --decisions or --outcome");
  }
  if (opts.outcome === undefined) return undefined;
  if (!isOutcome(opts.outcome)) throw invalid(`outcome must be one of ${SIDECAR_OUTCOMES.join(", ")}`);
  return opts.outcome;
}

/** Step 5: the decisions file — a JSON array of entries, read and validated whole before any write. */
async function readDecisionsFile(path: string): Promise<DecisionEntry[]> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (err) {
    throw invalid(`cannot read decisions file: ${path}`, { path, cause: err });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalid(`decisions file is not valid JSON: ${path}`, { path, cause: err });
  }
  return parseDecisionEntries(raw);
}

/** What the command's steps need beyond their own inputs: the project directory and the forge. */
interface RecordContext {
  readonly dir: string;
  readonly forgeDeps: WorkflowForgeDeps;
}

/**
 * Step 6: the record's PR url, once the forge confirms the PR is not a draft. Only `promoted` and
 * `verified-ready` come here — a human recording any other outcome is trusted.
 */
async function readyPrUrl(outcome: SidecarOutcome, loaded: LoadedRun, ctx: RecordContext): Promise<string> {
  const url = loaded.record.url;
  if (url === undefined) throw invalid(`cannot record outcome ${outcome}: the workflow result has no PR url`);
  const forge: ForgeKind | null = await detectForge(ctx.forgeDeps.forge, ctx.dir);
  if (forge === null) throw invalid(`no forge detected for ${ctx.dir}`);
  const state = await readPrState(forge, url, ctx.forgeDeps.forge, ctx.dir);
  if (state.isDraft) throw invalid(`cannot record outcome ${outcome}: PR is still a draft`);
  return url;
}

interface Written {
  readonly path: string;
  readonly sidecar: DecisionsSidecar;
}

/** Step 7's whole input: what to record, into which run, and the clock the new file is named by. */
interface WriteInput {
  readonly opts: WorkflowRecordOptions;
  readonly loaded: LoadedRun;
  readonly entries: readonly DecisionEntry[];
  readonly outcome: SidecarOutcome | undefined;
  /** The record's url, resolved by step 6 for the two PR outcomes only. */
  readonly prUrl: string | undefined;
  readonly now: Date;
}

/** The sidecar a run has none of: built from the incoming entries and the record's own facts. */
function newSidecar(input: WriteInput): DecisionsSidecar {
  const url = input.loaded.record.url;
  return {
    artifact: `${input.loaded.runId}/result.json`,
    feature: input.opts.feature,
    resumedAt: isoStamp(input.now),
    reasons: input.loaded.reasons,
    decisions: input.entries,
    outcome: input.outcome ?? "pending",
    ...(url === undefined ? {} : { url }),
  };
}

/** The sidecar a run already has: the incoming entries merged by id, `--outcome` applied, rest kept. */
function updatedSidecar(existing: DecisionsSidecar, input: WriteInput): DecisionsSidecar {
  return {
    ...existing,
    decisions: mergeDecisions(existing.decisions, input.entries),
    outcome: input.outcome ?? existing.outcome,
    ...(input.prUrl === undefined ? {} : { url: input.prUrl }),
  };
}

/**
 * Step 7: the write. An existing sidecar is rewritten in place; a run with none gets exactly one,
 * named by the clock. `--outcome` alone cannot create one — there would be nothing to rule.
 *
 * The existing sidecar's own entries are cross-checked against the run before the merge (B2): the
 * file may have been hand-written or left by an earlier run, and a ruling the run does not own must
 * not ride into the rewrite just because it sat in the file.
 */
async function writeRecorded(input: WriteInput): Promise<Written> {
  const found = await newestSidecar(input.loaded.runDir);
  if (found) {
    checkEntriesAgainstItems(found.sidecar.decisions, input.loaded.openItems);
    const sidecar = updatedSidecar(found.sidecar, input);
    await writeSidecar(found.path, sidecar);
    return { path: found.path, sidecar };
  }
  if (input.opts.decisions === undefined) {
    throw invalid(`no decisions sidecar for run ${input.loaded.runId}; pass --decisions`);
  }
  const path = join(input.loaded.runDir, sidecarFileName(input.now));
  const sidecar = newSidecar(input);
  await writeSidecar(path, sidecar);
  return { path, sidecar };
}

function reportOf(opts: WorkflowRecordOptions, loaded: LoadedRun, written: Written): WorkflowRecordReport {
  const ruled = new Set(written.sidecar.decisions.map((entry) => entry.id));
  return {
    feature: opts.feature,
    runId: loaded.runId,
    sidecar: relative(opts.dir, written.path),
    outcome: written.sidecar.outcome,
    decisions: written.sidecar.decisions.length,
    unruled: loaded.openItems.map((item) => item.id).filter((id) => !ruled.has(id)),
  };
}

/** The whole command, in the spec's validation order; throws before it writes anything. */
async function record(opts: WorkflowRecordOptions, forgeDeps: WorkflowForgeDeps): Promise<WorkflowRecordReport> {
  validateFeatureName(opts.feature);
  const outcome = outcomeOf(opts);
  const ctx: RecordContext = { dir: opts.dir, forgeDeps };
  const loaded = await loadRunVerdict(opts.dir, opts.feature);
  const entries = opts.decisions === undefined ? [] : await readDecisionsFile(opts.decisions);
  checkEntriesAgainstItems(entries, loaded.openItems);
  const prUrl =
    outcome !== undefined && PR_OUTCOMES.includes(outcome) ? await readyPrUrl(outcome, loaded, ctx) : undefined;
  const written = await writeRecorded({ opts, loaded, entries, outcome, prUrl, now: forgeDeps.now() });
  return reportOf(opts, loaded, written);
}

function printPlain(report: WorkflowRecordReport, deps: WorkflowCliDeps): void {
  deps.log(
    `${report.feature}: recorded ${report.decisions} decision(s) in ${report.sidecar}; outcome ${report.outcome}`,
  );
  if (report.unruled.length > 0) deps.log(`unruled: ${report.unruled.join(", ")}`);
}

/** Prints the report (or, with `--json`, `{"error": …}`) and returns the exit code. */
export async function workflowRecordCommand(
  opts: WorkflowRecordOptions,
  deps: WorkflowCliDeps,
  forgeDeps: WorkflowForgeDeps,
): Promise<number> {
  try {
    const report = await record(opts, forgeDeps);
    if (opts.json) deps.log(JSON.stringify(report));
    else printPlain(report, deps);
    return 0;
  } catch (err) {
    const message = errorMessage(err);
    if (opts.json) deps.log(JSON.stringify({ error: message }));
    else deps.logErr(message);
    return 1;
  }
}

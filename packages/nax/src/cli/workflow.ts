/**
 * The `nax workflow` group — `status` lives here, `record` in `./workflow-record` and `promote` in
 * `./workflow-promote`.
 *
 * `status` is read-only: it reads the feature's `workflow/<runId>/result.json` files and writes
 * nothing. A finishing tool reads one list here instead of rebuilding it from `result.json`, the
 * branch re-review, the ledger and the advisor ledger.
 *
 * The workflow leaves below are reached by relative path rather than through the `@/workflow`
 * barrel on purpose: that barrel loads `step-context`, which imports `@/cli`, and `@/cli` re-exports
 * this module — routing through it would close a runtime import cycle
 * (`bun run check:import-cycles`). Types are imported from the barrel; type-only imports are erased
 * and cannot take part in module initialisation.
 */
import { relative } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { prNumberFromUrl } from "@/forge";
import type { FeatureCiState, FeatureOutcome, FeatureStep, OpenItem } from "@/workflow";
import { readLiveStatus } from "../workflow/live-status";
import { buildVerdict, CI_ITEM_ID } from "../workflow/open-items";
import { fillStoryStates, type LoadedRun, loadRunVerdict } from "../workflow/run-verdict";
import { _workflowForgeDeps, type WorkflowForgeDeps } from "./workflow-forge";
import { workflowPromoteCommand } from "./workflow-promote";
import { workflowRecordCommand } from "./workflow-record";

export interface WorkflowCliDeps {
  log: (msg: string) => void;
  logErr: (msg: string) => void;
  exit: (code: number) => void;
}

/** The real process: stdout for the report (and `--json`'s error object), stderr for a plain error. */
export const _workflowCliDeps: WorkflowCliDeps = {
  log: (msg) => {
    console.log(msg);
  },
  logErr: (msg) => {
    console.error(msg);
  },
  exit: (code) => {
    process.exit(code);
  },
};

export interface WorkflowStatusOptions {
  readonly dir: string;
  readonly feature: string;
  readonly json: boolean;
}

/** What `--json` prints. `outcome`, `ci`, `url` and `workflowPassed` are absent before publish. */
export interface WorkflowStatusReport {
  readonly source: "live" | "run-record";
  readonly liveError?: string;
  readonly settledItems: readonly { id: string; disposition: string }[];
  readonly feature: string;
  readonly runId: string;
  /** The run directory, relative to the project directory. */
  readonly runDir: string;
  readonly step: FeatureStep;
  readonly outcome?: FeatureOutcome;
  readonly ci?: FeatureCiState;
  readonly url?: string;
  readonly workflowPassed?: boolean;
  readonly reasons: readonly string[];
  readonly openItems: readonly OpenItem[];
  /** #2578: items a finisher rules on that `openItems` does not hold; they never change the exit code. */
  readonly supplementaryItems: readonly OpenItem[];
}

const NOT_PUBLISHED = "not published";
const NO_ITEMS = "No open items.";
const SUPPLEMENTARY_HEADING = "Also to verify (not blocking):";

/**
 * The report of the newest readable run. The run, its record and the open items all come from
 * `loadRunVerdict` (US-002 moved that loading out of this file); the verdict is rebuilt here only
 * for the two fields it owns, which the run's loader does not carry.
 */
function reportFor(dir: string, feature: string, loaded: LoadedRun): WorkflowStatusReport {
  const { record } = loaded;
  const verdict = buildVerdict(fillStoryStates(record, loaded.result));
  return {
    source: "run-record",
    settledItems: [],
    feature,
    runId: loaded.runId,
    runDir: relative(dir, loaded.runDir),
    step: record.step,
    ...(verdict ? { outcome: verdict.outcome, workflowPassed: verdict.workflowPassed } : {}),
    ...(record.ci === undefined ? {} : { ci: record.ci }),
    ...(record.url === undefined ? {} : { url: record.url }),
    reasons: record.reasons,
    openItems: loaded.openItems,
    supplementaryItems: loaded.supplementaryItems,
  };
}

/** The verdict of the newest readable run, or the error that says why there is none. */
async function buildReport(dir: string, feature: string, forgeDeps: WorkflowForgeDeps): Promise<WorkflowStatusReport> {
  const loaded = await loadRunVerdict(dir, feature, forgeDeps.resolveOutputDir);
  const report = reportFor(dir, feature, loaded);
  const { outcome, url } = loaded.record;
  if (outcome !== "draft" || !url || prNumberFromUrl(url) === null) return report;
  const live = await readLiveStatus({ url, cwd: dir, deps: forgeDeps.forge, items: report.openItems });
  if (live.source === "run-record") return { ...report, liveError: live.error };
  const settled = new Set(live.settled.map((item) => item.id));
  return {
    ...report,
    source: "live",
    outcome: live.isDraft ? "draft" : "ready",
    settledItems: live.settled,
    openItems: report.openItems.filter((item) => !settled.has(item.id) && (live.isDraft || item.id !== CI_ITEM_ID)),
  };
}

/** 0 only when the feature is ready with nothing open; anything else needs a human. */
function exitCodeFor(report: WorkflowStatusReport): number {
  return report.outcome === "ready" && report.openItems.length === 0 ? 0 : 2;
}

const itemLine = (item: OpenItem): string => `- [${item.kind}] ${item.id} — ${item.issue}`;

function printPlain(report: WorkflowStatusReport, deps: WorkflowCliDeps): void {
  const outcome = report.outcome ?? NOT_PUBLISHED;
  deps.log(`${report.feature}: ${outcome}${report.url ? ` ${report.url}` : ""}`);
  if (report.liveError !== undefined) deps.log(`(run record only: ${report.liveError})`);
  if (report.openItems.length === 0) deps.log(NO_ITEMS);
  for (const item of report.openItems) deps.log(itemLine(item));
  if (report.supplementaryItems.length === 0) return;
  deps.log(SUPPLEMENTARY_HEADING);
  for (const item of report.supplementaryItems) deps.log(itemLine(item));
}

/** Prints the verdict (or, with `--json`, `{"error": …}`) and returns the exit code. */
export async function workflowStatusCommand(
  opts: WorkflowStatusOptions,
  deps: WorkflowCliDeps = _workflowCliDeps,
  forgeDeps: WorkflowForgeDeps = _workflowForgeDeps,
): Promise<number> {
  try {
    const report = await buildReport(opts.dir, opts.feature, forgeDeps);
    if (opts.json) deps.log(JSON.stringify(report));
    else printPlain(report, deps);
    return exitCodeFor(report);
  } catch (err) {
    const message = errorMessage(err);
    if (opts.json) deps.log(JSON.stringify({ error: message }));
    else deps.logErr(message);
    return 1;
  }
}

async function guarded(deps: WorkflowCliDeps, body: () => Promise<number>): Promise<void> {
  try {
    deps.exit(await body());
  } catch (err) {
    deps.logErr(`error: ${errorMessage(err)}`);
    deps.exit(1);
  }
}

/** Register `nax workflow status`, `nax workflow record` and `nax workflow promote`. */
export function registerWorkflowCommand(
  program: Command,
  deps: WorkflowCliDeps = _workflowCliDeps,
  forgeDeps: WorkflowForgeDeps = _workflowForgeDeps,
): Command {
  const group = program.command("workflow").description("Inspect a feature's workflow run");
  group
    .command("status")
    .description("Print the verdict for the feature's newest workflow run")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "Emit one machine-readable JSON document", false)
    .action((o: { dir: string; feature: string; json?: boolean }) =>
      guarded(deps, () =>
        workflowStatusCommand({ dir: o.dir, feature: o.feature, json: o.json === true }, deps, forgeDeps),
      ),
    );
  group
    .command("record")
    .description("Record a human's rulings and the run's outcome in the decisions sidecar")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("--decisions <file>", "A JSON array of decision entries")
    .option("--outcome <outcome>", "One of pending, promoted, verified-ready, abandoned")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "Emit one machine-readable JSON document", false)
    .action((o: { dir: string; feature: string; decisions?: string; outcome?: string; json?: boolean }) =>
      guarded(deps, () =>
        workflowRecordCommand(
          {
            dir: o.dir,
            feature: o.feature,
            decisions: o.decisions,
            outcome: o.outcome,
            json: o.json === true,
          },
          deps,
          forgeDeps,
        ),
      ),
    );
  group
    .command("promote")
    .description("Check a draft run and report whether its PR can be promoted")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("--yes", "Promote for real once every check passes", false)
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "Emit one machine-readable JSON document", false)
    .action((o: { dir: string; feature: string; yes?: boolean; json?: boolean }) =>
      guarded(deps, () =>
        workflowPromoteCommand(
          { dir: o.dir, feature: o.feature, yes: o.yes === true, json: o.json === true },
          deps,
          forgeDeps,
        ),
      ),
    );
  return group;
}

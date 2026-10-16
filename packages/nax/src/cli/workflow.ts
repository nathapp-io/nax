/**
 * `nax workflow status` — the verdict of a feature's newest workflow run (spec US-003).
 *
 * Read-only: it reads the feature's `workflow/<runId>/result.json` files and writes nothing. A
 * finishing tool reads one list here instead of rebuilding it from `result.json`, the branch
 * re-review, the ledger and the advisor ledger.
 *
 * The workflow leaves below are reached by relative path rather than through the `@/workflow`
 * barrel on purpose: that barrel loads `step-context`, which imports `@/cli`, and `@/cli` re-exports
 * this module — routing through it would close a runtime import cycle
 * (`bun run check:import-cycles`). Types are imported from the barrel; type-only imports are erased
 * and cannot take part in module initialisation.
 */
import { basename, relative } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { NaxError } from "@/errors";
import { validateFeatureName } from "@/utils/feature-name";
import type {
  FeatureCiState,
  FeatureOutcome,
  FeatureStep,
  OpenItem,
  WorkflowFeatureRecord,
  WorkflowResultFile,
} from "@/workflow";
import { buildOpenItems, buildVerdict } from "../workflow/open-items";
import { workflowFeatureDir } from "../workflow/paths";
import { readResult, runDirsNewestFirst, storyStatesFrom } from "../workflow/result";

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
}

const NOT_PUBLISHED = "not published";
const NO_ITEMS = "No open items.";

/**
 * The newest run directory whose `result.json` parses. `runDirsNewestFirst` already drops the
 * directories holding no `result.json`; an unreadable or non-JSON one is skipped for the next.
 */
async function newestResult(
  dir: string,
  feature: string,
): Promise<{ runId: string; runDir: string; result: WorkflowResultFile } | null> {
  for (const runDir of await runDirsNewestFirst(workflowFeatureDir(dir, feature))) {
    const result = await readResult(runDir);
    if (result) return { runId: basename(runDir), runDir, result };
  }
  return null;
}

/**
 * US-002/US-003: the record carries its own `storyStates` when `publish` wrote them; a record from
 * an older nax (or a run that never reached publish) leaves the stories to `result.stories`, read
 * here with the same rule `upsertFeatureRecord` applies — so both report the same items.
 */
function fillStoryStates(record: WorkflowFeatureRecord, result: WorkflowResultFile): WorkflowFeatureRecord {
  return record.storyStates ? record : { ...record, storyStates: storyStatesFrom(result.stories) };
}

function reportFor(
  dir: string,
  feature: string,
  found: { runId: string; runDir: string; result: WorkflowResultFile },
): WorkflowStatusReport {
  const record = found.result.featureWorkflow;
  if (!record) throw notStarted(feature, found.runId);
  const filled = fillStoryStates(record, found.result);
  const verdict = buildVerdict(filled);
  return {
    feature,
    runId: found.runId,
    runDir: relative(dir, found.runDir),
    step: record.step,
    ...(verdict ? { outcome: verdict.outcome, workflowPassed: verdict.workflowPassed } : {}),
    ...(record.ci === undefined ? {} : { ci: record.ci }),
    ...(record.url === undefined ? {} : { url: record.url }),
    reasons: record.reasons,
    // A run that never published has no verdict, but its stories still say what is open (AC-13).
    openItems: verdict?.openItems ?? buildOpenItems(filled),
  };
}

function notStarted(feature: string, runId: string): NaxError {
  return new NaxError(
    `workflow for ${feature} has not started its feature steps (run ${runId})`,
    "WORKFLOW_NOT_STARTED",
    { stage: "workflow-status", feature, runId },
  );
}

function noResult(feature: string): NaxError {
  return new NaxError(`no workflow result for feature ${feature}`, "WORKFLOW_RESULT_MISSING", {
    stage: "workflow-status",
    feature,
  });
}

/** The verdict of the newest readable run, or the error that says why there is none. */
async function buildReport(dir: string, feature: string): Promise<WorkflowStatusReport> {
  validateFeatureName(feature);
  const found = await newestResult(dir, feature);
  if (!found) throw noResult(feature);
  return reportFor(dir, feature, found);
}

/** 0 only when the feature is ready with nothing open; anything else needs a human. */
function exitCodeFor(report: WorkflowStatusReport): number {
  return report.outcome === "ready" && report.openItems.length === 0 ? 0 : 2;
}

function printPlain(report: WorkflowStatusReport, deps: WorkflowCliDeps): void {
  const outcome = report.outcome ?? NOT_PUBLISHED;
  deps.log(`${report.feature}: ${outcome}${report.url ? ` ${report.url}` : ""}`);
  if (report.openItems.length === 0) {
    deps.log(NO_ITEMS);
    return;
  }
  for (const item of report.openItems) deps.log(`- [${item.kind}] ${item.id} — ${item.issue}`);
}

/** Prints the verdict (or, with `--json`, `{"error": …}`) and returns the exit code. */
export async function workflowStatusCommand(
  opts: WorkflowStatusOptions,
  deps: WorkflowCliDeps = _workflowCliDeps,
): Promise<number> {
  try {
    const report = await buildReport(opts.dir, opts.feature);
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

/** Register `nax workflow status`. */
export function registerWorkflowCommand(program: Command, deps: WorkflowCliDeps = _workflowCliDeps): Command {
  const group = program.command("workflow").description("Inspect a feature's workflow run");
  group
    .command("status")
    .description("Print the verdict for the feature's newest workflow run")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "Emit one machine-readable JSON document", false)
    .action((o: { dir: string; feature: string; json?: boolean }) =>
      guarded(deps, () => workflowStatusCommand({ dir: o.dir, feature: o.feature, json: o.json === true }, deps)),
    );
  return group;
}

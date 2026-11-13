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
import type {
  ConfigChangeRecord,
  FeatureCiState,
  FeatureOutcome,
  FeatureStep,
  OpenItem,
  WorkflowResultFile,
} from "@/workflow";
import type { CiWaiver } from "@/workflow/ci-waiver";
import {
  type DecisionEntry,
  type DecisionsSidecar,
  newestSidecar,
  type SidecarOutcome,
  sidecarKindFor,
} from "../workflow/decisions-sidecar";
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
  /** Set only by a live read of a PR that is no longer a draft; absent otherwise. */
  readonly ciWaiver?: CiWaiver;
  /** #2578: items a finisher rules on that `openItems` does not hold; they never change the exit code. */
  readonly supplementaryItems: readonly OpenItem[];
  /**
   * US-004: the record says `publish` ended with no item index on the PR, so every bot command will
   * refuse it. Present only when the record's own field is `true` — never `false` — so an older
   * record and a publish that wrote an index read exactly as they did before.
   */
  readonly itemIndexMissing?: true;
  /**
   * US-004: the decisions sidecar a failed live read was settled from, relative to the project
   * directory. Absent whenever the report is the live read's own, which never consults a sidecar.
   */
  readonly decisions?: string;
  /**
   * US-006: every config change the run's stories recorded, flattened with the story it belongs to
   * (round, key, `from`, `to`, `applied`, `reason`, `decisionId` kept as recorded). Present only when
   * a story recorded one — an old record and a run that changed nothing read exactly as before.
   */
  configChanges?: readonly ({ storyId: string } & ConfigChangeRecord)[];
}

const NOT_PUBLISHED = "not published";
const NO_ITEMS = "No open items.";
const SUPPLEMENTARY_HEADING = "Also to verify (not blocking):";

/** The sidecar outcomes that say the PR itself is where it should be, so the report reads ready. */
const READY_SIDECAR_OUTCOMES: readonly SidecarOutcome[] = ["promoted", "verified-ready"];

const missingIndexLine = (feature: string): string =>
  `item index not written; settle items with nax workflow record -f ${feature}`;

/**
 * US-006: every config change the run's stories recorded, in the order `result.json` holds them
 * (story order, then each story's own round order), each flattened with the story it belongs to.
 * The records stay whole, so a consumer keeps the round, both values, the verdict and the decision.
 */
function recordedConfigChanges(result: WorkflowResultFile): ({ storyId: string } & ConfigChangeRecord)[] {
  return Object.values(result.stories).flatMap((story) =>
    (story.configChanges ?? []).map((change) => ({ storyId: story.storyId, ...change })),
  );
}

/**
 * The report of the newest readable run. The run, its record and the open items all come from
 * `loadRunVerdict` (US-002 moved that loading out of this file); the verdict is rebuilt here only
 * for the two fields it owns, which the run's loader does not carry.
 */
function reportFor(dir: string, feature: string, loaded: LoadedRun): WorkflowStatusReport {
  const { record } = loaded;
  const verdict = buildVerdict(fillStoryStates(record, loaded.result));
  const configChanges = recordedConfigChanges(loaded.result);
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
    ...(record.itemIndexMissing === true ? { itemIndexMissing: true as const } : {}),
    reasons: record.reasons,
    openItems: loaded.openItems,
    supplementaryItems: loaded.supplementaryItems,
    ...(configChanges.length === 0 ? {} : { configChanges }),
  };
}

/**
 * US-004: the items a sidecar's entries settle. An entry settles an item when its `id` matches and
 * `sidecarKindFor(item)` is the entry's `kind`; every other entry is ignored. `status` reports, so
 * it filters — unlike `record`, which refuses a file it is about to write, one stale entry here
 * must not reject the valid neighbours beside it.
 */
function settledBy(
  entries: readonly DecisionEntry[],
  items: readonly OpenItem[],
): { id: string; disposition: string }[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  return entries.flatMap((entry) => {
    const item = byId.get(entry.id);
    return item !== undefined && sidecarKindFor(item) === entry.kind
      ? [{ id: entry.id, disposition: entry.disposition }]
      : [];
  });
}

/**
 * US-004: the fields a run's newest sidecar adds to a failed live read's report. `promoted` and
 * `verified-ready` claim the PR is where it should be, so the report reads ready and drops the CI
 * item exactly as the live read of a ready PR does; `pending` and `abandoned` settle items and
 * leave the record's own outcome alone. A `confirmed` advisor entry settles its item: offline there
 * is no thread to show a fix reply on, so the recorded ruling stands.
 */
function sidecarOverlay(
  report: WorkflowStatusReport,
  found: { readonly path: string; readonly sidecar: DecisionsSidecar },
  dir: string,
): WorkflowStatusReport {
  const settled = settledBy(found.sidecar.decisions, [...report.openItems, ...report.supplementaryItems]);
  const gone = new Set(settled.map((item) => item.id));
  const ready = READY_SIDECAR_OUTCOMES.includes(found.sidecar.outcome);
  return {
    ...report,
    decisions: relative(dir, found.path),
    settledItems: settled,
    openItems: report.openItems.filter((item) => !gone.has(item.id) && !(ready && item.id === CI_ITEM_ID)),
    supplementaryItems: report.supplementaryItems.filter((item) => !gone.has(item.id)),
    ...(ready ? { outcome: "ready" as const } : {}),
  };
}

/**
 * US-004: a failed live read is settled from the run's newest sidecar. A file that wears the sidecar
 * name but does not parse leaves the report alone — never an older sidecar, and never an error:
 * `status` reports what the run's records say, and `record` is the command that refuses a broken
 * file. Read only on this path, so a live read stays authoritative.
 */
async function withSidecar(
  report: WorkflowStatusReport,
  loaded: LoadedRun,
  dir: string,
): Promise<WorkflowStatusReport> {
  try {
    const found = await newestSidecar(loaded.runDir);
    return found === null ? report : sidecarOverlay(report, found, dir);
  } catch {
    // no readable sidecar: the report is the run record's own, exactly as it was before US-004
    return report;
  }
}

/** The verdict of the newest readable run, or the error that says why there is none. */
async function buildReport(dir: string, feature: string, forgeDeps: WorkflowForgeDeps): Promise<WorkflowStatusReport> {
  const loaded = await loadRunVerdict(dir, feature, forgeDeps.resolveOutputDir);
  const report = reportFor(dir, feature, loaded);
  const { outcome, url } = loaded.record;
  const needsLiveStatus = outcome === "draft" || (outcome === "ready" && report.openItems.length > 0);
  if (!needsLiveStatus || !url || prNumberFromUrl(url) === null) return report;
  const live = await readLiveStatus({ url, cwd: dir, deps: forgeDeps.forge, items: report.openItems });
  if (live.source === "run-record") return withSidecar({ ...report, liveError: live.error }, loaded, dir);
  const settled = new Set(live.settled.map((item) => item.id));
  return {
    ...report,
    source: "live",
    outcome: live.isDraft ? "draft" : "ready",
    settledItems: live.settled,
    ...(live.ciWaiver && !live.isDraft ? { ciWaiver: live.ciWaiver } : {}),
    openItems: report.openItems.filter((item) => !settled.has(item.id) && (live.isDraft || item.id !== CI_ITEM_ID)),
  };
}

/** 0 only when the feature is ready with nothing open; anything else needs a human. */
function exitCodeFor(report: WorkflowStatusReport): number {
  return report.outcome === "ready" && report.openItems.length === 0 ? 0 : 2;
}

const itemLine = (item: OpenItem): string => `- [${item.kind}] ${item.id} — ${item.issue}`;

/** Short-sha length for display; the full 40-hex head is only in the `w-ci-waiver` record itself. */
const SHORT_SHA = 7;

/**
 * The one plain line a waived PR adds. It names the head the waiver was taken at, so a reader can
 * tell it apart from a green CI, and every check that never got a runner, so the waiver's scope is
 * visible without opening the comment.
 */
function waiverLine(waiver: CiWaiver): string {
  const checks = waiver.checks.join("; ");
  return (
    `CI: passed with waiver at ${waiver.headSha.slice(0, SHORT_SHA)}: ` +
    `${waiver.checks.length} check(s) never got a runner (${checks}): ${waiver.reason}`
  );
}

/**
 * US-006: the one plain line a recorded config change adds, in the wording the ledger uses for the
 * same event (see `config-change-absorb`), prefixed with the story it belongs to. A refused change
 * names its reason and the value that was never written; an applied one names both values.
 */
function configChangeLine(entry: { readonly storyId: string } & ConfigChangeRecord): string {
  const key = `quality.commands.${entry.key}`;
  const decision = `(advisor ${entry.decisionId})`;
  if (!entry.applied) {
    const reason = entry.reason === undefined ? "" : ` (${entry.reason})`;
    return `${entry.storyId} config change refused${reason}: ${key} -> "${entry.to}" ${decision}`;
  }
  const was = entry.from === undefined ? "" : ` "${entry.from}"`;
  return `${entry.storyId} config change applied: ${key}${was} -> "${entry.to}" ${decision}`;
}

function printPlain(report: WorkflowStatusReport, deps: WorkflowCliDeps): void {
  const outcome = report.outcome ?? NOT_PUBLISHED;
  deps.log(`${report.feature}: ${outcome}${report.url ? ` ${report.url}` : ""}`);
  if (report.liveError !== undefined) deps.log(`(run record only: ${report.liveError})`);
  if (report.itemIndexMissing === true) deps.log(missingIndexLine(report.feature));
  if (report.openItems.length === 0) deps.log(NO_ITEMS);
  for (const item of report.openItems) deps.log(itemLine(item));
  for (const change of report.configChanges ?? []) deps.log(configChangeLine(change));
  if (report.ciWaiver) deps.log(waiverLine(report.ciWaiver));
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
    .option("--waive-starved <reason>", "Accept a CI whose checks never got a runner, and record why")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "Emit one machine-readable JSON document", false)
    .action((o: { dir: string; feature: string; yes?: boolean; waiveStarved?: string; json?: boolean }) =>
      guarded(deps, () =>
        workflowPromoteCommand(
          {
            dir: o.dir,
            feature: o.feature,
            yes: o.yes === true,
            ...(o.waiveStarved === undefined ? {} : { waiveStarved: o.waiveStarved }),
            json: o.json === true,
          },
          deps,
          forgeDeps,
        ),
      ),
    );
  return group;
}

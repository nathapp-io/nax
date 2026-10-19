/**
 * `nax cost` — report the per-call cost ledger (spec US-005).
 *
 * `nax status --cost` reads one project's `metrics.json`: no time window, no
 * token split, no grouping, and no way to separate provider-reported
 * (`confidence: "exact"`) from catalog-estimated cost. The ledger written by
 * `CostAggregator.drain()` at `<outputDir>/cost/<runId>.jsonl` has all of it, so
 * this command is a pure read of those files through the US-004 core
 * (`./cost-ledger-query`) — no LLM call, no writes, no budget checks.
 *
 * Mirrors `src/cli/gates.ts`: the same `_costCliDeps` seam, and the same
 * "anything thrown means nax could not answer, so exit 1" contract. Usage errors
 * (an unknown `--by` key, `COST_USAGE` from `resolveCostWindow`) and any read
 * failure go to stderr as `Error: <message>`; the report goes to stdout — one
 * compact JSON document under `--json`, a table otherwise.
 *
 * `--here` replaces the scan roots with the one project at `--dir`; `--project`
 * only filters rows and combines with `--here`.
 */
import { basename } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { globalConfigDir, loadConfig } from "@/config";
import { NaxError } from "@/errors";
import { projectOutputDir } from "@/runtime";
import {
  COST_GROUP_KEYS,
  type CostGroupKey,
  type CostLedgerReport,
  type CostQuery,
  type CostTotals,
  listCostLedgerFiles,
  listProjectOutputDirs,
  queryCostLedger,
  resolveCostWindow,
} from "./cost-ledger-query";

export interface CostCliDeps {
  /** stdout. */
  log: (msg: string) => void;
  /** stderr. */
  logErr: (msg: string) => void;
  exit: (code: number) => void;
  /** Epoch ms — the clock `--today` is resolved against. */
  now: () => number;
  globalConfigDir: () => string;
  /**
   * Output dir of the project at `dir`: `projectOutputDir(name, outputDir)` from
   * the project's config, falling back to `basename(dir)` with no override when
   * `loadConfig` fails — the resolution `status-cost.ts` makes privately.
   */
  resolveProjectOutputDir: (dir: string) => Promise<string>;
  listProjectOutputDirs: typeof listProjectOutputDirs;
  listCostLedgerFiles: typeof listCostLedgerFiles;
  queryCostLedger: typeof queryCostLedger;
}

async function resolveProjectOutputDir(dir: string): Promise<string> {
  const config = await loadConfig(dir).catch(() => null);
  return projectOutputDir(config?.name?.trim() || basename(dir), config?.outputDir);
}

/** The real process: the report on stdout, `Error: <message>` on stderr. */
export const _costCliDeps: CostCliDeps = {
  log: (msg) => {
    console.log(msg);
  },
  logErr: (msg) => {
    console.error(msg);
  },
  exit: (code) => {
    process.exit(code);
  },
  now: () => Date.now(),
  globalConfigDir,
  resolveProjectOutputDir,
  listProjectOutputDirs,
  listCostLedgerFiles,
  queryCostLedger,
};

export interface CostCommandOptions {
  readonly dir: string;
  readonly today?: boolean;
  readonly since?: string;
  readonly until?: string;
  readonly utc?: boolean;
  /** Comma list of `CostGroupKey`s; absent means no grouping (a total only). */
  readonly by?: string;
  readonly project?: string;
  readonly here?: boolean;
  readonly feature?: string;
  readonly run?: string;
  readonly json?: boolean;
}

/** One column per counter, after the group columns. */
const NUMERIC_COLUMNS = ["calls", "runs", "input", "output", "cacheRead", "cacheWrite", "costUsd"] as const;

/** Column separator; two spaces keeps a padded key readable next to a number. */
const COLUMN_GAP = "  ";

type Cells = readonly string[];

function costUsageError(message: string, data: Record<string, unknown> = {}): NaxError {
  return new NaxError(`[cost] ${message}`, "COST_USAGE", { stage: "cost", ...data });
}

/**
 * `--by` as group keys, in the order given. A key outside `COST_GROUP_KEYS` is a
 * usage error (checked before any config is read or file listed); duplicates are
 * deliberately not rejected (spec, Out of Scope).
 */
function parseGroupBy(by: string | undefined): CostGroupKey[] {
  const raw = by?.trim() ?? "";
  if (raw === "") return [];
  return raw.split(",").map((part) => {
    const key = COST_GROUP_KEYS.find((candidate) => candidate === part.trim());
    if (key === undefined) {
      throw costUsageError(`unknown --by key "${part.trim()}"; expected one of ${COST_GROUP_KEYS.join(", ")}`, {
        key: part.trim(),
      });
    }
    return key;
  });
}

/** The window and row filters as the US-004 query takes them. */
function buildQuery(opts: CostCommandOptions, deps: CostCliDeps, groupBy: readonly CostGroupKey[]): CostQuery {
  const { sinceMs, untilMs } = resolveCostWindow({
    today: opts.today === true,
    since: opts.since,
    until: opts.until,
    utc: opts.utc === true,
    nowMs: deps.now(),
  });
  return {
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
    ...(opts.project === undefined ? {} : { projects: [opts.project] }),
    ...(opts.feature === undefined ? {} : { feature: opts.feature }),
    ...(opts.run === undefined ? {} : { runId: opts.run }),
    groupBy,
  };
}

/**
 * The ledger files to read: every project under the global config dir, or — with
 * `--here` — the single project at `--dir`.
 */
async function ledgerFiles(opts: CostCommandOptions, deps: CostCliDeps): Promise<string[]> {
  const roots =
    opts.here === true
      ? [await deps.resolveProjectOutputDir(opts.dir)]
      : await deps.listProjectOutputDirs(deps.globalConfigDir());
  return await deps.listCostLedgerFiles(roots);
}

/** The counter cells of one row; dollars to two decimals, everything else as an integer. */
function numericCells(total: CostTotals): string[] {
  return [
    String(total.calls),
    String(total.runs),
    String(total.input),
    String(total.output),
    String(total.cacheRead),
    String(total.cacheWrite),
    total.costUsd.toFixed(2),
  ];
}

/** The `TOTAL` row: the label under the first group column, blanks under the rest. */
function totalCells(groupColumns: number, total: CostTotals): string[] {
  const blanks = Array.from({ length: Math.max(groupColumns - 1, 0) }, () => "");
  return ["TOTAL", ...blanks, ...numericCells(total)];
}

function tableRows(report: CostLedgerReport, groupBy: readonly CostGroupKey[]): Cells[] {
  const rows: Cells[] = report.groups.map((row) => [...groupBy.map((key) => row.key[key] ?? ""), ...numericCells(row)]);
  rows.push(totalCells(groupBy.length, report.total));
  return rows;
}

/** Fixed-width table: group columns left-aligned, counters right-aligned. */
function formatTable(header: Cells, rows: readonly Cells[], groupColumns: number): string[] {
  const width = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index].length)));
  const line = (cells: Cells): string =>
    cells
      .map((cell, index) => (index < groupColumns ? cell.padEnd(width[index]) : cell.padStart(width[index])))
      .join(COLUMN_GAP)
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

function tableLines(report: CostLedgerReport, groupBy: readonly CostGroupKey[]): string[] {
  return formatTable([...groupBy, ...NUMERIC_COLUMNS], tableRows(report, groupBy), groupBy.length);
}

/**
 * The report on stdout: the JSON document alone under `--json`, otherwise the
 * table, the exact/estimated split, and the skipped-row note only when there is
 * one — a report with no unparseable line says nothing about them.
 */
function renderReport(
  report: CostLedgerReport,
  groupBy: readonly CostGroupKey[],
  opts: CostCommandOptions,
  deps: CostCliDeps,
): void {
  if (opts.json === true) {
    deps.log(JSON.stringify(report));
    return;
  }
  for (const line of tableLines(report, groupBy)) deps.log(line);
  deps.log(`exact $${report.total.exactUsd.toFixed(2)} / estimated $${report.total.estimatedUsd.toFixed(2)}`);
  if (report.skippedRows > 0) deps.log(`skipped ${report.skippedRows} unparseable row(s)`);
}

/**
 * Run the query and print the report, returning the exit code.
 *
 * Every step is inside one try/catch: a usage error, an unresolvable project or a
 * ledger that cannot be read all mean nax could not answer, so the message goes
 * to stderr as `Error: <message>` (even under `--json` — stdout owns the
 * document) and the code is 1. An empty report is a legitimate answer: 0.
 */
export async function costCommand(opts: CostCommandOptions, deps: CostCliDeps = _costCliDeps): Promise<number> {
  try {
    const groupBy = parseGroupBy(opts.by);
    const query = buildQuery(opts, deps, groupBy);
    const files = await ledgerFiles(opts, deps);
    renderReport(await deps.queryCostLedger(files, query), groupBy, opts, deps);
    return 0;
  } catch (err) {
    deps.logErr(`Error: ${errorMessage(err)}`);
    return 1;
  }
}

/**
 * Register `nax cost`.
 *
 * Deliberately does not call `initLogger` and takes no trust gate: the command
 * reads ledger files and nothing else, so stdout carries the report and the
 * `--json` single-document promise holds.
 */
export function registerCostCommand(program: Command, deps: CostCliDeps = _costCliDeps): Command {
  return program
    .command("cost")
    .description("Report the per-call cost ledger across projects")
    .option("--today", "Only today (local midnight; UTC midnight with --utc)", false)
    .option("--since <date>", "First day of the window, YYYY-MM-DD (inclusive)")
    .option("--until <date>", "Last day of the window, YYYY-MM-DD (inclusive)")
    .option("--utc", "Read --today/--since/--until in UTC instead of local time", false)
    .option("--by <keys>", `Comma list of group keys: ${COST_GROUP_KEYS.join(", ")}`)
    .option("--project <name>", "Only rows whose project key matches")
    .option("--here", "Scan only the project at --dir instead of every project", false)
    .option("--feature <name>", "Only rows whose feature name matches")
    .option("--run <runId>", "Only rows whose run id matches")
    .option("--json", "Emit one machine-readable CostLedgerReport document", false)
    .option("-d, --dir <path>", "Project directory used by --here", process.cwd())
    .action(
      async (o: {
        today: boolean;
        since?: string;
        until?: string;
        utc: boolean;
        by?: string;
        project?: string;
        here: boolean;
        feature?: string;
        run?: string;
        json: boolean;
        dir: string;
      }) => {
        deps.exit(await costCommand(o, deps));
      },
    );
}

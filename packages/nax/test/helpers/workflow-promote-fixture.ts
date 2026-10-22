/**
 * The draft-run fixture `nax workflow promote`'s tests share (SPEC-workflow-record-promote, US-004).
 *
 * US-004 and US-005 both enter at `promote` parsed by the `commander` program
 * `registerWorkflowCommand` built, with `WorkflowForgeDeps` stubbed: the forge answers a draft PR,
 * `waitForChecks` answers `green` and `git rev-parse HEAD` answers one sha, so a test states only
 * the one thing it varies. The CI wait is stubbed rather than the clock (the story's rule) — the
 * command never waits, it polls once.
 *
 * The run tree is written with its path spelled out (`.nax/features/<feature>/workflow/<runId>/`)
 * rather than derived with `workflowFeatureDir`, so a wrong base directory in the command cannot make
 * its own test agree. The checklist line of the PR body is built by `openItemLine`, the writer
 * `publish` itself uses, so the fixture's body is the body a real draft PR carries.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { _workflowForgeDeps, registerWorkflowCommand, type WorkflowCliDeps, type WorkflowForgeDeps } from "@/cli";
import type { ForgeDeps, ForgeKind, ForgeRunResult } from "@/forge";
import type { FeatureOutcome, OpenItem, WorkflowFeatureRecord, WorkflowFinding } from "@/workflow";
import type { CiWaitResult } from "@/workflow/ci-wait";
import {
  type DecisionEntry,
  type DecisionsSidecar,
  type Disposition,
  isoStamp,
  newestSidecar,
  type SidecarOutcome,
  sidecarFileName,
  writeSidecar,
} from "@/workflow/decisions-sidecar";
import { newFeatureRecord } from "@/workflow/feature-record";
import { openItemLine } from "@/workflow/pr-body";

export const PROMOTE_FEATURE = "auth";
export const PROMOTE_RUN_ID = "r1";
export const PROMOTE_URL = "https://github.com/o/r/pull/7";
export const PROMOTE_REMOTE = "git@github.com:o/r.git\n";
export const PROMOTE_NOW = new Date("2026-10-13T09:12:00.417Z");
export const PROMOTE_SIDECAR_NAME = sidecarFileName(PROMOTE_NOW);
/** The sha the sidecar's default `fixed` ruling carries. */
export const PROMOTE_SHA = "a1b2c3d";
/** HEAD as `git rev-parse HEAD` prints it, newline included, so the trim is observable. */
export const PROMOTE_HEAD = "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4";
export const PROMOTE_HEAD_STDOUT = `${PROMOTE_HEAD}\n`;
export const PROMOTE_GREEN: CiWaitResult = { outcome: "green", detail: "all checks passed" };

/** Every forge command line that would write to the PR — US-005's actions, and never US-004's. */
export const PR_WRITE_ARGV: readonly (readonly string[])[] = [
  ["gh", "pr", "edit"],
  ["gh", "pr", "comment"],
  ["gh", "pr", "ready"],
  ["glab", "mr", "update"],
  ["glab", "mr", "note", "create"],
];

/** The subset of `calls` that would write to the PR; empty is the dry run's contract. */
export function prWrites(calls: readonly (readonly string[])[]): (readonly string[])[] {
  return calls.filter((call) => PR_WRITE_ARGV.some((prefix) => prefix.every((word, i) => call[i] === word)));
}

/** One `waitForChecks` call, as the command made it. */
export interface PromoteCheckCall {
  readonly forge: ForgeKind;
  readonly prRef: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly expectedSha?: string;
}

export interface PromoteFixtureOptions {
  /** The run's open item ids, in order. Default `["B1"]`. */
  readonly openItems?: readonly string[];
  /** The ids the sidecar rules. `null` writes no sidecar. Default: every open item. */
  readonly rulings?: readonly string[] | null;
  /** The disposition every ruling carries. Default `"fixed"`. */
  readonly disposition?: Disposition;
  /** The sidecar's own outcome. Default `"pending"`. */
  readonly sidecarOutcome?: SidecarOutcome;
  /** The record's outcome; `null` leaves the field off. Default `"draft"`. */
  readonly outcome?: FeatureOutcome | null;
  /** The record's PR url; `null` leaves the field off. Default `PROMOTE_URL`. */
  readonly url?: string | null;
  /** What the run's `result.json` holds. Default `"full"`. */
  readonly result?: "full" | "missing" | "no-feature-workflow";
  /** The PR body. Default: one checklist line per open item. */
  readonly body?: string;
  /** What `pr view` answers, in order; the last entry repeats. Default: a draft PR holding `body`. */
  readonly prViews?: readonly Partial<ForgeRunResult>[];
  /** `git rev-parse HEAD`. Default: exit 0 with `PROMOTE_HEAD_STDOUT`. */
  readonly head?: Partial<ForgeRunResult>;
  /** The remote read `detectForge` makes. Default: exit 0 with `PROMOTE_REMOTE`. */
  readonly remote?: Partial<ForgeRunResult>;
  /** What `waitForChecks` returns. Default `PROMOTE_GREEN`. */
  readonly ci?: CiWaitResult;
  /** A per-command override, consulted before every built-in answer. */
  readonly onRun?: (argv: readonly string[]) => Partial<ForgeRunResult> | undefined;
}

export interface PromoteFixture {
  /** The project directory the command runs against. */
  readonly dir: string;
  /** The run directory the fixture wrote. */
  readonly runDir: string;
  /** The sidecar the fixture wrote, or undefined when it wrote none. */
  readonly sidecarPath: string | undefined;
  readonly deps: WorkflowCliDeps;
  readonly out: string[];
  readonly err: string[];
  readonly codes: number[];
  readonly forgeDeps: WorkflowForgeDeps;
  /** Every argv the forge stub received, in order. */
  readonly forgeCalls: readonly (readonly string[])[];
  /** Every `waitForChecks` call, in order. */
  readonly checkCalls: readonly PromoteCheckCall[];
  /** Runs `nax workflow promote -f auth -d <dir>` plus `argv`, through the registered group. */
  run(argv?: readonly string[]): Promise<void>;
  /** The run's newest sidecar on disk, or null. */
  sidecar(): Promise<DecisionsSidecar | null>;
  /** Clears everything recorded, so a second call is read on its own. */
  reset(): void;
}

/** What the fixture records while a command runs. */
interface Recorded {
  readonly out: string[];
  readonly err: string[];
  readonly codes: number[];
  readonly forgeCalls: string[][];
  readonly checkCalls: PromoteCheckCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single JSON object the command printed. */
export function emittedJson(out: readonly string[]): Record<string, unknown> {
  if (out.length !== 1) throw new Error(`expected exactly one stdout line, got ${out.length}: ${out.join(" | ")}`);
  const parsed: unknown = JSON.parse(out[0] ?? "null");
  if (!isRecord(parsed)) throw new Error("the command did not print one JSON object");
  return parsed;
}

/** The `error` field of the object `--json` prints on a refusal. */
export function emittedError(out: readonly string[]): string {
  const error = emittedJson(out).error;
  if (typeof error !== "string") throw new Error(`the command printed no error: ${out.join(" | ")}`);
  return error;
}

/** One named check of the report, or a thrown error naming what the report held instead. */
export function checkOf(report: Record<string, unknown>, name: string): { passed: boolean; detail: string } {
  const checks = report.checks;
  const found = Array.isArray(checks) ? checks.find((c) => isRecord(c) && c.name === name) : undefined;
  if (!isRecord(found)) throw new Error(`no ${name} check in ${JSON.stringify(checks)}`);
  return { passed: found.passed === true, detail: typeof found.detail === "string" ? found.detail : "" };
}

/** The run's open finding `buildOpenItems` derives — the same id, as a `WorkflowFinding`. */
function finding(id: string): WorkflowFinding {
  return { id, kind: "spec", severity: "important", issue: `${id} is broken`, file: "src/a.ts", line: 3 };
}

/** The open item that finding becomes, for the body line `openItemLine` writes. */
function openItem(id: string): OpenItem {
  return { id, kind: "finding", severity: "important", issue: `${id} is broken`, file: "src/a.ts", line: 3 };
}

function ruling(id: string, disposition: Disposition): DecisionEntry {
  return {
    id,
    kind: "finding",
    disposition,
    reason: `${id} ruled`,
    ...(disposition === "fixed" ? { sha: PROMOTE_SHA } : {}),
  };
}

/** The run's record: a draft holding the PR url, with one open finding per id and no reasons. */
function featureRecord(opts: PromoteFixtureOptions, ids: readonly string[]): WorkflowFeatureRecord {
  const url = opts.url === undefined ? PROMOTE_URL : opts.url;
  const outcome = opts.outcome === undefined ? "draft" : opts.outcome;
  return {
    ...newFeatureRecord({ now: isoStamp(PROMOTE_NOW), seed: null, minors: [] }),
    step: "done",
    reviewOpen: ids.map(finding),
    reasons: [],
    ...(outcome === null ? {} : { outcome }),
    ...(url === null ? {} : { url }),
  };
}

/** The `result.json` the run holds — or none, or one with no feature record (AC-18, AC-19). */
function resultBody(opts: PromoteFixtureOptions, ids: readonly string[]): string | null {
  if (opts.result === "missing") return null;
  return JSON.stringify({
    schemaVersion: 1,
    runId: PROMOTE_RUN_ID,
    feature: PROMOTE_FEATURE,
    stories: {},
    ...(opts.result === "no-feature-workflow" ? {} : { featureWorkflow: featureRecord(opts, ids) }),
  });
}

function sidecarFor(opts: PromoteFixtureOptions, rulings: readonly DecisionEntry[]): DecisionsSidecar {
  return {
    artifact: `${PROMOTE_RUN_ID}/result.json`,
    feature: PROMOTE_FEATURE,
    resumedAt: isoStamp(PROMOTE_NOW),
    reasons: [],
    decisions: rulings,
    outcome: opts.sidecarOutcome ?? "pending",
    url: PROMOTE_URL,
  };
}

/** The sidecar the fixture writes, or undefined for the run that has none (`rulings: null`). */
async function writeRulings(
  runDir: string,
  opts: PromoteFixtureOptions,
  ids: readonly string[],
): Promise<string | undefined> {
  const ruled = opts.rulings === undefined ? ids : opts.rulings;
  if (ruled === null) return undefined;
  const path = join(runDir, PROMOTE_SIDECAR_NAME);
  await writeSidecar(
    path,
    sidecarFor(
      opts,
      ruled.map((id) => ruling(id, opts.disposition ?? "fixed")),
    ),
  );
  return path;
}

const draftPrView = (body: string): string => JSON.stringify({ isDraft: true, body, url: PROMOTE_URL });

/** New read-only API answers; existing detection/view/write answers remain untouched. */
function emptyPrReads(cmd: readonly string[]): Partial<ForgeRunResult> {
  if (cmd[1] !== "api") return {};
  if (cmd.at(-1) === "user") return { stdout: '{"login":"nax"}' };
  if (cmd.includes("graphql"))
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    };
  if (/\/(comments|reviews)\?/.test(cmd.at(-1) ?? "")) return { stdout: "[]" };
  return {};
}

/** The forge stub: detection, HEAD and `pr view` answer from `opts`, everything else is inert. */
function forgeDepsFor(recorded: Recorded, body: string, opts: PromoteFixtureOptions): WorkflowForgeDeps {
  const views =
    opts.prViews === undefined || opts.prViews.length === 0 ? [{ stdout: draftPrView(body) }] : opts.prViews;
  let taken = 0;
  const answer = (partial: Partial<ForgeRunResult>): ForgeRunResult => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...partial,
  });
  const forge: ForgeDeps = {
    run: async (cmd) => {
      recorded.forgeCalls.push([...cmd]);
      const override = opts.onRun?.(cmd);
      if (override !== undefined) return answer(override);
      if (cmd[0] === "git" && cmd[1] === "rev-parse") return answer(opts.head ?? { stdout: PROMOTE_HEAD_STDOUT });
      if (cmd[0] === "git" && cmd[1] === "remote") return answer(opts.remote ?? { stdout: PROMOTE_REMOTE });
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
        const view = views[Math.min(taken, views.length - 1)] ?? {};
        taken += 1;
        return answer(view);
      }
      return answer(emptyPrReads(cmd));
    },
    readText: async () => null,
  };
  const waitForChecks: WorkflowForgeDeps["waitForChecks"] = async (forgeKind, prRef, options) => {
    recorded.checkCalls.push({
      forge: forgeKind,
      prRef,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      ...(options.expectedSha === undefined ? {} : { expectedSha: options.expectedSha }),
    });
    return opts.ci ?? PROMOTE_GREEN;
  };
  return {
    ..._workflowForgeDeps,
    forge,
    now: () => PROMOTE_NOW,
    waitForChecks,
  };
}

function harness(
  dir: string,
  runDir: string,
  body: string,
  sidecarPath: string | undefined,
  opts: PromoteFixtureOptions,
): PromoteFixture {
  const recorded: Recorded = { out: [], err: [], codes: [], forgeCalls: [], checkCalls: [] };
  const deps: WorkflowCliDeps = {
    log: (text) => recorded.out.push(text),
    logErr: (text) => recorded.err.push(text),
    exit: (code) => recorded.codes.push(code),
  };
  const forgeDeps = forgeDepsFor(recorded, body, opts);
  return {
    dir,
    runDir,
    sidecarPath,
    deps,
    forgeDeps,
    out: recorded.out,
    err: recorded.err,
    codes: recorded.codes,
    forgeCalls: recorded.forgeCalls,
    checkCalls: recorded.checkCalls,
    async run(argv = []) {
      const program = new Command();
      registerWorkflowCommand(program, deps, forgeDeps);
      await program.parseAsync(["node", "nax", "workflow", "promote", "-f", PROMOTE_FEATURE, "-d", dir, ...argv]);
    },
    async sidecar() {
      return (await newestSidecar(runDir))?.sidecar ?? null;
    },
    reset() {
      recorded.out.length = 0;
      recorded.err.length = 0;
      recorded.codes.length = 0;
      recorded.forgeCalls.length = 0;
      recorded.checkCalls.length = 0;
    },
  };
}

/**
 * Writes the draft run of `dir` — its `result.json`, its ruling sidecar and the PR body its open
 * items produce — and returns the harness the command runs through.
 */
export async function makePromoteFixture(dir: string, opts: PromoteFixtureOptions = {}): Promise<PromoteFixture> {
  const ids = opts.openItems ?? ["B1"];
  const body = opts.body ?? ids.map((id) => openItemLine(openItem(id))).join("\n");
  const runDir = join(dir, ".nax", "features", PROMOTE_FEATURE, "workflow", PROMOTE_RUN_ID);
  await mkdir(runDir, { recursive: true });
  const result = resultBody(opts, ids);
  if (result !== null) await Bun.write(join(runDir, "result.json"), result);
  const sidecarPath = await writeRulings(runDir, opts, ids);
  return harness(dir, runDir, body, sidecarPath, opts);
}

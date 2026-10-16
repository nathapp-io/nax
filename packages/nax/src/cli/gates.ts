/**
 * `nax gates run` — run the project's configured quality gates (spec US-002).
 *
 * The nax-finish skill's Step 6 used to run the gates by hand: read
 * `quality.commands` out of the config and spawn each one. One session reported
 * the gates as having run when a zsh loop returned exit 127 for every one of
 * them — 127 means the shell could not run the command at all. nax already does
 * this correctly in `runQualityGates`; this module is the missing CLI entry to
 * it, so a finishing tool calls one command instead of reimplementing the rules
 * (one gate per invocation, the command string exactly as configured, 127/126
 * is "did not run", never `formatFix`/`lintFix`).
 *
 * Mode-independent: it reads config and runs commands, and touches no workflow
 * or PRD state.
 *
 * `runQualityGates` and `resolveGateCommands` are reached by relative path
 * rather than through the `@/finish` barrel: that barrel loads `context.ts`,
 * which value-imports `@/cli`, and `@/cli` re-exports this module — routing
 * through it would close a runtime import cycle
 * (`bun run check:import-cycles`). The report types come from the same leaf so
 * the wire format and the runner stay one module's contract.
 * `src/workflow/repo-gates.ts` (the workflow's own gate excerpt) is
 * deliberately not imported: it reaches the same barrel.
 */
import { dirname, join } from "node:path";
import { errorMessage, realOrRaw } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { findProjectDir, globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import { NaxError } from "@/errors";
import { ensureProjectTrusted, normalizeTrustPath } from "@/trust";
import {
  DEFAULT_GATE_TAIL_LINES,
  GATE_ORDER,
  type GateCommand,
  type GateRunRecord,
  type GateRunStatus,
  gateOutputTail,
  resolveGateCommands,
  runQualityGates,
} from "../finish/gates/quality";

export interface GatesCliDeps {
  log: (msg: string) => void;
  logErr: (msg: string) => void;
  exit: (code: number) => void;
  isInteractive: () => boolean;
  ensureProjectTrusted: typeof ensureProjectTrusted;
  resolveGateCommands: typeof resolveGateCommands;
  runQualityGates: typeof runQualityGates;
}

/** The real process: the report on stdout, a plain error on stderr. */
export const _gatesCliDeps: GatesCliDeps = {
  log: (msg) => {
    console.log(msg);
  },
  logErr: (msg) => {
    console.error(msg);
  },
  exit: (code) => {
    process.exit(code);
  },
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  ensureProjectTrusted,
  resolveGateCommands,
  runQualityGates,
};

export interface GatesRunOptions {
  readonly dir: string;
  /** Gate keys to run; empty means every configured root gate. */
  readonly gates: readonly string[];
  readonly json: boolean;
}

export interface GatesRunReport {
  /** Absolute project root the gates ran from. */
  readonly projectDir: string;
  /** True only when at least one gate ran and every gate is "passed". */
  readonly passed: boolean;
  readonly gates: readonly GateReportEntry[];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly notRun: number;
    readonly timedOut: number;
  };
}

export interface GateReportEntry {
  readonly name: string;
  readonly status: GateRunStatus;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly failedPhase?: "setup";
  /** `gateOutputTail(record.output)`; absent for a "passed" gate. */
  readonly outputTail?: string;
}

/** Printed after the exit code of a gate the shell could not run at all. */
const NOT_RUN_NOTE = "(command not found or not executable; the gate did not run)";
const STATUS_COLUMN = 10;
const NAME_COLUMN = 10;
const EXIT_COLUMN = 10;

/**
 * The project root `dir` belongs to, or a refusal.
 *
 * `findProjectDir` can return the global config directory itself
 * (`~/.nax/config.json` IS a `.nax/config.json`), and treating that as a project
 * would run the gates of whatever folder happens to sit under the home
 * directory — the same exclusion `resolveTrustRoot` makes. `resolveTrustRoot`
 * itself is not used because it falls back to `resolve(workdir)` instead of
 * signalling "no project", and this command must refuse rather than guess.
 */
async function projectRootOf(dir: string): Promise<string> {
  const naxDir = findProjectDir(dir);
  if (naxDir === null || realOrRaw(naxDir) === realOrRaw(globalConfigDir())) {
    throw new NaxError(`no nax project found at or above ${dir}`, "GATES_NO_PROJECT", { stage: "gates-run", dir });
  }
  return await normalizeTrustPath(dirname(naxDir));
}

/**
 * Ask the entry gate for a decision, and reword its refusal for a command whose
 * exit 1 means "nax could not run the gates at all" (not `runTrustGate`, which
 * exits 2 — here 2 means the gates ran and something is not green).
 */
async function ensureTrusted(projectDir: string, deps: GatesCliDeps, interactive: boolean): Promise<void> {
  try {
    await deps.ensureProjectTrusted(projectDir, { interactive });
  } catch (err) {
    if (err instanceof NaxError && err.code === "PROJECT_UNTRUSTED") {
      const hint = err.context?.hint;
      const line = typeof hint === "string" ? hint : `run: nax trust add ${projectDir}`;
      throw new NaxError(`Project not trusted: ${projectDir}\n${line}`, "PROJECT_UNTRUSTED", {
        stage: "gates-run",
        root: projectDir,
      });
    }
    throw err;
  }
}

/**
 * Every `--gate` value must be a gate key. Pure and first: a typo must fail
 * before a config is read or a command spawned.
 */
function assertKnownGates(gates: readonly string[]): void {
  for (const name of gates) {
    if (!(GATE_ORDER as readonly string[]).includes(name)) {
      throw new NaxError(`unknown gate ${name}; expected one of ${GATE_ORDER.join(", ")}`, "GATES_UNKNOWN_GATE", {
        stage: "gates-run",
        gate: name,
      });
    }
  }
}

/**
 * Every requested gate must be one the project configures. Reported in
 * `GATE_ORDER` rather than flag order, so the same command always names the
 * same gate whichever order the flags came in.
 */
function assertGatesConfigured(gates: readonly string[], commands: readonly GateCommand[]): void {
  const configured = commands.map((command) => command.name);
  const missing = GATE_ORDER.filter((gate) => gates.includes(gate) && !configured.includes(gate));
  if (missing.length === 0) return;
  throw new NaxError(
    `gate ${missing[0]} is not configured; configured gates: ${configured.length === 0 ? "none" : configured.join(", ")}`,
    "GATES_NOT_CONFIGURED",
    { stage: "gates-run", gate: missing[0] },
  );
}

/**
 * The gates to run, in resolution order — the same order as `GATE_ORDER` for
 * root gates. An empty request means every configured gate; a repeated value
 * selects its gate once.
 */
function selectGates(gates: readonly string[], commands: readonly GateCommand[]): GateCommand[] {
  if (gates.length === 0) return [...commands];
  const wanted = new Set(gates);
  return commands.filter((command) => wanted.has(command.name));
}

/** One report entry per record; a gate that passed has no tail to show. */
function entryFor(record: GateRunRecord): GateReportEntry {
  return {
    name: record.name,
    status: record.status,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    ...(record.failedPhase === undefined ? {} : { failedPhase: record.failedPhase }),
    ...(record.status === "passed" ? {} : { outputTail: gateOutputTail(record.output) }),
  };
}

/** `passed` only when something ran and nothing is red. */
function reportFor(projectDir: string, records: readonly GateRunRecord[]): GatesRunReport {
  const entries = records.map(entryFor);
  const count = (status: GateRunStatus): number => entries.filter((entry) => entry.status === status).length;
  return {
    projectDir,
    passed: entries.length > 0 && entries.every((entry) => entry.status === "passed"),
    gates: entries,
    summary: {
      passed: count("passed"),
      failed: count("failed"),
      notRun: count("not-run"),
      timedOut: count("timed-out"),
    },
  };
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * `<status> <name> <exit=n> <duration> <note> <setup failed>`, aligned in
 * columns. `exit=` is meaningless for a timeout (the killed process reports -1)
 * and redundant for a pass, so both omit it.
 */
function gateLine(entry: GateReportEntry): string {
  const showsExit = entry.status !== "passed" && entry.status !== "timed-out";
  const line = [
    entry.status.padEnd(STATUS_COLUMN),
    entry.name.padEnd(NAME_COLUMN),
    (showsExit ? `exit=${entry.exitCode}` : "").padEnd(EXIT_COLUMN),
    formatDuration(entry.durationMs),
    entry.status === "not-run" ? `  ${NOT_RUN_NOTE}` : "",
    entry.failedPhase === "setup" ? "  (setup failed)" : "",
  ].join(" ");
  return line.trimEnd();
}

function printPlain(report: GatesRunReport, deps: GatesCliDeps): void {
  for (const entry of report.gates) deps.log(gateLine(entry));
  for (const entry of report.gates.filter((gate) => gate.status !== "passed")) {
    deps.log("");
    deps.log(`--- ${entry.name} (last ${DEFAULT_GATE_TAIL_LINES} lines) ---`);
    const tail = entry.outputTail ?? "";
    for (const line of tail === "" ? [] : tail.split("\n")) deps.log(line);
  }
  const { passed, failed, notRun, timedOut } = report.summary;
  deps.log(`gates: ${passed} passed, ${failed} failed, ${notRun} not run, ${timedOut} timed out`);
}

/**
 * Run the gates, print the report, and return the exit code.
 *
 * Every step is inside one try/catch (like `workflowStatusCommand`): anything
 * thrown — a refusal from the trust gate, an invalid config, or
 * `runQualityGates` itself failing mid-run — means nax could not answer, so the
 * exit is 1 and the records already collected are discarded rather than
 * reported as a verdict. Without `--json` the message's lines go to stderr, one
 * `logErr` call each, with no prefix; with `--json` stdout gets the single
 * `{"error": …}` document and stderr stays empty.
 */
export async function gatesRunCommand(opts: GatesRunOptions, deps: GatesCliDeps = _gatesCliDeps): Promise<number> {
  try {
    assertKnownGates(opts.gates);

    const projectDir = await projectRootOf(opts.dir);
    await ensureTrusted(projectDir, deps, opts.json ? false : deps.isInteractive());

    const commands = await deps.resolveGateCommands(projectDir, []);
    if (commands.length === 0) {
      const empty: GatesRunReport = {
        projectDir,
        passed: false,
        gates: [],
        summary: { passed: 0, failed: 0, notRun: 0, timedOut: 0 },
      };
      if (opts.json) deps.log(JSON.stringify(empty));
      else
        deps.log(
          `no quality.commands configured in ${join(projectDir, PROJECT_NAX_DIR, "config.json")}; nothing was verified`,
        );
      return 2;
    }
    assertGatesConfigured(opts.gates, commands);

    const records: GateRunRecord[] = [];
    await deps.runQualityGates(projectDir, selectGates(opts.gates, commands), {
      onGate: (record) => records.push(record),
    });

    const report = reportFor(projectDir, records);
    if (opts.json) deps.log(JSON.stringify(report));
    else printPlain(report, deps);
    return report.passed ? 0 : 2;
  } catch (err) {
    const message = errorMessage(err);
    if (opts.json) deps.log(JSON.stringify({ error: message.replace(/\n/g, "; ") }));
    else for (const line of message.split("\n")) deps.logErr(line);
    return 1;
  }
}

/** Commander collector for repeatable `--gate` flags. */
function collectGate(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

async function guarded(deps: GatesCliDeps, body: () => Promise<number>): Promise<void> {
  try {
    deps.exit(await body());
  } catch (err) {
    deps.logErr(`error: ${errorMessage(err)}`);
    deps.exit(1);
  }
}

/**
 * Register `nax gates` with its `run` subcommand.
 *
 * Deliberately does not call `initLogger`: `runQualityCommand` logs through the
 * process logger, which writes to stdout, and `--json` promises stdout carries
 * exactly one document.
 */
export function registerGatesCommand(program: Command, deps: GatesCliDeps = _gatesCliDeps): Command {
  const group = program.command("gates").description("Run the project's quality gates");
  group
    .command("run")
    .description("Run the configured root quality gates (build, typecheck, lint, test, e2e)")
    .option("-d, --dir <path>", "Any directory inside the project", process.cwd())
    .option("--gate <name>", "Gate to run; repeatable", collectGate, [])
    .option("--json", "Emit one machine-readable JSON document", false)
    .action((o: { dir: string; gate: string[]; json?: boolean }) =>
      guarded(deps, () => gatesRunCommand({ dir: o.dir, gates: o.gate, json: o.json === true }, deps)),
    );
  return group;
}

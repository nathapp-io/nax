/**
 * The quality gate: build/typecheck/lint/test, run through nax's own layered
 * config (fixes F2). Ported from `runQualityGates` / `loadQualityCommands` in
 * `flows/nax-finish/steps/quality.ts` (read-only reference — `flows/` is a
 * separate module system and is never imported from `src/`).
 *
 * The flow original read `quality.commands` from a single-file parse of
 * `<workdir>/.nax/config.json`. A repo whose commands live only in the global
 * layer, a profile overlay, or a package's own `.nax/mono/<pkg>/config.json`
 * found nothing at the root and reported "verified nothing" as green — the
 * false "everything's fine" signal this gate exists to prevent. This port
 * resolves root commands through `loadConfig`, which applies the global
 * layer, the project file, and the active profile chain, and adds a
 * package's commands only when that package's own overlay file actually sets
 * `quality.commands` — a package that merely inherits the root commands is
 * already covered by the root run, and fanning it out would re-run the whole
 * suite once per such package. Root commands win per gate key: even an
 * explicit package command is skipped when the root configures that key;
 * overlays still supply gates the root leaves unconfigured.
 */
import { join } from "node:path";
import type { QualityCommandSpec } from "@nathapp/nax-agent/internal";
import { loadConfig, loadPackageOverride, type NaxConfig, PROJECT_NAX_DIR } from "@/config";
import { type QualityCommandResult, runQualityCommand } from "@/quality";
import type { QualityGateResult } from "../types";

export const _qualityGateDeps = {
  run: runQualityCommand,
  loadConfig,
  loadPackageOverride,
};

/**
 * build -> typecheck -> lint -> test -> e2e. No `format`: nax's
 * `quality.commands` has no such key — only `formatFix` / `formatFixScoped`,
 * which mutate files and must never be run as a gate. Porting the flow's
 * `format` entry would have been porting a typo.
 *
 * `e2e` is last and runs on the host (#2530): a browser journey cannot launch
 * inside the agent's srt sandbox, so the gate that judges it must live outside
 * one. It is gated by its own `e2eSetup` bootstrap, run immediately before it.
 */
export const GATE_ORDER = ["build", "typecheck", "lint", "test", "e2e"] as const;

/** Default timeout for one gate command, mirroring the flow original. */
export const DEFAULT_GATE_TIMEOUT_MS = 900_000;

/** Default line count for `gateOutputTail`. */
export const DEFAULT_GATE_TAIL_LINES = 40;

/** How one gate ended. */
export type GateRunStatus = "passed" | "failed" | "not-run" | "timed-out";

/**
 * What one gate actually did, in a form a caller can report without parsing
 * the combined `output` text of `QualityGateResult` — where a 127 ("the shell
 * could not run the command at all") and a real failure both sit in `failing`.
 */
export interface GateRunRecord {
  /** The GateCommand name: "build", "test", ... */
  readonly name: string;
  /** Absolute directory the command was spawned from. */
  readonly cwd: string;
  readonly status: GateRunStatus;
  /**
   * The exit code that decided the status: -1 for a single command's timeout or
   * spawn error; for a list-valued command, the first non-zero step's code.
   */
  readonly exitCode: number;
  readonly durationMs: number;
  /** Present, as "setup", only when the gate's setup bootstrap failed and the command never ran. */
  readonly failedPhase?: "setup";
  /** The raw output of whichever run decided the status (setup or command). */
  readonly output: string;
}

/**
 * The status for one `QualityCommandResult`, in decision order: a timeout wins
 * over any exit code (a killed process reports -1, which would otherwise read
 * as "never ran"); then success; then the exit codes that mean the shell could
 * not find or execute the command at all — 127/126 from the shell, -1 from a
 * spawn error — which is "not-run", the third state a caller could previously
 * only recover by parsing the combined output text (#2569); everything else
 * failed.
 */
export function classifyGateExit(res: { readonly exitCode: number; readonly timedOut: boolean }): GateRunStatus {
  if (res.timedOut) return "timed-out";
  if (res.exitCode === 0) return "passed";
  if (res.exitCode === 127 || res.exitCode === 126 || res.exitCode === -1) return "not-run";
  return "failed";
}

/**
 * The last `lines` lines of `output`, with trailing newlines removed first and
 * joined with "\n" — "" when nothing is left. The caller decides how many lines
 * a report can afford (`src/cli/gates.ts`); `40` matches the workflow's own
 * red-gate excerpt.
 */
export function gateOutputTail(output: string, lines: number = DEFAULT_GATE_TAIL_LINES): string {
  const all = output.replace(/\n+$/, "").split("\n");
  return all.slice(Math.max(0, all.length - Math.max(0, lines))).join("\n");
}

/** The record for one gate, from whichever run decided its status. */
function gateRecord(gate: GateCommand, res: QualityCommandResult, failedPhase?: "setup"): GateRunRecord {
  return {
    name: gate.name,
    cwd: gate.cwd,
    status: classifyGateExit(res),
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    // Spread, not `failedPhase: undefined`: AC-15 pins the key's absence.
    ...(failedPhase === undefined ? {} : { failedPhase }),
    output: res.output,
  };
}

export interface GateCommand {
  /** `<gate>` at the root, `<gate>@<packageDir>` for a package overlay. */
  name: string;
  command: QualityCommandSpec;
  /** Absolute directory the command is spawned from. */
  cwd: string;
  /**
   * A one-time bootstrap run immediately before `command`, from the same cwd
   * and under the same timeout. Only `e2e` carries one today (that layer's
   * `e2eSetup`). A non-zero setup exit fails the gate without running
   * `command` — a journey run against a half-started stack reports noise, not
   * the real failure.
   */
  setup?: QualityCommandSpec;
}

type QualityCommands = NaxConfig["quality"]["commands"];

/** The package's own overlay `quality.commands`, or `undefined` when it sets none. */
function overlayCommandsOf(override: Partial<NaxConfig> | null): QualityCommands | undefined {
  const commands = override?.quality?.commands;
  return commands !== undefined && Object.keys(commands).length > 0 ? commands : undefined;
}

/**
 * Every gate command this repo actually configures, layered (fixes F2).
 *
 * Root commands come from `loadConfig(workdir)`, which applies the global
 * layer, the project file and the active profile chain — the flow read one
 * file and saw none of them. Package commands are added only for packages
 * whose own `.nax/mono/<pkg>/config.json` sets `quality.commands`: a package
 * that merely inherits the root commands is already covered by the root run,
 * and fanning it out would run the repo's whole test suite once per package.
 *
 * `packageDirs` comes from the acceptance groups the feature touched. `""`
 * (the root package) is filtered — the root run already covers it.
 *
 * Ordering: root gates first (`GATE_ORDER`), then each package's gates
 * (`GATE_ORDER`), packages in the order given.
 *
 * A *root* gate is identified by its `quality.commands` key — one gate per
 * configured key. Two keys that happen to hold the same command string
 * (`build` and `typecheck` both `tsc --noEmit`) are two gates, because callers
 * select and report root gates by key: deduplicating them by command string
 * made `nax gates run --gate typecheck` answer "gate typecheck is not
 * configured" for a gate the config sets, and silently dropped it from a full
 * run (whole-branch review B1).
 *
 * An *overlay* gate is considered only when the root leaves its key
 * unconfigured, regardless of command, cwd or setup differences. Remaining
 * overlay gates are identified by the run they make — `cwd`, `command` and
 * `setup`, never the gate key. An overlay's own keys sharing a run, or a run
 * another root key already makes, count as one run. Different setup remains
 * a distinct run for these fallback gates (whole-branch review B1 residual).
 */
export async function resolveGateCommands(repoRoot: string, packageDirs: string[]): Promise<GateCommand[]> {
  /**
   * The runs already scheduled, keyed by what actually gets spawned — `cwd`,
   * `command` and `setup` — never by gate key. Root gates add to it; overlay
   * gates are matched against it.
   */
  const seenRuns = new Set<string>();
  const out: GateCommand[] = [];

  /** `command` AND `setup`: the same command bootstrapping a different stack is a different run. */
  const runKey = (cwd: string, command: QualityCommandSpec, setup?: QualityCommandSpec): string =>
    `${cwd}::${JSON.stringify(command)}::${JSON.stringify(setup ?? null)}`;

  const isConfigured = (command: QualityCommandSpec | undefined): command is QualityCommandSpec =>
    command !== undefined && (typeof command === "string" ? [command] : command).some((part) => part.trim());

  /** Schedule one run, and record it as already scheduled. */
  const schedule = (name: string, command: QualityCommandSpec, cwd: string, setup?: QualityCommandSpec): void => {
    seenRuns.add(runKey(cwd, command, setup));
    out.push(setup === undefined ? { name, command, cwd } : { name, command, cwd, setup });
  };

  /**
   * Only `e2e` carries setup. Package gates inherit root setup unless their
   * overlay explicitly names e2eSetup. Setup alone never declares a gate.
   */
  const setupFor = (commands: QualityCommands, gate: string): QualityCommandSpec | undefined =>
    gate === "e2e" ? commands.e2eSetup : undefined;

  const rootConfig = await _qualityGateDeps.loadConfig(repoRoot);
  const rootCommands: QualityCommands = rootConfig.quality?.commands ?? {};
  for (const gate of GATE_ORDER) {
    const command = rootCommands[gate];
    // A root gate goes in per key, whatever any other key's command string
    // says: `seenRuns` only ever absorbs the overlays below.
    if (!isConfigured(command)) continue;
    schedule(gate, command, repoRoot, setupFor(rootCommands, gate));
  }

  for (const packageDir of packageDirs) {
    if (!packageDir) continue;

    const override = await _qualityGateDeps.loadPackageOverride(repoRoot, packageDir);
    const overlayCommands = overlayCommandsOf(override);
    if (!overlayCommands) continue;

    const packageCwd = join(repoRoot, packageDir);
    for (const gate of GATE_ORDER) {
      // Only a gate the overlay itself names — never backfill from the merged
      // config, which would silently re-add the root's inherited commands
      // (loadConfigForWorkdir deep-merges quality.commands) and fan out a
      // second run of every gate the package never actually overrode.
      const command = overlayCommands[gate];
      if (!isConfigured(command)) continue;
      // Root coverage wins per key before considering overlay run identity.
      if (isConfigured(rootCommands[gate])) continue;
      const setupCommands = Object.hasOwn(overlayCommands, "e2eSetup")
        ? overlayCommands
        : { ...overlayCommands, e2eSetup: rootCommands.e2eSetup };
      const setup = setupFor(setupCommands, gate);
      // The package's own gate key is not part of the identity: an overlay
      // asking for a run the repo is already about to make is one run.
      if (seenRuns.has(runKey(packageCwd, command, setup))) continue;
      schedule(`${gate}@${packageDir}`, command, packageCwd, setup);
    }
  }

  return out;
}

/**
 * Run a gate's `setup` when it has one, under the gate's own cwd and timeout.
 * Returns the setup's `QualityCommandResult` when the setup ran and failed —
 * the caller reports the failure and builds the gate's record from it — or
 * `null` when there is no setup or it passed. A setup that never came up fails
 * the gate untouched: the command is never run, because a journey run against a
 * half-started stack reports noise rather than the real failure.
 */
async function runGateSetup(gate: GateCommand, timeoutMs: number): Promise<QualityCommandResult | null> {
  if (gate.setup === undefined) return null;
  const res = await _qualityGateDeps.run({
    commandName: `${gate.name}:setup`,
    command: gate.setup,
    workdir: gate.cwd,
    timeoutMs,
  });
  return res.exitCode === 0 ? null : res;
}

/**
 * Run every resolved gate command in turn, collecting every failure rather
 * than stopping at the first — unlike the acceptance gate, the fix step here
 * needs the complete list of red gates, not just the first one.
 *
 * Nothing configured is not a pass (I1): an empty `commands` list returns
 * `passed: false, ran: []`. An LLM fix step cannot invent the repo's build
 * commands, so "nothing ran" must never read as "everything passed" —
 * `routeQualityGates` (../route) turns this into an escalation.
 *
 * `opts.onGate`, when given, receives one `GateRunRecord` per gate,
 * synchronously, after that gate has finished and before the next one starts.
 * It is an observer: the returned `QualityGateResult` is the same with or
 * without it, and an exception it throws propagates out of here (stopping the
 * remaining gates) rather than being read as a gate failure.
 */
export async function runQualityGates(
  repoRoot: string,
  commands: GateCommand[],
  opts: { timeoutMs?: number; onGate?: (record: GateRunRecord) => void } = {},
): Promise<QualityGateResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const ran: string[] = [];
  const failing: string[] = [];
  const chunks: string[] = [];

  for (const gate of commands) {
    ran.push(gate.name);

    const setupFailure = await runGateSetup(gate, timeoutMs);
    if (setupFailure !== null) {
      chunks.push(`[${gate.name}] exit=${setupFailure.exitCode}\nsetup failed:\n${setupFailure.output}`);
      failing.push(gate.name);
      opts.onGate?.(gateRecord(gate, setupFailure, "setup"));
      continue;
    }

    const res = await _qualityGateDeps.run({
      commandName: gate.name,
      command: gate.command,
      workdir: gate.cwd,
      timeoutMs,
    });
    chunks.push(`[${gate.name}] exit=${res.exitCode}\n${res.output}`);
    if (res.exitCode !== 0) failing.push(gate.name);
    opts.onGate?.(gateRecord(gate, res));
  }

  if (ran.length === 0) {
    return {
      passed: false,
      ran,
      failing: [],
      output: `[quality] no quality.commands configured in ${join(repoRoot, PROJECT_NAX_DIR, "config.json")} — nothing was verified`,
    };
  }

  return { passed: failing.length === 0, ran, failing, output: chunks.join("\n\n") };
}

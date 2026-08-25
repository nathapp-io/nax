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
 * suite once per such package.
 */
import { join } from "node:path";
import { loadConfig, loadPackageOverride, type NaxConfig, PROJECT_NAX_DIR } from "@/config";
import { runQualityCommand } from "@/quality";
import type { QualityGateResult } from "../types";

export const _qualityGateDeps = {
  run: runQualityCommand,
  loadConfig,
  loadPackageOverride,
};

/**
 * build -> typecheck -> lint -> test. No `format`: nax's `quality.commands`
 * has no such key — only `formatFix` / `formatFixScoped`, which mutate files
 * and must never be run as a gate. Porting the flow's `format` entry would
 * have been porting a typo.
 */
const GATE_ORDER = ["build", "typecheck", "lint", "test"] as const;

/** Default timeout for one gate command, mirroring the flow original. */
export const DEFAULT_GATE_TIMEOUT_MS = 900_000;

export interface GateCommand {
  /** `<gate>` at the root, `<gate>@<packageDir>` for a package overlay. */
  name: string;
  command: string;
  /** Absolute directory the command is spawned from. */
  cwd: string;
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
 * (`GATE_ORDER`), packages in the order given. Deduped on `(cwd, command)` —
 * an overlay that repeats the root command verbatim from the same directory
 * counts as one gate.
 */
export async function resolveGateCommands(repoRoot: string, packageDirs: string[]): Promise<GateCommand[]> {
  const seen = new Set<string>();
  const out: GateCommand[] = [];

  const add = (name: string, command: string | undefined, cwd: string): void => {
    if (!command) return;
    const key = `${cwd}::${command}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, command, cwd });
  };

  const rootConfig = await _qualityGateDeps.loadConfig(repoRoot);
  const rootCommands: QualityCommands = rootConfig.quality?.commands ?? {};
  for (const gate of GATE_ORDER) {
    add(gate, rootCommands[gate], repoRoot);
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
      if (overlayCommands[gate] === undefined) continue;
      add(`${gate}@${packageDir}`, overlayCommands[gate], packageCwd);
    }
  }

  return out;
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
 */
export async function runQualityGates(
  repoRoot: string,
  commands: GateCommand[],
  opts: { timeoutMs?: number } = {},
): Promise<QualityGateResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const ran: string[] = [];
  const failing: string[] = [];
  const chunks: string[] = [];

  for (const gate of commands) {
    ran.push(gate.name);
    const res = await _qualityGateDeps.run({
      commandName: gate.name,
      command: gate.command,
      workdir: gate.cwd,
      timeoutMs,
    });
    chunks.push(`[${gate.name}] exit=${res.exitCode}\n${res.output}`);
    if (res.exitCode !== 0) failing.push(gate.name);
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

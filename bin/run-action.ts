/**
 * Phase functions for the `nax run` CLI action in bin/nax.ts.
 *
 * Extracted for the cognitive-complexity drain (docs/plans/STATUS-complexity-drain.md
 * §4 A4): the action body was a single ~478-line function scoring 107. It now
 * sequences the named phases below; every phase preserves the original's exit
 * codes, stderr messages and gate ORDER (pinned by
 * test/integration/cli/cli-run-preflight.test.ts).
 *
 * Boundaries that must not drift:
 * - Nothing here may import from bin/nax.ts (it imports this file — a back
 *   import would cycle). Everything a phase needs arrives as an explicit
 *   parameter.
 * - The BUG-15 / ENH-47 source-signature tests read bin/nax.ts as text, so the
 *   `loadConfig(naxDir ?? undefined, cliOverrides)` try/catch, the TUI's
 *   `loadPRD(prdPath)` try/catch and the latest.jsonl symlink block stay
 *   inline in bin/nax.ts on purpose; only the surrounding phases moved here.
 * - `warnIfPlanDegraded` lives here rather than in bin/nax.ts because both the
 *   plan phase (below) and bin/nax.ts's own `plan` command call it; keeping
 *   the definition in bin/nax.ts would force a back import and a cycle.
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import chalk from "chalk";
import { planCommand, promptForConfirmation, resolveRunProfileOverride, runReplanLoop } from "../src/cli";
import { applyMaxIterationsFlag, type MaxIterationsFlag, parseMaxIterationsFlag } from "../src/cli/run-max-iterations";
import { resolveUseHeadless } from "../src/cli/run-mode";
import { parseParallelFlag } from "../src/cli/run-parallel";
import { findProjectDir, type NaxConfig, validateDirectory } from "../src/config";
import { initLogger, type LogLevel } from "../src/logger";
import type { PlanResult } from "../src/plan/strategies";
import { loadPRD } from "../src/prd";
import { projectOutputDir } from "../src/runtime";
import { resolveScheduleGate, type ScheduleGateResult } from "../src/schedule";
import type { renderTui } from "../src/tui";
import { validateFeatureName } from "../src/utils/feature-name";

/** The parsed `nax run` options, as commander hands them to the action. */
export interface RunActionOptions {
  feature: string;
  agent?: string;
  maxIterations?: string;
  maxCost?: string;
  dryRun: boolean;
  batch?: boolean;
  parallel?: string;
  plan?: boolean;
  from?: string;
  specLint?: boolean;
  oneShot?: boolean;
  force?: boolean;
  headless?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  silent?: boolean;
  json?: boolean;
  dir: string;
  skipPrecheck?: boolean;
  profile?: string[];
  schedule?: string;
  compare?: string;
  fresh?: boolean;
  resume?: boolean | string;
}

export type RunConfig = NaxConfig;
export type LoadedPrd = Awaited<ReturnType<typeof loadPRD>>;
export type FormatterMode = "quiet" | "normal" | "verbose" | "json";
export type TuiInstance = ReturnType<typeof renderTui>;
export type ResolvedScheduleGate = Extract<ScheduleGateResult, { ok: true }>;
export type ResolvedMaxIterationsFlag = Extract<MaxIterationsFlag, { ok: true }>;

/**
 * Surface a degraded plan. `nax plan` is deliberately recovery-tolerant — it
 * yields a usable PRD rather than failing — but a recovered PRD came from the
 * agent's own on-disk output after a throw, not from the strategy's normal
 * path. It used to be indistinguishable from a clean plan at every layer, so
 * `[OK] PRD generated` + exit 0 was the only signal the user ever saw (#1494).
 */
export function warnIfPlanDegraded(result: PlanResult): void {
  if (!result.degraded) return;
  console.log(chalk.yellow("\n[WARN] PRD recovered after a plan failure — this is a degraded result"));
  console.log(chalk.dim(`   Cause: ${result.degraded.reason}`));
  console.log(chalk.dim("   Deterministic spec->PRD repairs were re-applied, but review the PRD before running."));
}

/**
 * Validate the feature name and the working directory, returning the resolved
 * workdir. Exits 1 with the original messages on the first failing gate
 * (feature name before directory — BUG-35 then plain path validation).
 */
export function resolveRunWorkdir(options: RunActionOptions): string {
  // Reject path-traversal / multi-segment names before they become a directory
  // segment under .nax/features/ — `nax run -f ../x` would otherwise mkdir
  // outside the features tree the same way `nax features create` could (BUG-35).
  try {
    validateFeatureName(options.feature);
  } catch (err) {
    console.error(chalk.red(`Invalid feature name: ${(err as Error).message}`));
    process.exit(1);
  }

  // Validate directory path
  try {
    return validateDirectory(options.dir);
  } catch (err) {
    console.error(chalk.red(`Invalid directory: ${(err as Error).message}`));
    process.exit(1);
  }
}

/**
 * Validate `-m/--max-iterations` and `--parallel` before any config load,
 * bake-off check or TUI mount — both errors must print before any TUI exists.
 */
export function parseRunPreconditionFlags(options: RunActionOptions): {
  maxIterationsFlag: ResolvedMaxIterationsFlag;
  parallel: number | undefined;
} {
  // US-001: validate -m before any config load, bake-off check or TUI mount.
  // The parsed value is applied to `config` below, once it is loaded.
  const maxIterationsFlag = parseMaxIterationsFlag(options.maxIterations);
  if (!maxIterationsFlag.ok) {
    console.error(chalk.red(maxIterationsFlag.message));
    process.exit(1);
  }

  // US-002: validate --parallel alongside -m and before any config load,
  // bake-off check or TUI mount — the error must print before any TUI exists.
  const parallelFlag = parseParallelFlag(options.parallel);
  if (!parallelFlag.ok) {
    console.error(chalk.red(parallelFlag.message));
    process.exit(1);
  }
  return { maxIterationsFlag, parallel: parallelFlag.value };
}

/**
 * Bake-off preflight: --compare/--agent exclusivity, contestant validation
 * and the worst-case cost confirmation gate — all before any spend.
 */
export async function validateBakeoffPreflight(options: RunActionOptions, workdir: string): Promise<void> {
  // Bake-off: --compare and --agent are mutually exclusive
  try {
    const { assertCompareAgentExclusive } = await import("../src/bakeoff/preflight");
    assertCompareAgentExclusive({ compare: options.compare, agent: options.agent });
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }

  // Bake-off: validate contestants up-front, before any spend
  if (options.compare) {
    const { parseCompareList, validateContestants, computeWorstCaseCost } = await import("../src/bakeoff/preflight");
    const contestants = parseCompareList(options.compare);
    if (contestants.length === 0) {
      console.error(chalk.red("Error: --compare requires at least one contestant agent (e.g. --compare claude,codex)"));
      process.exit(1);
    }
    const { errors, validAgents } = await validateContestants(contestants, workdir);
    if (errors.length > 0) {
      console.error(chalk.red("Bake-off pre-flight failed:"));
      for (const e of errors) {
        console.error(chalk.red(`   ${e.agent}: ${e.reason}`));
      }
      process.exit(1);
    }

    // Worst-case cost confirmation gate — printed and confirmed before any
    // contestant spawns (spec: "N × max-cost is printed and confirmed").
    if (options.maxCost !== undefined) {
      const maxCostPerContestant = Number(options.maxCost);
      if (!Number.isFinite(maxCostPerContestant) || maxCostPerContestant <= 0) {
        console.error(chalk.red("--max-cost must be a positive number"));
        process.exit(1);
      }
      const worstCase = computeWorstCaseCost(validAgents.length, maxCostPerContestant);
      console.log(
        chalk.yellow(
          `Bake-off worst-case exposure: ${validAgents.length} contestants × $${maxCostPerContestant} = $${worstCase}`,
        ),
      );
      const confirmed = await promptForConfirmation("Proceed with bake-off run?");
      if (!confirmed) {
        console.log(chalk.dim("Bake-off cancelled."));
        process.exit(0);
      }
    }
  }
}

/**
 * Parse --schedule and validate the --plan/--from pairing early, so a bad
 * value errors before any setup. Returns the resolved schedule gate for the
 * wait phase later in the action.
 */
export function resolveRunScheduleAndPlanFlags(options: RunActionOptions): ResolvedScheduleGate {
  // Parse --schedule early so a bad value errors before any setup.
  const scheduleGate = resolveScheduleGate(options.schedule, new Date());
  if (!scheduleGate.ok) {
    console.error(chalk.red(`Invalid --schedule: ${scheduleGate.error}`));
    process.exit(1);
  }

  // Validate --plan and --from flags (AC-8: --plan without --from is error)
  if (options.plan && !options.from) {
    console.error(chalk.red("Error: --plan requires --from <spec-path>"));
    process.exit(1);
  }

  // Validate --from path exists (AC-7: --from without existing file throws error)
  if (options.from && !existsSync(options.from)) {
    console.error(chalk.red(`Error: File not found: ${options.from} (required with --plan)`));
    process.exit(1);
  }

  return scheduleGate;
}

/** Resolve the log level (env var takes precedence over flags) and formatter mode. */
export function resolveRunLogMode(options: RunActionOptions): { logLevel: LogLevel; formatterMode: FormatterMode } {
  // Determine log level from flags or env var (env var takes precedence)
  let logLevel: LogLevel = "info"; // default
  const envLevel = process.env.NAX_LOG_LEVEL?.toLowerCase();
  if (envLevel && ["error", "warn", "info", "debug"].includes(envLevel)) {
    logLevel = envLevel as LogLevel;
  } else if (options.verbose) {
    logLevel = "debug";
  } else if (options.quiet) {
    logLevel = "warn";
  } else if (options.silent) {
    logLevel = "error";
  }

  // Determine formatter mode from flags
  let formatterMode: FormatterMode = "normal"; // default
  if (options.json) {
    formatterMode = "json";
  } else if (options.verbose) {
    formatterMode = "verbose";
  } else if (options.quiet || options.silent) {
    formatterMode = "quiet";
  }

  return { logLevel, formatterMode };
}

/**
 * Resolve the project's naxDir (walking up from workdir) and the profile
 * overrides the config load will receive (Delta C4: nax run defaults to the
 * profile the PRD was planned with, unless --profile or NAX_PROFILE overrides
 * it — a chain where a later profile overrides earlier).
 */
export async function resolveRunProjectContext(
  workdir: string,
  options: RunActionOptions,
): Promise<{ naxDir: string | null; cliOverrides: Record<string, unknown> }> {
  const naxDir = findProjectDir(workdir);
  const cliOverrides: Record<string, unknown> = {};
  const cliProfiles: string[] = options.profile ?? [];
  const profileOverride = naxDir
    ? await resolveRunProfileOverride({
        prdPath: join(naxDir, "features", options.feature, "prd.json"),
        projectRoot: workdir,
        cliProfile: cliProfiles,
        envProfile: process.env.NAX_PROFILE,
      })
    : cliProfiles;
  if (profileOverride && profileOverride.length > 0) {
    cliOverrides.profile = profileOverride;
  }
  return { naxDir, cliOverrides };
}

export interface RunPlanPhaseParams {
  options: RunActionOptions;
  config: RunConfig;
  workdir: string;
  projectRoot: string;
  featureDir: string;
  prdPath: string;
}

/**
 * Run the plan phase if --plan is set (AC-4: runs plan then execute):
 * overwrite guard, environment precheck, planCommand + replan loop inside the
 * original's try/catch, then the story-breakdown confirmation gate.
 */
export async function maybeRunPlanPhase(params: RunPlanPhaseParams): Promise<void> {
  const { options, config, workdir, projectRoot, featureDir, prdPath } = params;

  // Run plan phase if --plan flag is set (AC-4: runs plan then execute)
  if (!options.plan || !options.from) return;

  // Guard: block overwrite of existing prd.json unless --force
  if (existsSync(prdPath) && !options.force) {
    console.error(chalk.red(`Error: prd.json already exists for feature "${options.feature}".`));
    console.error(chalk.dim("   Use --force to overwrite, or run without --plan to use the existing PRD."));
    process.exit(1);
  }

  // Run environment precheck before plan — catch blockers early (before expensive LLM calls)
  if (!options.skipPrecheck) {
    const { runEnvironmentPrecheck } = await import("../src/precheck");
    console.log(chalk.dim("\n   [Pre-plan environment check]"));
    const envResult = await runEnvironmentPrecheck(config, workdir);
    if (!envResult.passed) {
      console.error(chalk.red("\n❌ Environment precheck failed — cannot proceed with planning."));
      for (const b of envResult.blockers) {
        console.error(chalk.red(`   ${b.name}: ${b.message}`));
      }
      process.exit(1);
    }
  }

  try {
    const finalPrd = await runPlanningPhase({ options, from: options.from, config, workdir, projectRoot, featureDir });
    await displayPlanConfirmation(finalPrd, options);

    // Continue with normal run using the generated prd.json
    // (prdPath already points to the generated file)
  } catch (err) {
    console.error(chalk.red(`Error during planning: ${(err as Error).message}`));
    process.exit(1);
  }
}

/** Plan logger setup, planCommand, degraded-plan warning and the replan loop; returns the reloaded PRD. */
async function runPlanningPhase(params: {
  options: RunActionOptions;
  from: string;
  config: RunConfig;
  workdir: string;
  projectRoot: string;
  featureDir: string;
}): Promise<LoadedPrd> {
  const { options, from, config, workdir, projectRoot, featureDir } = params;
  // Initialize plan logger before calling planCommand — writes to features/<feature>/plan/<ts>.jsonl
  const planLogDir = join(featureDir, "plan");
  mkdirSync(planLogDir, { recursive: true });
  const planLogId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
  const planLogPath = join(planLogDir, `${planLogId}.jsonl`);
  initLogger({ level: "info", filePath: planLogPath, useChalk: false, headless: true });
  console.log(chalk.dim(`   [Plan log: ${planLogPath}]`));

  console.log(chalk.dim("   [Planning phase: generating PRD from spec]"));
  const planResult = await planCommand(projectRoot, config, {
    from,
    feature: options.feature,
    auto: options.oneShot ?? false, // interactive by default; --one-shot skips Q&A
    branch: undefined,
    // Commander maps `--no-spec-lint` to `specLint: false`; unset means on.
    skipSpecLint: options.specLint === false,
  });
  const generatedPrdPath = planResult.outputPath;
  warnIfPlanDegraded(planResult);

  // Load the generated PRD to display confirmation gate
  const generatedPrd = await loadPRD(generatedPrdPath);

  // Run replan loop before confirmation gate (US-003: insert replan loop)
  await runReplanLoop(workdir, config, {
    feature: options.feature,
    prd: generatedPrd,
    prdPath: generatedPrdPath,
  });

  // Reload PRD after replan loop in case it was modified
  return await loadPRD(generatedPrdPath);
}

/** Display story breakdown (AC-5) and the confirmation gate unless --headless (AC-5, AC-6). */
async function displayPlanConfirmation(prd: LoadedPrd, options: RunActionOptions): Promise<void> {
  console.log(chalk.bold("\n── Planning Summary ──────────────────────────────"));
  console.log(chalk.dim(`Feature: ${prd.feature}`));
  console.log(chalk.dim(`Stories: ${prd.userStories.length}`));
  console.log();

  for (const story of prd.userStories) {
    const complexity = story.routing?.complexity || "unknown";
    console.log(chalk.dim(`  ${story.id}: ${story.title} [${complexity}]`));
  }
  console.log();

  // Show confirmation gate unless --headless (AC-5, AC-6)
  if (!options.headless) {
    // Prompt for user confirmation
    const confirmationResult = await promptForConfirmation("Proceed with execution?");
    if (!confirmationResult) {
      console.log(chalk.yellow("Execution cancelled."));
      process.exit(0);
    }
  }
}

export interface RunLogSetup {
  outputDir: string;
  runsDir: string;
  runId: string;
  logFilePath: string;
  useHeadless: boolean;
}

/** Resolve output/run dirs, the run id, headless mode, and initialize the run logger. */
export function initRunLogging(params: {
  options: RunActionOptions;
  config: RunConfig;
  workdir: string;
  isTTY: boolean;
  logLevel: LogLevel;
  formatterMode: FormatterMode;
}): RunLogSetup {
  const { options, config, workdir, isTTY, logLevel, formatterMode } = params;

  // Resolve output directory: ~/.nax/<projectKey>/ or config.outputDir override
  const projectKey = config.name?.trim() || basename(workdir);
  const outputDir = projectOutputDir(projectKey, config.outputDir);

  // Create run directory and JSONL log file path under the output dir
  const runsDir = join(outputDir, "features", options.feature, "runs");
  mkdirSync(runsDir, { recursive: true });

  // Generate run ID from ISO timestamp
  const runId = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
  const logFilePath = join(runsDir, `${runId}.jsonl`);

  // Determine TUI vs headless mode — see resolveUseHeadless() for the rule.
  const headlessFlag = options.headless ?? false;
  const headlessEnv = process.env.NAX_HEADLESS === "1";
  const useHeadless = resolveUseHeadless({ isTTY, headlessFlag, headlessEnv, formatterMode });

  // Initialize logger with selected level, file path, and formatter mode
  initLogger({
    level: logLevel,
    filePath: logFilePath,
    useChalk: true,
    formatterMode: useHeadless ? formatterMode : undefined,
    headless: useHeadless,
    suppressConsole: !useHeadless,
  });

  return { outputDir, runsDir, runId, logFilePath, useHeadless };
}

/**
 * Apply the CLI-only config overrides (agent, -m, --max-cost). Mutates
 * `config.agent` in place, then applies the max-iterations flag — the same
 * sequence as the original inline block.
 */
export function applyRunCliOverrides(
  config: RunConfig,
  options: RunActionOptions,
  maxIterationsFlag: ResolvedMaxIterationsFlag,
): RunConfig {
  // Override config from CLI
  if (options.agent) {
    config.agent ??= {};
    config.agent.default = options.agent;
  }
  // US-001: override execution.maxIterations only when -m was passed, so a
  // configured value (or the schema default of 20) still takes effect.
  const overridden = applyMaxIterationsFlag(config, maxIterationsFlag.value);
  if (options.maxCost !== undefined) {
    const maxCost = Number(options.maxCost);
    if (!Number.isFinite(maxCost) || maxCost <= 0) {
      console.error(chalk.red("--max-cost must be a positive number"));
      process.exit(1);
    }
    overridden.execution.costLimit = maxCost;
  }
  return overridden;
}

/** Repo-scoped checks resolved only from the trusted base snapshot and commit. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "@/config";
import type { PreRunStepConfig } from "@/config/runtime-types-execution";
import { NaxError } from "@/errors";
import { DEFAULT_GATE_TIMEOUT_MS, GATE_ORDER, resolveGateCommands } from "@/finish";
import { getSafeLogger } from "@/logger";
import type { BotChecksExtractOutput } from "@/operations/bot-checks-extract";
import type { QualityCommandSpec } from "@/quality";
import { type GateStallPolicy, resolveStallDetection } from "@/utils/gate-stall";
import { botGit } from "./git";

export type BotCheckSource = "config" | "agents-md" | "claude-md" | "detected" | "none";
export interface BotCheck {
  readonly name: string;
  readonly command: QualityCommandSpec;
  readonly setup?: QualityCommandSpec;
  /**
   * The stall policy this gate runs under (US-008). Optional so a hand-built
   * literal stays valid; an absent value falls back to `DEFAULT_GATE_STALL_POLICY`
   * at the quality gate runner, never to a re-read of the fixed tree.
   */
  readonly stallDetection?: GateStallPolicy;
}

export type InstallReason = "package-manager" | "lockfile-order";

/** The frozen install derived from one lockfile, and the others worth trying (US-001). */
export interface BotInstallChoice {
  /** The lockfile the install was derived from, e.g. "bun.lock". */
  readonly lockfile: string;
  readonly reason: InstallReason;
  /** Frozen installs of the other lockfiles present on the base, in LOCKFILE_COMMANDS order, deduplicated by command. */
  readonly fallbacks: readonly PreRunStepConfig[];
}

export interface BotChecks {
  readonly source: BotCheckSource;
  readonly gates: readonly BotCheck[];
  readonly preRun: readonly PreRunStepConfig[];
  /**
   * Set only when `preRun` is the single step derived from a lockfile — never
   * for a configured `execution.preRun` and never for an install extracted from
   * an instruction file, whose fallbacks nothing derived.
   */
  readonly install?: BotInstallChoice;
  /**
   * The setup steps a run actually ran, when a frozen fallback replaced the derived install. `preRun`
   * stays the canonical derivation, so the whole candidate set — and the lockfile it was derived from —
   * survives into the artifact the next `nax bot fix` reloads: a fallback that ran is not evidence the
   * candidates after it are wrong, and dropping them made a later fix fail without trying them (B3).
   * This field is what a command *reports*; it is never persisted.
   */
  readonly ranInstall?: readonly PreRunStepConfig[];
}

export const DERIVED_INSTALL_TIMEOUT_SECONDS = 600;

/**
 * The build step's bound. The build is the same gate command the gate runner
 * runs, so it gets that runner's own default — derived, never copied, so the
 * two cannot drift.
 */
export const REVIEW_BUILD_TIMEOUT_SECONDS: number = DEFAULT_GATE_TIMEOUT_MS / 1000;

const MAX_INSTRUCTION_BYTES = 65_536;
export const _botChecksDeps = { runGit: botGit, resolveGateCommands };

type InstructionFile = "AGENTS.md" | "CLAUDE.md";
interface ResolveBotChecksInput {
  repoRoot: string;
  baseSha: string;
  snapshotDir: string;
  hasBaseNax: boolean;
  config: NaxConfig;
  extract: (input: { fileName: InstructionFile; text: string }) => Promise<BotChecksExtractOutput | null>;
}

async function baseFileExists(input: ResolveBotChecksInput, fileName: string): Promise<boolean> {
  const { repoRoot, baseSha } = input;
  const tree = await _botChecksDeps.runGit(["ls-tree", "--name-only", "-z", baseSha, "--", fileName], repoRoot);
  if (tree.exitCode !== 0) {
    throw new NaxError(
      `[bot] Could not inspect base ${fileName}: ${tree.timedOut ? "git timed out" : tree.stderr}`,
      "BOT_CHECKS_READ_FAILED",
      {
        stage: "bot",
        baseSha,
        fileName,
        stderr: tree.stderr,
        timedOut: tree.timedOut,
      },
    );
  }
  return tree.stdout.split("\0").includes(fileName);
}

/** Missing returns null; inspection/read errors throw and must not permit CLAUDE fallback. */
async function readBaseFile(input: ResolveBotChecksInput, fileName: string): Promise<string | null> {
  if (!(await baseFileExists(input, fileName))) return null;
  const { repoRoot, baseSha } = input;
  const result = await _botChecksDeps.runGit(["show", `${baseSha}:${fileName}`], repoRoot);
  if (result.exitCode !== 0) {
    throw new NaxError(
      `[bot] Could not read base ${fileName}: ${result.timedOut ? "git timed out" : result.stderr}`,
      "BOT_CHECKS_READ_FAILED",
      {
        stage: "bot",
        baseSha,
        fileName,
        stderr: result.stderr,
        timedOut: result.timedOut,
      },
    );
  }
  return result.stdout;
}

function configuredPreRun(input: ResolveBotChecksInput): readonly PreRunStepConfig[] | undefined {
  const configured = input.hasBaseNax ? input.config.execution.preRun : undefined;
  if (!configured?.length) return undefined;
  return configured.map((step) => ({ ...step }));
}

function selectPreRun(input: ResolveBotChecksInput, install?: string): readonly PreRunStepConfig[] {
  const configured = configuredPreRun(input);
  if (configured !== undefined) return configured;
  return install ? [{ command: install, timeoutSeconds: DERIVED_INSTALL_TIMEOUT_SECONDS }] : [];
}

/**
 * The policy a gate derived from the trusted snapshot input runs under: the
 * input config's own `quality.stallDetection`, completed from the schema
 * defaults when unset. Never a threshold the extraction inferred, and never a
 * read of the fixed tree.
 */
function trustedPolicy(input: ResolveBotChecksInput): GateStallPolicy {
  return resolveStallDetection(input.config.quality?.stallDetection);
}

async function configChecks(input: ResolveBotChecksInput): Promise<BotChecks | null> {
  if (!input.hasBaseNax) return null;
  try {
    const gates = await _botChecksDeps.resolveGateCommands(input.snapshotDir, []);
    if (!gates.length) return null;
    return {
      source: "config",
      gates: gates.map(({ name, command, setup, stallDetection }) => ({
        name,
        command,
        ...(setup === undefined ? {} : { setup }),
        // Kept as resolved: a gate the snapshot's own config produced already
        // carries the policy that config gave it, and re-deriving it here would
        // substitute the input config's.
        ...(stallDetection === undefined ? {} : { stallDetection }),
      })),
      preRun: selectPreRun(input),
    };
  } catch (cause) {
    getSafeLogger()?.warn("bot", "Skipping base config checks", {
      baseSha: input.baseSha,
      error: errorMessage(cause),
    });
    return null;
  }
}

async function instructionChecks(input: ResolveBotChecksInput): Promise<BotChecks | null> {
  let fileName: InstructionFile = "AGENTS.md";
  try {
    let text = await readBaseFile(input, fileName);
    if (text === null) {
      fileName = "CLAUDE.md";
      text = await readBaseFile(input, fileName);
    }
    if (text === null) return null;
    if (new TextEncoder().encode(text).byteLength > MAX_INSTRUCTION_BYTES) {
      getSafeLogger()?.warn("bot", "Skipping oversized base instruction file", { baseSha: input.baseSha, fileName });
      return null;
    }
    const extracted = await input.extract({ fileName, text });
    if (extracted === null) {
      getSafeLogger()?.warn("bot", "Skipping instruction checks: extraction returned null", {
        baseSha: input.baseSha,
        fileName,
      });
      return null;
    }
    const policy = trustedPolicy(input);
    const gates = GATE_ORDER.flatMap((name) =>
      extracted.gates
        .filter((entry) => entry.gate === name)
        .map(({ command }) => ({ name, command, stallDetection: policy })),
    );
    if (!gates.length) return null;
    return {
      source: fileName === "AGENTS.md" ? "agents-md" : "claude-md",
      gates,
      preRun: selectPreRun(input, extracted.install),
    };
  } catch (cause) {
    getSafeLogger()?.warn("bot", "Skipping base instruction checks", {
      baseSha: input.baseSha,
      fileName,
      error: errorMessage(cause),
    });
    return null;
  }
}

// Root JS package scripts only; other languages/workspaces use the explicit tiers.
const LOCKFILE_COMMANDS = [
  { path: "bun.lock", manager: "bun", prefix: "bun run", install: "bun install --frozen-lockfile" },
  { path: "bun.lockb", manager: "bun", prefix: "bun run", install: "bun install --frozen-lockfile" },
  { path: "package-lock.json", manager: "npm", prefix: "npm run", install: "npm ci" },
  { path: "pnpm-lock.yaml", manager: "pnpm", prefix: "pnpm run", install: "pnpm install --frozen-lockfile" },
  { path: "yarn.lock", manager: "yarn", prefix: "yarn", install: undefined },
] as const;

type LockfileEntry = (typeof LOCKFILE_COMMANDS)[number];

/** What the base's lockfiles say about which install to run first, and what else to try (US-001). */
interface LockfileChoice {
  readonly prefix: string;
  readonly install?: string;
  readonly lockfile?: string;
  readonly reason?: InstallReason;
  readonly fallbacks: readonly PreRunStepConfig[];
}

const NO_LOCKFILE_PREFIX = "npm run";

/**
 * Every entry is inspected, not only up to the first present one: a repo can
 * carry more than one lockfile, and an inspection or read failure on any of
 * them fails the derivation rather than being skipped.
 */
async function presentLockfiles(input: ResolveBotChecksInput): Promise<LockfileEntry[]> {
  const present: LockfileEntry[] = [];
  for (const entry of LOCKFILE_COMMANDS) {
    if ((await readBaseFile(input, entry.path)) !== null) present.push(entry);
  }
  return present;
}

/** `"npm@10.9.0"` -> `"npm"`; an empty name declares nothing. */
function managerOf(packageManager: string): string | undefined {
  const at = packageManager.indexOf("@");
  const name = at === -1 ? packageManager : packageManager.slice(0, at);
  return name === "" ? undefined : name;
}

/**
 * The package manager the base `package.json` declares. A missing file, an
 * unparseable one or a non-string `packageManager` is ignored — only a read or
 * inspection *failure* fails the derivation, and `readBaseFile` throws that.
 */
async function declaredManager(input: ResolveBotChecksInput): Promise<string | undefined> {
  const text = await readBaseFile(input, "package.json");
  if (text === null) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    // An unparseable base package.json declares no manager; lockfile order decides.
    return undefined;
  }
  if (!isRecord(manifest) || typeof manifest.packageManager !== "string") return undefined;
  return managerOf(manifest.packageManager);
}

/** The other frozen installs present, in LOCKFILE_COMMANDS order, never the chosen one, never twice. */
function frozenFallbacks(present: readonly LockfileEntry[], chosen: LockfileEntry): PreRunStepConfig[] {
  const commands = new Set<string>();
  const fallbacks: PreRunStepConfig[] = [];
  for (const entry of present) {
    const command = entry.install;
    if (command === undefined || command === chosen.install || commands.has(command)) continue;
    commands.add(command);
    fallbacks.push({ command, timeoutSeconds: DERIVED_INSTALL_TIMEOUT_SECONDS });
  }
  return fallbacks;
}

async function lockfileCommands(input: ResolveBotChecksInput): Promise<LockfileChoice> {
  const present = await presentLockfiles(input);
  if (present.length === 0) return { prefix: NO_LOCKFILE_PREFIX, fallbacks: [] };
  // Choosing between lockfiles is the only thing the declared manager decides, so a repo with
  // one lockfile never reads `package.json`.
  const manager = present.length > 1 ? await declaredManager(input) : undefined;
  const byManager =
    manager === undefined
      ? undefined
      : present.find((entry) => entry.manager === manager && entry.install !== undefined);
  const chosen = byManager ?? present[0];
  return {
    prefix: chosen.prefix,
    ...(chosen.install === undefined ? {} : { install: chosen.install }),
    lockfile: chosen.path,
    reason: byManager === undefined ? "lockfile-order" : "package-manager",
    fallbacks: frozenFallbacks(present, chosen),
  };
}

/**
 * The setup a lockfile choice contributes: a configured `execution.preRun` wins
 * outright and carries no install metadata. Otherwise the chosen frozen install
 * is the single step, and its fallbacks travel with it.
 */
function derivedSetup(input: ResolveBotChecksInput, choice: LockfileChoice): Pick<BotChecks, "preRun" | "install"> {
  const configured = configuredPreRun(input);
  if (configured !== undefined) return { preRun: configured };
  const { install, lockfile, reason, fallbacks } = choice;
  if (install === undefined || lockfile === undefined || reason === undefined) return { preRun: [] };
  return {
    preRun: [{ command: install, timeoutSeconds: DERIVED_INSTALL_TIMEOUT_SECONDS }],
    install: { lockfile, reason, fallbacks },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scriptGates(scripts: Record<string, unknown>, prefix: string): BotCheck[] {
  return GATE_ORDER.flatMap((name) => {
    if (!["build", "typecheck", "lint", "test"].includes(name)) return [];
    const script = name === "typecheck" && typeof scripts.typecheck !== "string" ? "type-check" : name;
    const value = scripts[script];
    if (typeof value !== "string" || (name === "test" && value.includes("no test specified"))) return [];
    return [{ name, command: `${prefix} ${script}` }];
  });
}

async function detectedChecks(input: ResolveBotChecksInput): Promise<BotChecks | null> {
  try {
    const text = await readBaseFile(input, "package.json");
    if (text === null) return null;
    const manifest: unknown = JSON.parse(text);
    if (!isRecord(manifest) || !isRecord(manifest.scripts)) return null;
    const choice = await lockfileCommands(input);
    const policy = trustedPolicy(input);
    const gates = scriptGates(manifest.scripts, choice.prefix).map((gate) => ({ ...gate, stallDetection: policy }));
    return gates.length ? { source: "detected", gates, ...derivedSetup(input, choice) } : null;
  } catch (cause) {
    getSafeLogger()?.warn("bot", "Skipping base detected checks", {
      baseSha: input.baseSha,
      error: errorMessage(cause),
    });
    return null;
  }
}

/** First non-empty trusted tier wins; installation falls back independently. */
export async function resolveBotChecks(input: ResolveBotChecksInput): Promise<BotChecks> {
  const checks = (await configChecks(input)) ?? (await instructionChecks(input)) ?? (await detectedChecks(input));
  if (!checks) return { source: "none", gates: [], preRun: [] };
  if (checks.preRun.length || checks.source === "detected") return checks;
  try {
    const choice = await lockfileCommands(input);
    return { ...checks, ...derivedSetup(input, choice) };
  } catch (cause) {
    getSafeLogger()?.warn("bot", "Skipping base lockfile install", {
      baseSha: input.baseSha,
      error: errorMessage(cause),
    });
    return checks;
  }
}

/** The post-session bar includes each gate's setup immediately before its commands. */
export function barCommands(checks: BotChecks): string[] {
  return checks.gates.flatMap(({ name, command, setup }) => {
    const preparation = setup === undefined ? [] : typeof setup === "string" ? [setup] : setup;
    return [
      ...preparation.map((step) => `${step}  (setup for ${name})`),
      ...(typeof command === "string" ? [command] : command),
    ];
  });
}

/** Lists represent multiple shell commands, not argv; setup and preRun are not gates. */
export function checkCommands(checks: BotChecks): string[] {
  return checks.gates.flatMap(({ command }) => (typeof command === "string" ? [command] : command));
}

/**
 * The post-install build steps a fresh review checkout runs.
 *
 * Only the root gate named exactly `build`: `build@<package>` is a per-package
 * overlay the review never fans out, and a `build` gate never carries a
 * `setup` (`resolveGateCommands` gives only `e2e` one), so there is none to
 * honour here. A list command is several shell commands and becomes one step
 * each.
 */
export function reviewBuildSteps(checks: BotChecks): PreRunStepConfig[] {
  const build = checks.gates.find(({ name }) => name === "build");
  if (build === undefined) return [];
  const commands = typeof build.command === "string" ? [build.command] : build.command;
  return commands.map((command) => ({ command, timeoutSeconds: REVIEW_BUILD_TIMEOUT_SECONDS }));
}

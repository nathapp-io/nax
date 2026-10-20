/** Repo-scoped checks resolved only from the trusted base snapshot and commit. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "@/config";
import type { PreRunStepConfig } from "@/config/runtime-types-execution";
import { NaxError } from "@/errors";
import { GATE_ORDER, resolveGateCommands } from "@/finish";
import { getSafeLogger } from "@/logger";
import type { BotChecksExtractOutput } from "@/operations/bot-checks-extract";
import type { QualityCommandSpec } from "@/quality";
import { gitWithTimeout } from "@/utils/git";

export type BotCheckSource = "config" | "agents-md" | "claude-md" | "detected" | "none";
export interface BotCheck {
  readonly name: string;
  readonly command: QualityCommandSpec;
  readonly setup?: QualityCommandSpec;
}
export interface BotChecks {
  readonly source: BotCheckSource;
  readonly gates: readonly BotCheck[];
  readonly preRun: readonly PreRunStepConfig[];
}

export const DERIVED_INSTALL_TIMEOUT_SECONDS = 600;
const MAX_INSTRUCTION_BYTES = 65_536;
export const _botChecksDeps = { runGit: gitWithTimeout, resolveGateCommands };

type InstructionFile = "AGENTS.md" | "CLAUDE.md";
interface ResolveBotChecksInput {
  repoRoot: string;
  baseSha: string;
  snapshotDir: string;
  hasBaseNax: boolean;
  config: NaxConfig;
  extract: (input: { fileName: InstructionFile; text: string }) => Promise<BotChecksExtractOutput | null>;
}

/** Missing is distinct from an error: only missing AGENTS permits CLAUDE fallback. */
async function baseFileExists(input: ResolveBotChecksInput, fileName: string): Promise<boolean> {
  const { repoRoot, baseSha } = input;
  const tree = await _botChecksDeps.runGit(["ls-tree", "--name-only", "-z", baseSha, "--", fileName], repoRoot);
  if (tree.exitCode !== 0) {
    throw new NaxError(`[bot] Could not inspect base ${fileName}`, "BOT_CHECKS_READ_FAILED", {
      stage: "bot",
      baseSha,
      fileName,
      stderr: tree.stderr,
      timedOut: tree.timedOut,
    });
  }
  return tree.stdout.split("\0").includes(fileName);
}

async function readBaseFile(input: ResolveBotChecksInput, fileName: string): Promise<string | null> {
  if (!(await baseFileExists(input, fileName))) return null;
  const { repoRoot, baseSha } = input;
  const result = await _botChecksDeps.runGit(["show", `${baseSha}:${fileName}`], repoRoot);
  if (result.exitCode !== 0) {
    throw new NaxError(`[bot] Could not read base ${fileName}`, "BOT_CHECKS_READ_FAILED", {
      stage: "bot",
      baseSha,
      fileName,
      stderr: result.stderr,
      timedOut: result.timedOut,
    });
  }
  return result.stdout;
}

function selectPreRun(input: ResolveBotChecksInput, install?: string): readonly PreRunStepConfig[] {
  const configured = input.hasBaseNax ? input.config.execution.preRun : undefined;
  if (configured?.length) return configured;
  return install ? [{ command: install, timeoutSeconds: DERIVED_INSTALL_TIMEOUT_SECONDS }] : [];
}

async function configChecks(input: ResolveBotChecksInput): Promise<BotChecks | null> {
  if (!input.hasBaseNax) return null;
  try {
    const gates = await _botChecksDeps.resolveGateCommands(input.snapshotDir, []);
    if (!gates.length) return null;
    return {
      source: "config",
      gates: gates.map(({ name, command, setup }) => ({ name, command, ...(setup === undefined ? {} : { setup }) })),
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
    const gates = GATE_ORDER.flatMap((name) =>
      extracted.gates.filter((entry) => entry.gate === name).map(({ command }) => ({ name, command })),
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
  { path: "bun.lock", prefix: "bun run", install: "bun install --frozen-lockfile" },
  { path: "bun.lockb", prefix: "bun run", install: "bun install --frozen-lockfile" },
  { path: "package-lock.json", prefix: "npm run", install: "npm ci" },
  { path: "pnpm-lock.yaml", prefix: "pnpm run", install: "pnpm install --frozen-lockfile" },
  { path: "yarn.lock", prefix: "yarn", install: undefined },
] as const;

async function lockfileCommands(input: ResolveBotChecksInput): Promise<{ prefix: string; install?: string }> {
  for (const entry of LOCKFILE_COMMANDS) {
    if ((await readBaseFile(input, entry.path)) !== null) return entry;
  }
  return { prefix: "npm run" };
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
    const { prefix, install } = await lockfileCommands(input);
    const gates = scriptGates(manifest.scripts, prefix);
    return gates.length ? { source: "detected", gates, preRun: selectPreRun(input, install) } : null;
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
    const { install } = await lockfileCommands(input);
    return { ...checks, preRun: selectPreRun(input, install) };
  } catch (cause) {
    getSafeLogger()?.warn("bot", "Skipping base lockfile install", {
      baseSha: input.baseSha,
      error: errorMessage(cause),
    });
    return checks;
  }
}

/** Lists represent multiple shell commands, not argv; setup and preRun are not gates. */
export function checkCommands(checks: BotChecks): string[] {
  return checks.gates.flatMap(({ command }) => (typeof command === "string" ? [command] : command));
}

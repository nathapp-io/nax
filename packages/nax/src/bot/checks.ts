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
async function readBaseInstruction(input: ResolveBotChecksInput, fileName: InstructionFile): Promise<string | null> {
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
  if (!tree.stdout.split("\0").includes(fileName)) return null;
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
    let text = await readBaseInstruction(input, fileName);
    if (text === null) {
      fileName = "CLAUDE.md";
      text = await readBaseInstruction(input, fileName);
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

/** First non-empty trusted tier wins. Detection and lockfile fallback are added separately. */
export async function resolveBotChecks(input: ResolveBotChecksInput): Promise<BotChecks> {
  return (await configChecks(input)) ?? (await instructionChecks(input)) ?? { source: "none", gates: [], preRun: [] };
}

/** Lists represent multiple shell commands, not argv; setup and preRun are not gates. */
export function checkCommands(checks: BotChecks): string[] {
  return checks.gates.flatMap(({ command }) => (typeof command === "string" ? [command] : command));
}

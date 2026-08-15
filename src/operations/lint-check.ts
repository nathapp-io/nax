import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import { detectTool, parseDiagnostics } from "../quality/diagnostics";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import type { LintOutputFormat, LintParseResult } from "../review/lint-parsing";
import { parseLintOutput } from "../review/lint-parsing";
import { appendScratchEntry } from "../session/scratch-writer";
import { errorMessage } from "../utils/errors";
import type { CallContext, DeterministicOperation } from "./types";

export interface LintCheckInput {
  readonly workdir: string;
  readonly storyId: string;
  /**
   * Session scratch dir for tool-diagnostics capture (US-001). Populated by
   * plan-inputs from PipelineContext.sessionScratchDir in production; injected
   * tests may omit it and instead set `deps.sessionScratchDir`.
   */
  readonly sessionScratchDir?: string;
}

export interface LintCheckOutput {
  readonly success: boolean;
  readonly status?: "passed" | "skipped";
  readonly findings: Finding[];
  readonly durationMs: number;
}

export interface LintCheckDeps {
  runQualityCommand: (opts: QualityCommandOptions) => Promise<QualityCommandResult>;
  parseLintOutput: (output: string, format?: LintOutputFormat, opts?: { workdir: string }) => LintParseResult | null;
  /**
   * Optional scratch dir for tool-diagnostics capture (US-001). When set, a
   * failed lint run writes a `tool-diagnostics` scratch entry to this dir
   * using `appendScratchEntry`. Capture is best-effort — errors are swallowed
   * so the lint result is never blocked.
   */
  sessionScratchDir?: string;
  appendScratchEntry?: (scratchDir: string, entry: import("../session/scratch-writer").ScratchEntry) => Promise<void>;
}

export const _lintCheckDeps: LintCheckDeps = {
  runQualityCommand,
  parseLintOutput,
  appendScratchEntry,
};

/**
 * Best-effort capture of authoritative tool diagnostics into the story scratch
 * dir (US-001). Only fires when a scratch dir AND append fn are wired. Errors
 * are logged at warn and swallowed — capture never blocks the lint result.
 */
async function captureToolDiagnostics(
  storyId: string,
  result: QualityCommandResult,
  tool: string,
  sessionScratchDir: string | undefined,
  appendScratchEntry: LintCheckDeps["appendScratchEntry"],
): Promise<void> {
  if (!sessionScratchDir || !appendScratchEntry) return;
  try {
    const diagnostics = await parseDiagnostics(result, tool);
    await appendScratchEntry(sessionScratchDir, {
      kind: "tool-diagnostics",
      timestamp: new Date().toISOString(),
      storyId,
      diagnostics,
    });
  } catch (err) {
    getSafeLogger()?.warn("quality", "Failed to write tool-diagnostics scratch entry — continuing", {
      storyId,
      tool,
      error: errorMessage(err),
    });
  }
}

export const lintCheckOp: DeterministicOperation<LintCheckInput, LintCheckOutput, QualityConfig> = {
  kind: "deterministic",
  name: "lint-check",
  stage: "review",
  config: qualityConfigSelector,
  async execute(
    input: LintCheckInput,
    ctx: CallContext,
    deps: LintCheckDeps = _lintCheckDeps,
  ): Promise<LintCheckOutput> {
    const quality = ctx.packageView.select(qualityConfigSelector).quality;
    let command = quality?.commands?.lint;

    // Detection fallback: derive a default from the package's manifest when no
    // command is configured (only emitted when the tool/config is present). Runs
    // from the package dir, since that is where it was detected.
    let detectedFromPackage = false;
    if (!command) {
      const { resolveDefaultQualityCommands } = await import("../quality/command-defaults");
      // input.workdir is the resolved ABSOLUTE package dir; ctx.packageView.packageDir
      // is the RELATIVE key — never probe the filesystem against it.
      command = (await resolveDefaultQualityCommands(input.workdir)).lint;
      detectedFromPackage = Boolean(command);
    }

    // No command configured or detected → skip (success, non-blocking) with a warning.
    // Never spawn an empty command (that would exit 0 and read as a false pass).
    if (!command) {
      getSafeLogger()?.warn("quality", "No lint command configured — skipping lint gate", {
        storyId: input.storyId,
        packageDir: ctx.packageView.packageDir,
      });
      return { success: true, status: "skipped", findings: [], durationMs: 0 };
    }

    // Detected default → run from the package dir (absolute input.workdir, not the
    // relative packageView key); configured-but-no-override → repo root.
    const cmdWorkdir = detectedFromPackage
      ? input.workdir
      : ctx.packageView.hasOverride
        ? input.workdir
        : ctx.packageView.repoRoot;
    const start = Date.now();
    const result = await deps.runQualityCommand({
      commandName: "lint",
      command,
      workdir: cmdWorkdir,
      storyId: input.storyId,
      stripEnvVars: quality?.stripEnvVars ?? [],
    });

    if (result.exitCode === 0) {
      return { success: true, status: "passed", findings: [], durationMs: Date.now() - start };
    }

    await captureToolDiagnostics(
      input.storyId,
      result,
      detectTool(result.command, result.commandName),
      input.sessionScratchDir ?? deps.sessionScratchDir,
      deps.appendScratchEntry,
    );

    const parsed = deps.parseLintOutput(result.output, "auto", { workdir: input.workdir });
    const parsedFindings = parsed?.findings ?? [];
    // Sentinel ensures mechanical-lintfix strategy fires even when the linter's
    // output format is unrecognised (parsedFindings empty).
    const sentinel: Finding = {
      source: "lint",
      severity: "error",
      category: "lint-failure",
      message: `lint failed (no structured findings parsed), please run the lint check command: ${command}`,
    };
    const findings = parsedFindings.length > 0 ? parsedFindings : [sentinel];
    return { success: false, findings, durationMs: Date.now() - start };
  },
};

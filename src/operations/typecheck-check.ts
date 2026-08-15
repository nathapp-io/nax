import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import { parseDiagnostics } from "../quality/diagnostics";
import type { QualityCommandOptions, QualityCommandResult } from "../quality/runner";
import { runQualityCommand } from "../quality/runner";
import { parseTypecheckOutput } from "../review/typecheck-parsing";
import type { TypecheckOutputFormat, TypecheckParseResult } from "../review/typecheck-parsing/types";
import { errorMessage } from "../utils/errors";
import type { CallContext, DeterministicOperation } from "./types";

export interface TypecheckCheckInput {
  readonly workdir: string;
  readonly storyId: string;
}

export interface TypecheckCheckOutput {
  readonly success: boolean;
  readonly status?: "passed" | "skipped";
  readonly findings: Finding[];
  readonly durationMs: number;
}

export interface TypecheckCheckDeps {
  runQualityCommand: (opts: QualityCommandOptions) => Promise<QualityCommandResult>;
  parseTypecheckOutput: (
    output: string,
    format?: TypecheckOutputFormat,
    opts?: { workdir: string },
  ) => TypecheckParseResult | null;
  /**
   * Optional scratch dir for tool-diagnostics capture (US-001). When set, a
   * failed typecheck run writes a `tool-diagnostics` scratch entry to this
   * dir using `appendScratchEntry`. Capture is best-effort — errors are
   * swallowed so the typecheck result is never blocked.
   */
  sessionScratchDir?: string;
  appendScratchEntry?: (scratchDir: string, entry: import("../session/scratch-writer").ScratchEntry) => Promise<void>;
}

export const _typecheckCheckDeps: TypecheckCheckDeps = {
  runQualityCommand,
  parseTypecheckOutput,
};

/**
 * Best-effort capture of authoritative tool diagnostics into the story scratch
 * dir (US-001). Only fires when a scratch dir AND append fn are wired. Errors
 * are logged at warn and swallowed — capture never blocks the typecheck result.
 */
async function captureToolDiagnostics(
  storyId: string,
  result: QualityCommandResult,
  tool: string,
  sessionScratchDir: string | undefined,
  appendScratchEntry: TypecheckCheckDeps["appendScratchEntry"],
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

export const typecheckCheckOp: DeterministicOperation<TypecheckCheckInput, TypecheckCheckOutput, QualityConfig> = {
  kind: "deterministic",
  name: "typecheck-check",
  stage: "review",
  config: qualityConfigSelector,
  async execute(
    input: TypecheckCheckInput,
    ctx: CallContext,
    deps: TypecheckCheckDeps = _typecheckCheckDeps,
  ): Promise<TypecheckCheckOutput> {
    const quality = ctx.packageView.select(qualityConfigSelector).quality;
    let command = quality?.commands?.typecheck;

    // Detection fallback: derive a default from the package's manifest when no
    // command is configured (only safe built-ins / present-config). Runs from the
    // package dir, since that is where it was detected.
    let detectedFromPackage = false;
    if (!command) {
      const { resolveDefaultQualityCommands } = await import("../quality/command-defaults");
      // input.workdir is the resolved ABSOLUTE package dir; ctx.packageView.packageDir
      // is the RELATIVE key — never probe the filesystem against it.
      command = (await resolveDefaultQualityCommands(input.workdir)).typecheck;
      detectedFromPackage = Boolean(command);
    }

    if (!command) {
      getSafeLogger()?.warn("quality", "No typecheck command configured — skipping typecheck gate", {
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
      commandName: "typecheck",
      command,
      workdir: cmdWorkdir,
      storyId: input.storyId,
      stripEnvVars: quality?.stripEnvVars ?? [],
    });

    if (result.exitCode === 0) {
      return { success: true, status: "passed", findings: [], durationMs: Date.now() - start };
    }

    await captureToolDiagnostics(input.storyId, result, "tsc", deps.sessionScratchDir, deps.appendScratchEntry);

    const parsed = deps.parseTypecheckOutput(result.output, "auto", { workdir: input.workdir });
    const parsedFindings = parsed?.findings ?? [];
    // Sentinel ensures autofix-implementer strategy fires even when the typecheck
    // output format is unrecognised. fixTarget="source" is required — autofix-implementer
    // gates on it, and typecheck errors always land in source code.
    const sentinel: Finding = {
      source: "typecheck",
      severity: "error",
      category: "typecheck-failure",
      fixTarget: "source",
      message: `typecheck failed (no structured findings parsed), please run the typecheck command: ${command}`,
    };
    const findings = parsedFindings.length > 0 ? parsedFindings : [sentinel];
    return { success: false, findings, durationMs: Date.now() - start };
  },
};

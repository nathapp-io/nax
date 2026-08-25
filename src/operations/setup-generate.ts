import { makeParseRetryStrategy } from "../agents/retry";
// Leaf import: `SetupPlanError` extends this at module-evaluation time, and the
// `../agents/retry` barrel can be partially initialized when this module is
// reached through an import cycle.
import { ParseValidationError } from "../agents/retry/types";
import type { RepoAnalysis } from "../cli/setup-types";
import type { NaxConfig } from "../config";
import { NaxConfigSchema } from "../config/schemas";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { SetupPromptBuilder } from "../prompts/builders/setup-builder";
import { parseLLMJson } from "../utils/llm-json";
import type { BuildContext, RunOperation } from "./types";

export const MAX_SETUP_LLM_ATTEMPTS = 2;

export interface MonoPackageConfig {
  relativeDir: string;
  config: Partial<NaxConfig>;
}

export interface SetupPlan {
  config: NaxConfig;
  monoConfigs: MonoPackageConfig[];
  gaps: string[];
}

export interface RawSetupPlan {
  config: unknown;
  monoConfigs?: Array<{ relativeDir: string; config: unknown }>;
}

class SetupPlanError extends ParseValidationError {
  readonly code = "SETUP_PLAN_INVALID" as const;
}

function throwSetupPlanError(message: string): never {
  throw new NaxError(`[setup-generate] ${message}`, "SETUP_PLAN_INVALID");
}

function validateSetupOutput(parsed: unknown): boolean {
  const config = (parsed as { config?: unknown } | null)?.config ?? parsed;
  return NaxConfigSchema.safeParse(config).success;
}

export function crossCheckCommands(config: NaxConfig, analysis: RepoAnalysis): { config: NaxConfig; gaps: string[] } {
  // Root config is checked against root package only (relativeDir === "").
  // Per-package mono configs check their own packages separately.
  const rootPkg = analysis.packages.find((p) => p.relativeDir === "") ?? analysis.packages[0];
  const missing = new Set(rootPkg?.missingScripts ?? []);
  if (missing.size === 0) return { config, gaps: [] };

  const quality = config.quality as { commands?: Record<string, string> } | undefined;
  if (!quality?.commands) return { config, gaps: [] };

  const gaps: string[] = [];
  const commands: Record<string, string> = {};
  for (const [key, value] of Object.entries(quality.commands)) {
    if (missing.has(key)) {
      gaps.push(`Script "${key}" in quality.commands.${key} is missing from package.json`);
    } else {
      commands[key] = value;
    }
  }

  if (gaps.length === 0) return { config, gaps: [] };
  return { config: { ...config, quality: { ...quality, commands } } as NaxConfig, gaps };
}

export function buildMonoConfigs(parsed: RawSetupPlan, analysis: RepoAnalysis): MonoPackageConfig[] {
  if (analysis.shape !== "mono") return [];
  const rawMonoConfigs = parsed.monoConfigs ?? [];
  return analysis.packages.map((pkg) => {
    const rawMono = rawMonoConfigs.find((m) => m.relativeDir === pkg.relativeDir);
    const validated = rawMono ? NaxConfigSchema.safeParse(rawMono.config) : undefined;
    if (rawMono && !validated?.success) {
      getLogger().warn("setup-generate", "Per-package config failed schema validation — using empty config", {
        storyId: "setup",
        relativeDir: pkg.relativeDir,
      });
    }
    const config = (validated?.success ? validated.data : undefined) ?? {};
    return { relativeDir: pkg.relativeDir, config: config as Partial<NaxConfig> };
  });
}

const setupRetryStrategy = makeParseRetryStrategy({
  reviewerKind: "setup-generate",
  maxAttempts: MAX_SETUP_LLM_ATTEMPTS,
  validate: validateSetupOutput,
  prompts: {
    invalid: () =>
      "The response was not valid JSON or failed schema validation. Please respond with a valid JSON object.",
    truncated: () => "The response was truncated. Please provide the complete JSON config.",
  },
  exhaustedFallback: () => {
    throwSetupPlanError("LLM failed to generate a valid setup plan after exhausting retries");
  },
});

export const setupGenerateOp: RunOperation<RepoAnalysis, SetupPlan, NaxConfig> = {
  kind: "run",
  name: "setup-generate",
  stage: "setup",
  session: { role: "setup", lifetime: "fresh" },
  noFallback: true,
  config: ["quality"] as const,
  retry: setupRetryStrategy,
  build(analysis: RepoAnalysis, _ctx: BuildContext<NaxConfig>) {
    return new SetupPromptBuilder().build(analysis);
  },
  parse(output: string, analysis: RepoAnalysis, _ctx: BuildContext<NaxConfig>): SetupPlan {
    let parsedRaw: unknown;
    try {
      parsedRaw = parseLLMJson(output);
    } catch {
      throw new SetupPlanError("Failed to parse LLM output as JSON");
    }

    const parsedObj = parsedRaw as RawSetupPlan | null;
    const rawConfig = parsedObj?.config ?? parsedRaw;
    const result = NaxConfigSchema.safeParse(rawConfig);
    if (!result.success) {
      throw new SetupPlanError(`Config failed NaxConfigSchema: ${result.error.message}`);
    }

    const { config, gaps } = crossCheckCommands(result.data as NaxConfig, analysis);
    const monoConfigs = buildMonoConfigs(parsedObj ?? { config: rawConfig }, analysis);
    return { config, monoConfigs, gaps };
  },
};

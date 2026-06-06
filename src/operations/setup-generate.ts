import { ParseValidationError, makeParseRetryStrategy } from "../agents/retry";
import { NaxConfigSchema } from "../config/schemas";
import { parseLLMJson } from "../utils/llm-json";
import { SetupPromptBuilder } from "../prompts/builders/setup-builder";
import type { NaxConfig } from "../config";
import type { RepoAnalysis } from "../cli/setup-types";
import type { BuildContext, RunOperation } from "./types";

export const MAX_SETUP_LLM_ATTEMPTS = 3;

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
}

class SetupPlanError extends ParseValidationError {
  readonly code = "SETUP_PLAN_INVALID" as const;
}

function validateSetupOutput(parsed: unknown): boolean {
  const config = (parsed as { config?: unknown } | null)?.config ?? parsed;
  return NaxConfigSchema.safeParse(config).success;
}

export function crossCheckCommands(
  config: NaxConfig,
  analysis: RepoAnalysis,
): { config: NaxConfig; gaps: string[] } {
  const allMissing = new Set(analysis.packages.flatMap((p) => p.missingScripts));
  if (allMissing.size === 0) return { config, gaps: [] };

  const quality = config.quality as { commands?: Record<string, string> } | undefined;
  if (!quality?.commands) return { config, gaps: [] };

  const gaps: string[] = [];
  const commands: Record<string, string> = {};
  for (const [key, value] of Object.entries(quality.commands)) {
    if (allMissing.has(key)) {
      gaps.push(`Script "${key}" in quality.commands.${key} is missing from package.json`);
    } else {
      commands[key] = value;
    }
  }

  if (gaps.length === 0) return { config, gaps: [] };
  return { config: { ...config, quality: { ...quality, commands } } as NaxConfig, gaps };
}

export function buildMonoConfigs(analysis: RepoAnalysis): MonoPackageConfig[] {
  if (analysis.shape !== "mono") return [];
  return analysis.packages.map((pkg) => ({ relativeDir: pkg.relativeDir, config: {} }));
}

const setupRetryStrategy = makeParseRetryStrategy({
  reviewerKind: "setup-generate",
  maxAttempts: MAX_SETUP_LLM_ATTEMPTS,
  validate: validateSetupOutput,
  prompts: {
    invalid: () =>
      "The response was not valid JSON or failed schema validation. Please respond with a valid JSON object.",
    truncated: () =>
      "The response was truncated. Please provide the complete JSON config.",
  },
  exhaustedFallback: () => {
    throw new SetupPlanError("LLM failed to generate a valid setup plan after exhausting retries");
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
    let parsed: unknown;
    try {
      parsed = parseLLMJson(output);
    } catch {
      throw new SetupPlanError("Failed to parse LLM output as JSON");
    }

    const rawConfig = (parsed as { config?: unknown } | null)?.config ?? parsed;
    const result = NaxConfigSchema.safeParse(rawConfig);
    if (!result.success) {
      throw new SetupPlanError(`Config failed NaxConfigSchema: ${result.error.message}`);
    }

    const { config, gaps } = crossCheckCommands(result.data as NaxConfig, analysis);
    const monoConfigs = buildMonoConfigs(analysis);
    return { config, monoConfigs, gaps };
  },
};

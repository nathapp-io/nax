/** Repo-scoped, read-only feature state for chat; no launches or model calls. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { featureDir, featuresDir } from "@/config";
import type { ChatWorkflowConfig } from "@/config/runtime-types-chat";
import { buildWorkflowInstructions } from "@/prompts";
import { validateFeatureName } from "@/utils/feature-name";
import { resolveTargetRepo, targetOutputDir } from "../target-repo";
import { type FeatureStateOptions, readFeatureState, readWorkflowStateList } from "./feature-state";
import { similarFeatureNames } from "./similar-features";

/**
 * The answer for a feature name with no artifacts yet. Deliberately not a `FeatureState`:
 * `stage: "not-started"` is what tells the agent the feature is new, and the artifact
 * fields are null rather than a list of unrelated feature names (issue #2927).
 */
export interface NotStartedFeature {
  readonly name: string;
  readonly stage: "not-started";
  readonly spec: null;
  readonly prd: null;
  readonly similar: readonly string[];
}

export const _workflowProviderDeps = { stat: statSync, readdir: readdirSync };

function failure(content: string): ToolResult {
  return { content, isError: true };
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function knownDirectories(repoRoot: string): string[] {
  try {
    return _workflowProviderDeps
      .readdir(featuresDir(repoRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          validateFeatureName(entry.name);
          featureDir(repoRoot, entry.name);
          return [entry.name];
        } catch {
          // Stray invalid names are not features and must not enter suggestions.
          return [];
        }
      })
      .sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

function exists(path: string, kind: "directory" | "file"): boolean {
  try {
    const stat = _workflowProviderDeps.stat(path);
    return kind === "directory" ? stat.isDirectory() : stat.isFile();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function readState(input: Record<string, unknown>, base: FeatureStateOptions): Promise<ToolResult> {
  const target = await resolveTargetRepo(base.repoRoot, input.repo);
  if ("error" in target) return failure(target.error);
  const options: FeatureStateOptions =
    target.root === base.repoRoot
      ? base
      : { ...base, repoRoot: target.root, outputDir: await targetOutputDir(target.root) };
  const { feature } = input;
  if (!("feature" in input) || feature === null || (typeof feature === "string" && !feature.trim())) {
    return { content: JSON.stringify(await readWorkflowStateList(options), null, 2) };
  }
  if (typeof feature !== "string") return failure("[chat] nax-workflow__state feature must be a string");
  let dir: string;
  try {
    validateFeatureName(feature);
    // The artifact reader also requires featureDir's stricter feature-ID contract.
    dir = featureDir(options.repoRoot, feature);
  } catch (err) {
    return failure(errorMessage(err));
  }
  if (exists(dir, "directory") || exists(join(options.repoRoot, ".nax", "specs", `${feature}.md`), "file")) {
    return { content: JSON.stringify(await readFeatureState(feature, options), null, 2) };
  }
  return {
    content: JSON.stringify(
      {
        name: feature,
        stage: "not-started",
        spec: null,
        prd: null,
        similar: similarFeatureNames(feature, knownDirectories(options.repoRoot)),
      } satisfies NotStartedFeature,
      null,
      2,
    ),
  };
}

/**
 * The workflow provider's options: the feature-state inputs plus the loaded
 * `chat.workflow` block, which the instruction text renders.
 */
export interface WorkflowProviderOptions extends FeatureStateOptions {
  /** From `config.chat.workflow`; absent leaves the default instructions. */
  readonly workflow?: ChatWorkflowConfig;
}

/** A static provider: the native runtime owns tool-result size bounds. */
export function createWorkflowProvider(options: WorkflowProviderOptions): ToolProvider {
  const tool: ProviderTool = {
    localName: "state",
    description:
      "Read where a nax feature stands (spec, PRD, last run, workflow verdict, branch). Omit feature to list recently active features. Read-only; call it before proposing any nax plan/run/bot step.",
    inputSchema: {
      type: "object",
      properties: { feature: { type: "string" }, repo: { type: "string" } },
      additionalProperties: false,
    },
    run: async (input) => readState(input, options),
  };
  return {
    id: "nax-workflow",
    kind: "static",
    stages: ["*"],
    tools: async () => [tool],
    instructions: async () => buildWorkflowInstructions({ workflow: options.workflow }),
  };
}

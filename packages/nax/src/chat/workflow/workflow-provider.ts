/** Repo-scoped, read-only feature state for chat; no launches or model calls. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { featureDir, featuresDir } from "@/config";
import { buildWorkflowInstructions } from "@/prompts";
import { validateFeatureName } from "@/utils/feature-name";
import { type FeatureStateOptions, readFeatureState, readWorkflowStateList } from "./feature-state";

const MAX_KNOWN_FEATURES = 20;
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

async function readState(input: Record<string, unknown>, options: FeatureStateOptions): Promise<ToolResult> {
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
  const names = knownDirectories(options.repoRoot);
  const available = names.slice(0, MAX_KNOWN_FEATURES).join(", ") || "(none)";
  const suffix = names.length > MAX_KNOWN_FEATURES ? `, +${names.length - MAX_KNOWN_FEATURES} more` : "";
  return failure(`unknown feature ${feature}; known: ${available}${suffix}`);
}

/** A static provider: the native runtime owns tool-result size bounds. */
export function createWorkflowProvider(options: FeatureStateOptions): ToolProvider {
  const tool: ProviderTool = {
    localName: "state",
    description:
      "Read where a nax feature stands (spec, PRD, last run, workflow verdict, branch). Omit feature to list recently active features. Read-only; call it before proposing any nax plan/run/bot step.",
    inputSchema: {
      type: "object",
      properties: { feature: { type: "string" } },
      additionalProperties: false,
    },
    run: async (input) => readState(input, options),
  };
  return {
    id: "nax-workflow",
    kind: "static",
    stages: ["*"],
    tools: async () => [tool],
    instructions: async () => buildWorkflowInstructions(),
  };
}

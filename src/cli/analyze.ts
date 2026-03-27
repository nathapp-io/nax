/**
 * Analyze Command -- Parse spec.md into prd.json via agent decompose
 *
 * Uses agent adapter's decompose() method to break spec into classified stories
 * in a single LLM call. Falls back to keyword classification if decompose fails.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateAcceptanceTests } from "../acceptance";
import { getAgent } from "../agents/registry";
import { scanCodebase } from "../analyze/scanner";
import type { NaxConfig } from "../config";
import { resolveModel } from "../config/schema";
import { applyDecomposition } from "../decompose/apply";
import { DecomposeBuilder } from "../decompose/builder";
import type { DecomposeAgentConfig as BuilderDecomposeConfig, DecomposeResult, SubStory } from "../decompose/types";
import { getLogger } from "../logger";
import { loadPRD, savePRD } from "../prd";
import type { PRD, UserStory } from "../prd";
import { routeTask } from "../routing";
import { NAX_VERSION } from "../version";
import {
  applyKeywordClassification,
  buildCodebaseContext,
  parseUserStoriesFromSpec,
  reclassifyExistingPRD,
} from "./analyze-parser";

export interface AnalyzeOptions {
  featureDir: string;
  featureName: string;
  branchName: string;
  config?: NaxConfig;
  specPath?: string;
  reclassify?: boolean;
}

/** Parse spec.md into PRD via agent decompose */
export async function analyzeFeature(options: AnalyzeOptions): Promise<PRD> {
  const { featureDir, featureName, branchName, config, specPath: explicitSpecPath, reclassify = false } = options;
  const workdir = join(featureDir, "../..");

  if (reclassify) {
    return await reclassifyExistingPRD(featureDir, featureName, branchName, workdir, config);
  }

  const specPath = explicitSpecPath || join(featureDir, "spec.md");
  if (!existsSync(specPath)) throw new Error(`spec.md not found at ${specPath}`);

  const specContent = await Bun.file(specPath).text();
  let userStories: UserStory[];

  const logger = getLogger();
  if (config?.analyze.llmEnhanced) {
    userStories = await decomposeLLM(specContent, workdir, config, logger);
  } else {
    logger.info("cli", "LLM-enhanced analysis disabled, using manual parsing + keyword classification");
    userStories = parseUserStoriesFromSpec(specContent);
    if (userStories.length === 0) throw new Error("No user stories found in spec.md. Expected '## US-xxx' headings.");
    userStories = applyKeywordClassification(userStories, config);
  }

  if (config && userStories.length > config.execution.maxStoriesPerFeature) {
    logger.warn(
      "cli",
      `Feature has ${userStories.length} stories, exceeding recommended limit of ${config.execution.maxStoriesPerFeature}. Consider splitting.`,
    );
  }

  const naxVersion = NAX_VERSION;

  const now = new Date().toISOString();
  const prd: PRD = {
    project: "nax",
    feature: featureName,
    branchName,
    createdAt: now,
    updatedAt: now,
    userStories,
    analyzeConfig: config
      ? {
          naxVersion,
          model: config.analyze.model,
          llmEnhanced: config.analyze.llmEnhanced,
          maxStoriesPerFeature: config.execution.maxStoriesPerFeature,
          routingStrategy: config.analyze.llmEnhanced ? "llm" : "keyword",
        }
      : undefined,
  };

  // Generate acceptance tests if enabled
  if (config?.acceptance.enabled && config.acceptance.generateTests) {
    await generateAcceptanceTestsForFeature(specContent, featureName, featureDir, workdir, config, logger);
  }

  return prd;
}

/** Run LLM-enhanced decompose and classify stories. */
async function decomposeLLM(
  specContent: string,
  workdir: string,
  config: NaxConfig,
  logger: ReturnType<typeof getLogger>,
): Promise<UserStory[]> {
  logger.info("cli", "Running agent decompose (decompose + classify in single LLM call)");

  try {
    const scan = await scanCodebase(workdir);
    const codebaseContext = buildCodebaseContext(scan);
    const agentName = config.autoMode.defaultAgent;
    const adapter = getAgent(agentName);
    if (!adapter) throw new Error(`Agent "${agentName}" not found`);

    const modelTier = config.analyze.model;
    const modelDef = resolveModel(config.models[modelTier]);
    const result = await adapter.decompose({ specContent, workdir, codebaseContext, modelTier, modelDef, config });

    logger.info("cli", "[OK] Agent decompose complete", { storiesCount: result.stories.length });

    return result.stories.map((ds) => {
      let testStrategy: import("../config").TestStrategy;
      let routingStrategy: "llm" | "keyword";

      if (ds.testStrategy) {
        testStrategy = ds.testStrategy;
        routingStrategy = "llm";
      } else {
        const routing = routeTask(ds.title, ds.description, ds.acceptanceCriteria, ds.tags, config);
        testStrategy = routing.testStrategy;
        routingStrategy = "keyword";
      }

      return {
        id: ds.id,
        title: ds.title,
        description: ds.description,
        acceptanceCriteria: ds.acceptanceCriteria,
        tags: ds.tags,
        dependencies: ds.dependencies,
        status: "pending" as const,
        passes: false,
        escalations: [],
        attempts: 0,
        routing: {
          complexity: ds.complexity,
          testStrategy,
          reasoning: ds.reasoning,
          estimatedLOC: ds.estimatedLOC,
          risks: ds.risks,
          strategy: routingStrategy,
          llmModel: routingStrategy === "llm" ? modelDef.model : undefined,
        },
        contextFiles: ds.contextFiles,
      };
    });
  } catch (error) {
    logger.warn("cli", "Agent decompose failed, falling back to manual story extraction", {
      error: (error as Error).message,
    });
    const stories = parseUserStoriesFromSpec(specContent);
    if (stories.length === 0) {
      throw new Error("No user stories found in spec.md. Expected '## US-xxx' headings or agent decompose to succeed.");
    }
    return applyKeywordClassification(stories, config);
  }
}

/** Generate acceptance tests for a feature. */
async function generateAcceptanceTestsForFeature(
  specContent: string,
  featureName: string,
  featureDir: string,
  workdir: string,
  config: NaxConfig,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  logger.info("cli", "Generating acceptance tests from spec.md");
  try {
    const scan = await scanCodebase(workdir);
    const codebaseContext = buildCodebaseContext(scan);
    const adapter = getAgent(config.autoMode.defaultAgent);
    if (!adapter) throw new Error(`Agent "${config.autoMode.defaultAgent}" not found`);

    const modelTier = config.analyze.model;
    const modelDef = resolveModel(config.models[modelTier]);
    const result = await generateAcceptanceTests(adapter, {
      specContent,
      featureName,
      workdir,
      codebaseContext,
      modelTier,
      modelDef,
      config,
    });

    const acceptanceTestPath = join(featureDir, config.acceptance.testPath);
    await Bun.write(acceptanceTestPath, result.testCode);
    logger.info("cli", "[OK] Acceptance tests generated", {
      criteriaCount: result.criteria.length,
      testPath: acceptanceTestPath,
    });
  } catch (error) {
    logger.warn("cli", "Failed to generate acceptance tests", { error: (error as Error).message });
  }
}

// ============================================================================
// SD-004: Story decompose CLI entry points
// ============================================================================

/** Default runDecompose implementation — replaced in tests via _decomposeCLIDeps. */
async function runDecomposeDefault(
  story: UserStory,
  prd: PRD,
  config: NaxConfig,
  _featureDir: string,
): Promise<DecomposeResult> {
  const naxDecompose = config.decompose;
  const builderConfig: BuilderDecomposeConfig = {
    maxSubStories: naxDecompose?.maxSubstories ?? 5,
    maxComplexity: naxDecompose?.maxSubstoryComplexity ?? "medium",
    maxRetries: naxDecompose?.maxRetries ?? 2,
  };
  const agent = getAgent(config.autoMode.defaultAgent);
  if (!agent) {
    throw new Error(`[decompose] Agent "${config.autoMode.defaultAgent}" not found — cannot decompose`);
  }
  const adapter = {
    async decompose(prompt: string): Promise<string> {
      return agent.complete(prompt, { jsonMode: true, config });
    },
  };
  return DecomposeBuilder.for(story).prd(prd).config(builderConfig).decompose(adapter);
}

/** Load PRD from featureDir and return both PRD and resolved path. */
async function loadPRDFromDir(featureDir: string): Promise<{ prd: PRD; prdPath: string }> {
  const prdPath = join(featureDir, "prd.json");
  const prd = await loadPRD(prdPath);
  return { prd, prdPath };
}

/** Build a human-readable summary of decomposed substories. */
function buildSummaryLines(subStories: SubStory[]): string[] {
  const lines: string[] = ["Decomposed substories:"];
  for (const sub of subStories) {
    lines.push(`  ${sub.id}  ${sub.title}  [${sub.complexity}]  parent: ${sub.parentStoryId}`);
  }
  return lines;
}

/** Default print implementation — writes lines to stdout. */
function printSummaryDefault(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

/**
 * Swappable dependencies for CLI decompose functions.
 * Tests override individual entries without using mock.module().
 */
export const _decomposeCLIDeps = {
  loadPRD: loadPRDFromDir,
  runDecompose: runDecomposeDefault,
  applyDecomposition,
  savePRD,
  printSummary: printSummaryDefault,
};

/**
 * Decompose a single story by ID via --decompose <storyId>.
 *
 * Loads the PRD, runs decomposition, applies result, and saves the updated PRD.
 * Prints a summary table of the generated substories.
 */
export async function decomposeStory(
  storyId: string,
  options: { featureDir: string; config: NaxConfig },
): Promise<void> {
  const { featureDir, config } = options;
  const logger = getLogger();

  const { prd, prdPath } = await _decomposeCLIDeps.loadPRD(featureDir);

  const story = prd.userStories.find((s) => s.id === storyId);
  if (!story) {
    throw new Error(`Story ${storyId} not found in PRD`);
  }

  const result = await _decomposeCLIDeps.runDecompose(story, prd, config, featureDir);

  if (!result.validation.valid) {
    logger.warn("cli", `Decompose failed for ${storyId}: ${result.validation.errors.join(", ")}`);
    return;
  }

  _decomposeCLIDeps.applyDecomposition(prd, result);
  await _decomposeCLIDeps.savePRD(prd, prdPath);

  const lines = buildSummaryLines(result.subStories);
  _decomposeCLIDeps.printSummary(lines);
}

/**
 * Decompose all oversized stories via --decompose-oversized.
 *
 * Iterates all stories, decomposes any that exceed config.decompose.maxAcceptanceCriteria
 * AND have complex/expert complexity. Saves the PRD once after all decompositions.
 */
export async function decomposeOversized(options: { featureDir: string; config: NaxConfig }): Promise<void> {
  const { featureDir, config } = options;
  const logger = getLogger();

  const { prd, prdPath } = await _decomposeCLIDeps.loadPRD(featureDir);

  const threshold = config.decompose?.maxAcceptanceCriteria ?? 6;
  const oversized = prd.userStories.filter((s) => {
    const complexity = s.routing?.complexity;
    return s.acceptanceCriteria.length > threshold && (complexity === "complex" || complexity === "expert");
  });

  if (oversized.length === 0) {
    logger.info("cli", "No oversized stories found");
    return;
  }

  const allSubStories: SubStory[] = [];
  let anyDecomposed = false;

  for (const story of oversized) {
    const result = await _decomposeCLIDeps.runDecompose(story, prd, config, featureDir);
    if (result.validation.valid) {
      _decomposeCLIDeps.applyDecomposition(prd, result);
      allSubStories.push(...result.subStories);
      anyDecomposed = true;
    } else {
      logger.warn("cli", `Decompose failed for ${story.id}: ${result.validation.errors.join(", ")}`);
    }
  }

  if (anyDecomposed) {
    await _decomposeCLIDeps.savePRD(prd, prdPath);
  }

  if (allSubStories.length > 0) {
    const lines = buildSummaryLines(allSubStories);
    _decomposeCLIDeps.printSummary(lines);
  }
}

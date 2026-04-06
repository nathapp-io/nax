/**
 * Analyze Command -- Parse spec.md into prd.json via agent decompose
 *
 * Uses agent adapter's decompose() method to break spec into classified stories
 * in a single LLM call. Falls back to keyword classification if decompose fails.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateAcceptanceTests } from "../acceptance";
import { resolveAcceptanceFeatureTestPath } from "../acceptance/test-path";
import { createAgentRegistry } from "../agents/registry";
import { scanCodebase } from "../analyze/scanner";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
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
    const adapter = createAgentRegistry(config).getAgent(agentName);
    if (!adapter) throw new Error(`Agent "${agentName}" not found`);

    const modelTier = config.analyze.model;
    const modelDef = resolveModelForAgent(
      config.models,
      config.autoMode.defaultAgent,
      modelTier,
      config.autoMode.defaultAgent,
    );
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
    const adapter = createAgentRegistry(config).getAgent(config.autoMode.defaultAgent);
    if (!adapter) throw new Error(`Agent "${config.autoMode.defaultAgent}" not found`);

    const modelTier = config.analyze.model;
    const modelDef = resolveModelForAgent(
      config.models,
      config.autoMode.defaultAgent,
      modelTier,
      config.autoMode.defaultAgent,
    );
    const result = await generateAcceptanceTests(adapter, {
      specContent,
      featureName,
      workdir,
      codebaseContext,
      modelTier,
      modelDef,
      config,
    });

    const acceptanceTestPath = resolveAcceptanceFeatureTestPath(
      featureDir,
      config.acceptance.testPath,
      config.project?.language,
    );
    await Bun.write(acceptanceTestPath, result.testCode);
    logger.info("cli", "[OK] Acceptance tests generated", {
      criteriaCount: result.criteria.length,
      testPath: acceptanceTestPath,
    });
  } catch (error) {
    logger.warn("cli", "Failed to generate acceptance tests", { error: (error as Error).message });
  }
}

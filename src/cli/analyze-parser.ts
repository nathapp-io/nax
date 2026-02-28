/**
 * Analyze Parser & Classification
 *
 * Extracted from analyze.ts: spec parsing, keyword classification,
 * codebase context building, and reclassification logic.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgent } from "../agents/registry";
import { scanCodebase } from "../analyze/scanner";
import type { CodebaseScan } from "../analyze/types";
import type { NaxConfig } from "../config";
import { resolveModel } from "../config/schema";
import { getLogger } from "../logger";
import type { PRD, UserStory } from "../prd";
import { loadPRD } from "../prd";
import { classifyComplexity, routeTask } from "../routing";

/** Parse user stories from spec.md markdown */
export function parseUserStoriesFromSpec(markdown: string): UserStory[] {
  const stories: UserStory[] = [];
  const lines = markdown.split("\n");

  let currentStory: Partial<UserStory> | null = null;
  let currentSection: "title" | "description" | "criteria" | null = null;
  let descriptionLines: string[] = [];
  let criteriaLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const storyMatch = line.match(/^##\s+(US-\d+|Story)(?::\s*(.+))?/);
    if (storyMatch) {
      if (currentStory) {
        stories.push(finalizeStory(currentStory, descriptionLines, criteriaLines));
      }

      const id = storyMatch[1] === "Story" ? `US-${String(stories.length + 1).padStart(3, "0")}` : storyMatch[1];
      currentStory = {
        id,
        title: storyMatch[2]?.trim() || "[Untitled]",
        description: "",
        acceptanceCriteria: [],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      };
      descriptionLines = [];
      criteriaLines = [];
      currentSection = "title";
      continue;
    }

    if (!currentStory) continue;

    if (line.match(/^###\s+Description/i)) {
      currentSection = "description";
      continue;
    }
    if (line.match(/^###\s+Acceptance\s+Criteria/i)) {
      currentSection = "criteria";
      continue;
    }

    if (currentSection === "description" && line.trim()) {
      descriptionLines.push(line.trim());
    }
    if (currentSection === "criteria" && line.trim()) {
      const criterionMatch = line.match(/^-\s+\[.\]\s+(.+)/);
      if (criterionMatch) criteriaLines.push(criterionMatch[1].trim());
    }

    const tagsMatch = line.match(/^Tags:\s*(.+)/i);
    if (tagsMatch && currentStory) {
      currentStory.tags = tagsMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }

    const depsMatch = line.match(/^Dependencies:\s*(.+)/i);
    if (depsMatch && currentStory) {
      currentStory.dependencies = depsMatch[1]
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
    }
  }

  if (currentStory) {
    stories.push(finalizeStory(currentStory, descriptionLines, criteriaLines));
  }

  return stories;
}

/** Finalize a story by combining collected data */
function finalizeStory(story: Partial<UserStory>, descriptionLines: string[], criteriaLines: string[]): UserStory {
  return {
    id: story.id || "US-000",
    title: story.title || "[Untitled]",
    description: descriptionLines.join(" ").trim() || story.title || "",
    acceptanceCriteria: criteriaLines.length > 0 ? criteriaLines : ["Implementation complete"],
    tags: story.tags || [],
    dependencies: story.dependencies || [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

/** Build codebase context string from scan result. */
export function buildCodebaseContext(scan: CodebaseScan): string {
  return `FILE TREE:
${scan.fileTree}

DEPENDENCIES:
${Object.entries(scan.dependencies)
  .map(([name, version]) => `- ${name}: ${version}`)
  .join("\n")}

DEV DEPENDENCIES:
${Object.entries(scan.devDependencies)
  .map(([name, version]) => `- ${name}: ${version}`)
  .join("\n")}

TEST PATTERNS:
${scan.testPatterns.map((p) => `- ${p}`).join("\n")}`.trim();
}

/** Apply keyword-based classification to user stories. */
export function applyKeywordClassification(stories: UserStory[], config?: NaxConfig): UserStory[] {
  return stories.map((story) => {
    const complexity = classifyComplexity(story.title, story.description, story.acceptanceCriteria, story.tags);
    const routing = config
      ? routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config)
      : { complexity, testStrategy: "test-after" as const, reasoning: "No config provided" };

    return {
      ...story,
      routing: {
        complexity,
        testStrategy: routing.testStrategy,
        reasoning: `Keyword-based classification: ${complexity}`,
        estimatedLOC: estimateLOCFromComplexity(complexity),
        risks: [],
        strategy: "keyword" as const,
      },
    };
  });
}

/** Estimate LOC from complexity level (rough heuristic). */
export function estimateLOCFromComplexity(complexity: "simple" | "medium" | "complex" | "expert"): number {
  switch (complexity) {
    case "simple":
      return 50;
    case "medium":
      return 150;
    case "complex":
      return 400;
    case "expert":
      return 800;
  }
}

/** Re-classify existing prd.json without decomposing. */
export async function reclassifyExistingPRD(
  featureDir: string,
  featureName: string,
  branchName: string,
  workdir: string,
  config?: NaxConfig,
): Promise<PRD> {
  const prdPath = join(featureDir, "prd.json");
  if (!existsSync(prdPath)) {
    throw new Error(`prd.json not found at ${prdPath}. Run analyze without --reclassify first.`);
  }

  const prd = await loadPRD(prdPath);
  const logger = getLogger();
  logger.info("cli", "Re-classifying existing stories");

  const scan = await scanCodebase(workdir);
  const codebaseContext = buildCodebaseContext(scan);
  const updatedStories: UserStory[] = [];

  for (const story of prd.userStories) {
    const storySpec = `## ${story.id}: ${story.title}\n\n${story.description}\n\n### Acceptance Criteria\n${story.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`;

    try {
      if (config?.analyze.llmEnhanced) {
        const classified = await reclassifyWithLLM(story, storySpec, workdir, codebaseContext, config);
        updatedStories.push(classified);
        logger.info("cli", `[OK] ${story.id} reclassified`, {
          storyId: story.id,
          complexity: classified.routing?.complexity,
        });
      } else {
        const classified = reclassifyWithKeywords(story, config);
        updatedStories.push(classified);
        logger.info("cli", `[OK] ${story.id} reclassified`, {
          storyId: story.id,
          complexity: classified.routing?.complexity,
        });
      }
    } catch (error) {
      logger.warn("cli", `[WARN] ${story.id} kept original`, { storyId: story.id, error: (error as Error).message });
      updatedStories.push(story);
    }
  }

  return { ...prd, updatedAt: new Date().toISOString(), userStories: updatedStories };
}

/** Reclassify a single story via LLM agent. */
async function reclassifyWithLLM(
  story: UserStory,
  storySpec: string,
  workdir: string,
  codebaseContext: string,
  config: NaxConfig,
): Promise<UserStory> {
  const agentName = config.autoMode.defaultAgent;
  const adapter = getAgent(agentName);
  if (!adapter) throw new Error(`Agent "${agentName}" not found`);

  const modelTier = config.analyze.model;
  const modelDef = resolveModel(config.models[modelTier]);

  const result = await adapter.decompose({ specContent: storySpec, workdir, codebaseContext, modelTier, modelDef });

  if (result.stories.length === 0) return story;
  const ds = result.stories[0];

  let testStrategy: import("../config").TestStrategy;
  let routingStrategy: "llm" | "keyword";
  if (ds.testStrategy) {
    testStrategy = ds.testStrategy;
    routingStrategy = "llm";
  } else {
    const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);
    testStrategy = routing.testStrategy;
    routingStrategy = "keyword";
  }

  return {
    ...story,
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
}

/** Reclassify a single story via keyword heuristics. */
function reclassifyWithKeywords(story: UserStory, config?: NaxConfig): UserStory {
  const complexity = classifyComplexity(story.title, story.description, story.acceptanceCriteria, story.tags);
  const routing = config
    ? routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config)
    : { complexity, testStrategy: "test-after" as const, reasoning: "No config provided" };

  return {
    ...story,
    routing: {
      complexity,
      testStrategy: routing.testStrategy,
      reasoning: `Keyword-based classification: ${complexity}`,
      estimatedLOC: estimateLOCFromComplexity(complexity),
      risks: [],
    },
  };
}

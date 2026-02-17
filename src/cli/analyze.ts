/**
 * Analyze Command — Parse spec.md into prd.json via agent decompose
 *
 * Uses agent adapter's decompose() method to break spec into classified stories
 * in a single LLM call. Falls back to keyword classification if decompose fails.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PRD, UserStory } from "../prd";
import type { NgentConfig } from "../config";
import type { CodebaseScan } from "../analyze/types";
import { scanCodebase } from "../analyze/scanner";
import { routeTask, classifyComplexity } from "../routing";
import { getAgent } from "../agents/registry";
import { resolveModel } from "../config/schema";
import { loadPRD } from "../prd";
import { generateAcceptanceTests } from "../acceptance";

export interface AnalyzeOptions {
  /** Feature directory path */
  featureDir: string;
  /** Feature name */
  featureName: string;
  /** Branch name */
  branchName: string;
  /** Config (optional) */
  config?: NgentConfig;
  /** Explicit spec path (overrides default spec.md) */
  specPath?: string;
  /** Re-classify existing prd.json without decompose */
  reclassify?: boolean;
}

/** Parse spec.md into PRD via agent decompose */
export async function analyzeFeature(options: AnalyzeOptions): Promise<PRD> {
  const {
    featureDir,
    featureName,
    branchName,
    config,
    specPath: explicitSpecPath,
    reclassify = false,
  } = options;

  const workdir = join(featureDir, "../.."); // Go up from ngent/features/<name> to project root

  // Re-classify mode: re-run classification on existing prd.json
  if (reclassify) {
    return await reclassifyExistingPRD(featureDir, featureName, branchName, workdir, config);
  }

  // Determine spec path
  const specPath = explicitSpecPath || join(featureDir, "spec.md");

  if (!existsSync(specPath)) {
    throw new Error(`spec.md not found at ${specPath}`);
  }

  // Read spec content
  const specContent = await Bun.file(specPath).text();

  let userStories: UserStory[];

  // LLM-enhanced decompose+classify (if enabled)
  if (config && config.analyze.llmEnhanced) {
    console.log("Running agent decompose (decompose + classify in single LLM call)...");

    try {
      // Scan codebase
      const scan = await scanCodebase(workdir);

      // Build codebase context string
      const codebaseContext = buildCodebaseContext(scan);

      // Get agent adapter
      const agentName = config.autoMode.defaultAgent;
      const adapter = getAgent(agentName);

      if (!adapter) {
        throw new Error(`Agent "${agentName}" not found`);
      }

      // Resolve model for analyze
      const modelTier = config.analyze.model;
      const modelEntry = config.models[modelTier];
      const modelDef = resolveModel(modelEntry);

      // Run decompose
      const result = await adapter.decompose({
        specContent,
        workdir,
        codebaseContext,
        modelTier,
        modelDef,
      });

      console.log(`✓ Agent decompose complete — ${result.stories.length} stories`);

      // Convert decomposed stories to UserStory format with routing
      userStories = result.stories.map((ds) => {
        // Route task to get test strategy (modelTier derived at runtime)
        const routing = routeTask(
          ds.title,
          ds.description,
          ds.acceptanceCriteria,
          ds.tags,
          config,
        );

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
            complexity: ds.complexity, // Use decompose complexity
            testStrategy: routing.testStrategy,
            reasoning: ds.reasoning,
            estimatedLOC: ds.estimatedLOC,
            risks: ds.risks,
          },
          relevantFiles: ds.relevantFiles,
        };
      });
    } catch (error) {
      // Fall back to keyword-based classification
      console.warn(`⚠ Agent decompose failed: ${(error as Error).message}`);
      console.warn("Falling back to manual story extraction + keyword classification");

      userStories = parseUserStoriesFromSpec(specContent);

      if (userStories.length === 0) {
        throw new Error("No user stories found in spec.md. Expected '## US-xxx' headings or agent decompose to succeed.");
      }

      // Apply keyword-based classification
      userStories = applyKeywordClassification(userStories, config);
    }
  } else {
    // Manual parsing + keyword classification
    console.log("LLM-enhanced analysis disabled, using manual parsing + keyword classification");

    userStories = parseUserStoriesFromSpec(specContent);

    if (userStories.length === 0) {
      throw new Error("No user stories found in spec.md. Expected '## US-xxx' headings.");
    }

    userStories = applyKeywordClassification(userStories, config);
  }

  // Check story count limit (MEM-1: prevent memory exhaustion)
  if (config && userStories.length > config.execution.maxStoriesPerFeature) {
    throw new Error(
      `Feature has ${userStories.length} stories, exceeding limit of ${config.execution.maxStoriesPerFeature}.\n` +
      `  Split this feature into smaller features or increase maxStoriesPerFeature in config.`
    );
  }

  // Build PRD
  const now = new Date().toISOString();
  const prd: PRD = {
    project: "ngent", // could be inferred from package.json
    feature: featureName,
    branchName,
    createdAt: now,
    updatedAt: now,
    userStories,
  };

  // Generate acceptance tests if enabled
  if (config && config.acceptance.enabled && config.acceptance.generateTests) {
    console.log("Generating acceptance tests from spec.md...");

    try {
      // Scan codebase (reuse existing scan if available)
      const scan = await scanCodebase(workdir);
      const codebaseContext = buildCodebaseContext(scan);

      // Get agent adapter
      const agentName = config.autoMode.defaultAgent;
      const adapter = getAgent(agentName);

      if (!adapter) {
        throw new Error(`Agent "${agentName}" not found`);
      }

      // Resolve model for acceptance test generation (use analyze tier)
      const modelTier = config.analyze.model;
      const modelEntry = config.models[modelTier];
      const modelDef = resolveModel(modelEntry);

      // Generate acceptance tests
      const result = await generateAcceptanceTests(adapter, {
        specContent,
        featureName,
        workdir,
        codebaseContext,
        modelTier,
        modelDef,
      });

      // Write acceptance.test.ts to feature directory
      const acceptanceTestPath = join(featureDir, config.acceptance.testPath);
      await Bun.write(acceptanceTestPath, result.testCode);

      console.log(`✓ Acceptance tests generated — ${result.criteria.length} criteria → ${acceptanceTestPath}`);
    } catch (error) {
      console.warn(`⚠ Failed to generate acceptance tests: ${(error as Error).message}`);
      // Continue with PRD creation even if test generation fails
    }
  }

  return prd;
}

/** Parse user stories from tasks.md */
function parseUserStories(markdown: string): UserStory[] {
  const stories: UserStory[] = [];
  const lines = markdown.split("\n");

  let currentStory: Partial<UserStory> | null = null;
  let currentSection: "title" | "description" | "criteria" | null = null;
  let descriptionLines: string[] = [];
  let criteriaLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Story heading: ## US-001: Title or ## Story: Title
    const storyMatch = line.match(/^##\s+(US-\d+|Story)(?::\s*(.+))?/);
    if (storyMatch) {
      // Save previous story
      if (currentStory) {
        stories.push(finalizeStory(currentStory, descriptionLines, criteriaLines));
      }

      // Start new story
      const id = storyMatch[1] === "Story" ? `US-${String(stories.length + 1).padStart(3, "0")}` : storyMatch[1];
      const title = storyMatch[2]?.trim() || "[Untitled]";

      currentStory = {
        id,
        title,
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

    // Section headers
    if (line.match(/^###\s+Description/i)) {
      currentSection = "description";
      continue;
    }

    if (line.match(/^###\s+Acceptance\s+Criteria/i)) {
      currentSection = "criteria";
      continue;
    }

    // Parse content based on current section
    if (currentSection === "description" && line.trim()) {
      descriptionLines.push(line.trim());
    }

    if (currentSection === "criteria" && line.trim()) {
      // Checklist item: - [ ] Criterion
      const criterionMatch = line.match(/^-\s+\[.\]\s+(.+)/);
      if (criterionMatch) {
        criteriaLines.push(criterionMatch[1].trim());
      }
    }

    // Parse metadata lines
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

  // Save last story
  if (currentStory) {
    stories.push(finalizeStory(currentStory, descriptionLines, criteriaLines));
  }

  return stories;
}

/** Finalize a story by combining collected data */
function finalizeStory(
  story: Partial<UserStory>,
  descriptionLines: string[],
  criteriaLines: string[],
): UserStory {
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

/** Parse user stories from spec.md (same format as tasks.md) */
function parseUserStoriesFromSpec(markdown: string): UserStory[] {
  return parseUserStories(markdown);
}

/**
 * Build codebase context string from scan result.
 */
function buildCodebaseContext(scan: CodebaseScan): string {
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

/**
 * Apply keyword-based classification to user stories.
 */
function applyKeywordClassification(stories: UserStory[], config?: NgentConfig): UserStory[] {
  return stories.map((story) => {
    const complexity = classifyComplexity(
      story.title,
      story.description,
      story.acceptanceCriteria,
      story.tags
    );

    const routing = config
      ? routeTask(
          story.title,
          story.description,
          story.acceptanceCriteria,
          story.tags,
          config
        )
      : {
          complexity,
          testStrategy: "test-after" as const,
          reasoning: "No config provided",
        };

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
  });
}

/**
 * Re-classify existing prd.json without decomposing.
 */
async function reclassifyExistingPRD(
  featureDir: string,
  featureName: string,
  branchName: string,
  workdir: string,
  config?: NgentConfig,
): Promise<PRD> {
  const prdPath = join(featureDir, "prd.json");

  if (!existsSync(prdPath)) {
    throw new Error(`prd.json not found at ${prdPath}. Run analyze without --reclassify first.`);
  }

  // Load existing PRD
  const prd = await loadPRD(prdPath);

  console.log("Re-classifying existing stories...");

  // Scan codebase
  const scan = await scanCodebase(workdir);
  const codebaseContext = buildCodebaseContext(scan);

  // Re-classify each story
  const updatedStories: UserStory[] = [];

  for (const story of prd.userStories) {
    // Build a mini-spec for this story
    const storySpec = `## ${story.id}: ${story.title}

${story.description}

### Acceptance Criteria
${story.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`;

    try {
      if (config && config.analyze.llmEnhanced) {
        // Use agent to classify this single story
        const agentName = config.autoMode.defaultAgent;
        const adapter = getAgent(agentName);

        if (!adapter) {
          throw new Error(`Agent "${agentName}" not found`);
        }

        const modelTier = config.analyze.model;
        const modelEntry = config.models[modelTier];
        const modelDef = resolveModel(modelEntry);

        const result = await adapter.decompose({
          specContent: storySpec,
          workdir,
          codebaseContext,
          modelTier,
          modelDef,
        });

        if (result.stories.length > 0) {
          const ds = result.stories[0];

          const routing = routeTask(
            story.title,
            story.description,
            story.acceptanceCriteria,
            story.tags,
            config,
          );

          updatedStories.push({
            ...story,
            routing: {
              complexity: ds.complexity,
              testStrategy: routing.testStrategy,
              reasoning: ds.reasoning,
              estimatedLOC: ds.estimatedLOC,
              risks: ds.risks,
            },
            relevantFiles: ds.relevantFiles,
          });

          console.log(`  ✓ ${story.id} → ${ds.complexity}`);
        } else {
          // Keep original if decompose failed
          updatedStories.push(story);
          console.warn(`  ⚠ ${story.id} → kept original`);
        }
      } else {
        // Keyword classification
        const complexity = classifyComplexity(
          story.title,
          story.description,
          story.acceptanceCriteria,
          story.tags
        );

        const routing = config
          ? routeTask(
              story.title,
              story.description,
              story.acceptanceCriteria,
              story.tags,
              config
            )
          : {
              complexity,
              testStrategy: "test-after" as const,
              reasoning: "No config provided",
            };

        updatedStories.push({
          ...story,
          routing: {
            complexity,
            testStrategy: routing.testStrategy,
            reasoning: `Keyword-based classification: ${complexity}`,
            estimatedLOC: estimateLOCFromComplexity(complexity),
            risks: [],
          },
        });

        console.log(`  ✓ ${story.id} → ${complexity}`);
      }
    } catch (error) {
      console.warn(`  ⚠ ${story.id} → error: ${(error as Error).message}`);
      updatedStories.push(story); // Keep original on error
    }
  }

  // Return updated PRD
  return {
    ...prd,
    updatedAt: new Date().toISOString(),
    userStories: updatedStories,
  };
}

/**
 * Estimate LOC from complexity level (rough heuristic).
 */
function estimateLOCFromComplexity(complexity: "simple" | "medium" | "complex" | "expert"): number {
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

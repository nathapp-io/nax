/**
 * Analyze Command — Parse spec.md + tasks.md into prd.json
 *
 * Converts markdown user stories into structured PRD format.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PRD, UserStory } from "../prd";
import type { NgentConfig } from "../config";

/** Parse spec.md and tasks.md into PRD */
export async function analyzeFeature(
  featureDir: string,
  featureName: string,
  branchName: string,
  config?: NgentConfig,
): Promise<PRD> {
  const specPath = join(featureDir, "spec.md");
  const tasksPath = join(featureDir, "tasks.md");

  if (!existsSync(tasksPath)) {
    throw new Error(`tasks.md not found in ${featureDir}`);
  }

  // Read tasks.md (required)
  const tasksContent = await Bun.file(tasksPath).text();
  const userStories = parseUserStories(tasksContent);

  if (userStories.length === 0) {
    throw new Error("No user stories found in tasks.md. Expected '## US-xxx' or '## Story' headings.");
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

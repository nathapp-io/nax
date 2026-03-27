/**
 * DecomposeBuilder — fluent API for composing story decomposition prompts.
 *
 * Usage:
 *   const result = await DecomposeBuilder.for(story)
 *     .prd(prd)
 *     .codebase(scan)
 *     .config(cfg)
 *     .decompose(adapter);
 */

import type { CodebaseScan } from "../analyze/types";
import type { PRD, UserStory } from "../prd";
import { buildCodebaseSection } from "./sections/codebase";
import { buildConstraintsSection } from "./sections/constraints";
import { buildSiblingStoriesSection } from "./sections/sibling-stories";
import { buildTargetStorySection } from "./sections/target-story";
import type { DecomposeAdapter, DecomposeAgentConfig, DecomposeResult, SubStory } from "./types";
import { runAllValidators } from "./validators/index";

export const SECTION_SEP = "\n\n---\n\n";

export class DecomposeBuilder {
  private _story: UserStory;
  private _prd: PRD | undefined;
  private _scan: CodebaseScan | undefined;
  private _cfg: DecomposeAgentConfig | undefined;

  private constructor(story: UserStory) {
    this._story = story;
  }

  static for(story: UserStory): DecomposeBuilder {
    return new DecomposeBuilder(story);
  }

  prd(prd: PRD): this {
    this._prd = prd;
    return this;
  }

  codebase(scan: CodebaseScan): this {
    this._scan = scan;
    return this;
  }

  config(cfg: DecomposeAgentConfig): this {
    this._cfg = cfg;
    return this;
  }

  buildPrompt(errorFeedback?: string): string {
    const sections: string[] = [];

    sections.push(buildTargetStorySection(this._story));

    if (this._prd) {
      sections.push(buildSiblingStoriesSection(this._story, this._prd));
    }

    if (this._scan) {
      sections.push(buildCodebaseSection(this._scan));
    }

    if (this._cfg) {
      sections.push(buildConstraintsSection(this._cfg));
    }

    if (errorFeedback) {
      sections.push(
        `## Validation Errors from Previous Attempt\n\nFix the following errors and try again:\n\n${errorFeedback}`,
      );
    }

    return sections.join(SECTION_SEP);
  }

  async decompose(adapter: DecomposeAdapter): Promise<DecomposeResult> {
    const cfg = this._cfg;
    const maxRetries = cfg?.maxRetries ?? 0;
    const existingStories = this._prd ? this._prd.userStories.filter((s) => s.id !== this._story.id) : [];

    let lastResult: DecomposeResult | undefined;
    let errorFeedback: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const prompt = this.buildPrompt(errorFeedback);
      const raw = await adapter.decompose(prompt);
      const parsed = parseSubStories(raw);

      if (!parsed.validation.valid) {
        lastResult = parsed;
        errorFeedback = parsed.validation.errors.join("\n");
        continue;
      }

      // Run post-parse validators
      const config: DecomposeAgentConfig = cfg ?? { maxSubStories: 5, maxComplexity: "medium" };
      const validation = runAllValidators(this._story, parsed.subStories, existingStories, config);

      if (!validation.valid) {
        lastResult = { subStories: parsed.subStories, validation };
        errorFeedback = validation.errors.join("\n");
        continue;
      }

      return { subStories: parsed.subStories, validation };
    }

    return (
      lastResult ?? {
        subStories: [],
        validation: { valid: false, errors: ["Decomposition failed after all retries"], warnings: [] },
      }
    );
  }
}

function parseSubStories(output: string): DecomposeResult {
  // Extract JSON array (handles optional markdown code fences)
  const fenceMatch = output.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  let jsonText = fenceMatch ? fenceMatch[1] : output;

  if (!fenceMatch) {
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonText = arrayMatch[0];
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch (err) {
    return {
      subStories: [],
      validation: { valid: false, errors: [`Failed to parse JSON: ${(err as Error).message}`], warnings: [] },
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      subStories: [],
      validation: { valid: false, errors: ["Output is not a JSON array"], warnings: [] },
    };
  }

  const errors: string[] = [];
  const subStories: SubStory[] = [];

  for (const [index, item] of parsed.entries()) {
    if (typeof item !== "object" || item === null) {
      errors.push(`Item at index ${index} is not an object`);
      continue;
    }
    const r = item as Record<string, unknown>;
    subStories.push({
      id: String(r.id ?? ""),
      parentStoryId: String(r.parentStoryId ?? ""),
      title: String(r.title ?? ""),
      description: String(r.description ?? ""),
      acceptanceCriteria: Array.isArray(r.acceptanceCriteria) ? (r.acceptanceCriteria as string[]) : [],
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      dependencies: Array.isArray(r.dependencies) ? (r.dependencies as string[]) : [],
      complexity: normalizeComplexity(r.complexity),
      nonOverlapJustification: String(r.nonOverlapJustification ?? ""),
    });
  }

  return {
    subStories,
    validation: { valid: errors.length === 0, errors, warnings: [] },
  };
}

function normalizeComplexity(value: unknown): "simple" | "medium" | "complex" | "expert" {
  if (value === "simple" || value === "medium" || value === "complex" || value === "expert") {
    return value;
  }
  return "medium";
}

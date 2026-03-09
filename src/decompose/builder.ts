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
import type { DecomposeAdapter, DecomposeConfig, DecomposeResult, SubStory } from "./types";

export const SECTION_SEP = "\n\n---\n\n";

export class DecomposeBuilder {
  private _story: UserStory;
  private _prd: PRD | undefined;
  private _scan: CodebaseScan | undefined;
  private _cfg: DecomposeConfig | undefined;

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

  config(cfg: DecomposeConfig): this {
    this._cfg = cfg;
    return this;
  }

  buildPrompt(): string {
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

    return sections.join(SECTION_SEP);
  }

  async decompose(adapter: DecomposeAdapter): Promise<DecomposeResult> {
    const prompt = this.buildPrompt();
    const raw = await adapter.decompose(prompt);
    return parseSubStories(raw);
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
      complexity: validateComplexity(r.complexity),
      nonOverlapJustification: String(r.nonOverlapJustification ?? ""),
    });
  }

  return {
    subStories,
    validation: { valid: errors.length === 0, errors, warnings: [] },
  };
}

function validateComplexity(value: unknown): "simple" | "medium" | "complex" | "expert" {
  if (value === "simple" || value === "medium" || value === "complex" || value === "expert") {
    return value;
  }
  return "medium";
}

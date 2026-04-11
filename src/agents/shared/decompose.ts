/**
 * Decompose Output Parser & Utilities
 *
 * Parses and validates the JSON array returned by the decompose LLM call.
 * Prompt construction has moved to src/agents/shared/decompose-prompt.ts.
 */

import { resolveTestStrategy } from "../../config/test-strategy";
import type { DecomposedStory } from "../types";

/**
 * Parse decompose output from agent stdout.
 *
 * Extracts JSON array from output, handles markdown code fences,
 * and validates structure.
 */
export function parseDecomposeOutput(output: string): DecomposedStory[] {
  // Extract JSON from output (handles markdown code fences)
  const jsonMatch = output.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  let jsonText = jsonMatch ? jsonMatch[1] : output;

  // Try to find JSON array directly if no code fence
  if (!jsonMatch) {
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonText = arrayMatch[0];
    }
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch (error) {
    throw new Error(
      `Failed to parse decompose output as JSON: ${(error as Error).message}\n\nOutput:\n${output.slice(0, 500)}`,
    );
  }

  // Validate structure
  if (!Array.isArray(parsed)) {
    throw new Error("Decompose output is not an array");
  }

  // Map to DecomposedStory[] with validation
  const stories: DecomposedStory[] = parsed.map((item: unknown, index: number) => {
    // Type guard: ensure item is an object
    if (typeof item !== "object" || item === null) {
      throw new Error(`Story at index ${index} is not an object`);
    }
    const record = item as Record<string, unknown>;
    if (!record.id || typeof record.id !== "string") {
      throw new Error(`Story at index ${index} missing valid 'id' field`);
    }
    if (!record.title || typeof record.title !== "string") {
      throw new Error(`Story ${record.id} missing valid 'title' field`);
    }

    return {
      id: record.id,
      title: record.title,
      description: String(record.description || record.title),
      acceptanceCriteria: Array.isArray(record.acceptanceCriteria)
        ? record.acceptanceCriteria
        : ["Implementation complete"],
      tags: Array.isArray(record.tags) ? record.tags : [],
      dependencies: Array.isArray(record.dependencies) ? record.dependencies : [],
      complexity: coerceComplexity(record.complexity),
      // contextFiles: prefer the new field; fall back to legacy relevantFiles from older LLM responses
      contextFiles: Array.isArray(record.contextFiles)
        ? record.contextFiles
        : Array.isArray(record.relevantFiles)
          ? record.relevantFiles
          : [],
      relevantFiles: Array.isArray(record.relevantFiles) ? record.relevantFiles : [],
      reasoning: String(record.reasoning || "No reasoning provided"),
      estimatedLOC: Number(record.estimatedLOC) || 0,
      risks: Array.isArray(record.risks) ? record.risks : [],
      testStrategy: resolveTestStrategy(typeof record.testStrategy === "string" ? record.testStrategy : undefined),
    };
  });

  if (stories.length === 0) {
    throw new Error("Decompose returned empty story array");
  }

  return stories;
}

/**
 * Coerce complexity value from decompose output.
 */
export function coerceComplexity(value: unknown): "simple" | "medium" | "complex" | "expert" {
  if (value === "simple" || value === "medium" || value === "complex" || value === "expert") {
    return value;
  }
  // Default to medium if invalid
  return "medium";
}

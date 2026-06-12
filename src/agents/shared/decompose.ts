/**
 * Claude Code Decompose Logic
 *
 * Extracted from claude.ts: decompose(), buildDecomposePrompt(),
 * parseDecomposeOutput(), validateComplexity()
 */

import { resolveTestStrategy } from "@/config";
import { NaxError } from "@/errors";
import { parseLLMJson } from "@/utils/llm-json";
import type { DecomposedStory } from "../types";

/**
 * Parse decompose output from agent stdout.
 *
 * Extracts JSON array from output via parseLLMJson (handles markdown fences,
 * preamble, trailing commas) and validates structure.
 */
export function parseDecomposeOutput(output: string): DecomposedStory[] {
  let parsed: unknown;
  try {
    parsed = parseLLMJson<unknown>(output);
  } catch (error) {
    throw new NaxError("Failed to parse decompose output as JSON", "DECOMPOSE_PARSE_FAILED", {
      stage: "decompose",
      outputSnippet: output.slice(0, 500),
      cause: error,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new NaxError("Decompose output is not an array", "DECOMPOSE_PARSE_FAILED", {
      stage: "decompose",
    });
  }

  const stories: DecomposedStory[] = parsed.map((item: unknown, index: number) => {
    if (typeof item !== "object" || item === null) {
      throw new NaxError(`Story at index ${index} is not an object`, "DECOMPOSE_PARSE_FAILED", {
        stage: "decompose",
        index,
      });
    }
    const record = item as Record<string, unknown>;
    if (!record.id || typeof record.id !== "string") {
      throw new NaxError(`Story at index ${index} missing valid 'id' field`, "DECOMPOSE_PARSE_FAILED", {
        stage: "decompose",
        index,
      });
    }
    if (!record.title || typeof record.title !== "string") {
      throw new NaxError(`Story ${record.id} missing valid 'title' field`, "DECOMPOSE_PARSE_FAILED", {
        stage: "decompose",
        storyId: record.id,
      });
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
      agentProfileId:
        typeof record.agentProfileId === "string" && record.agentProfileId.length > 0
          ? record.agentProfileId
          : undefined,
    };
  });

  if (stories.length === 0) {
    throw new NaxError("Decompose returned empty story array", "DECOMPOSE_PARSE_FAILED", {
      stage: "decompose",
    });
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

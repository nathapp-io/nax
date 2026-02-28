/**
 * Claude Code Decompose Logic
 *
 * Extracted from claude.ts: decompose(), buildDecomposePrompt(),
 * parseDecomposeOutput(), validateComplexity()
 */

import type { DecomposeOptions, DecomposeResult, DecomposedStory } from "./types";

/**
 * Build the decompose prompt combining spec content and codebase context.
 */
export function buildDecomposePrompt(options: DecomposeOptions): string {
  return `You are a requirements analyst. Break down the following feature specification into user stories and classify each story's complexity.

CODEBASE CONTEXT:
${options.codebaseContext}

FEATURE SPECIFICATION:
${options.specContent}

Decompose this spec into user stories. For each story, provide:
1. id: Story ID (e.g., "US-001")
2. title: Concise story title
3. description: What needs to be implemented
4. acceptanceCriteria: Array of testable criteria
5. tags: Array of routing tags (e.g., ["security", "api"])
6. dependencies: Array of story IDs this depends on (e.g., ["US-001"])
7. complexity: "simple" | "medium" | "complex" | "expert"
8. contextFiles: Array of file paths to inject into agent prompt before execution
9. reasoning: Why this complexity level
10. estimatedLOC: Estimated lines of code to change
11. risks: Array of implementation risks
12. testStrategy: "three-session-tdd" | "test-after"

testStrategy rules:
- "three-session-tdd": ONLY for complex/expert tasks that are security-critical (auth, encryption, tokens, credentials) or define public API contracts consumers depend on
- "test-after": for all other tasks including simple/medium complexity
- A "simple" complexity task should almost never be "three-session-tdd"

Complexity classification rules:
- simple: 1-3 files, <100 LOC, straightforward implementation, existing patterns
- medium: 3-6 files, 100-300 LOC, moderate logic, some new patterns
- complex: 6+ files, 300-800 LOC, architectural changes, cross-cutting concerns
- expert: Security/crypto/real-time/distributed systems, >800 LOC, new infrastructure

Grouping Guidelines:
- Combine small, related tasks (e.g., multiple utility functions, interfaces) into a single "simple" or "medium" story.
- Do NOT create separate stories for every single file or function unless complex.
- Aim for coherent units of value (e.g., "Implement User Authentication" vs "Create User Interface", "Create Login Service").
- Maximum recommended stories: 10-15 per feature. Group aggressively if list grows too long.

Consider:
1. Does infrastructure exist? (e.g., "add caching" when no cache layer exists = complex)
2. How many files will be touched?
3. Are there cross-cutting concerns (auth, validation, error handling)?
4. Does it require new dependencies or architectural decisions?

Respond with ONLY a JSON array (no markdown code fences):
[{
  "id": "US-001",
  "title": "Story title",
  "description": "Story description",
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
  "tags": ["tag1"],
  "dependencies": [],
  "complexity": "medium",
  "contextFiles": ["src/path/to/file.ts"],
  "reasoning": "Why this complexity level",
  "estimatedLOC": 150,
  "risks": ["Risk 1"],
  "testStrategy": "test-after"
}]`;
}

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
      complexity: validateComplexity(record.complexity),
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
      testStrategy:
        record.testStrategy === "three-session-tdd"
          ? "three-session-tdd"
          : record.testStrategy === "test-after"
            ? "test-after"
            : undefined,
    };
  });

  if (stories.length === 0) {
    throw new Error("Decompose returned empty story array");
  }

  return stories;
}

/**
 * Validate complexity value from decompose output.
 */
export function validateComplexity(value: unknown): "simple" | "medium" | "complex" | "expert" {
  if (value === "simple" || value === "medium" || value === "complex" || value === "expert") {
    return value;
  }
  // Default to medium if invalid
  return "medium";
}

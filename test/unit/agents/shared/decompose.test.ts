/**
 * Unit tests for src/agents/shared/decompose.ts
 *
 * Verifies:
 * - parseDecomposeOutput handles code-fenced JSON responses (AC-6)
 */

import { describe, expect, test } from "bun:test";
import { parseDecomposeOutput } from "../../../../src/agents/shared/decompose";

// ─────────────────────────────────────────────────────────────────────────────
// Tests: AC-6 — parseDecomposeOutput handles code-fenced JSON
// These tests PASS already (parseDecomposeOutput already supports code fences).
// They are included to document and protect this behavior as part of the
// plan decompose flow.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDecomposeOutput — code-fenced JSON handling (US-002 AC-6)", () => {
  const VALID_STORY_JSON = JSON.stringify([
    {
      id: "US-001",
      title: "Setup Redis connection",
      description: "Configure Redis client",
      acceptanceCriteria: ["AC-1: Connects to Redis"],
      tags: ["infrastructure"],
      dependencies: [],
      complexity: "medium",
      contextFiles: ["src/redis.ts"],
      reasoning: "Infrastructure setup",
      estimatedLOC: 60,
      risks: [],
      testStrategy: "test-after",
    },
  ]);

  test("parses bare JSON array (no code fences)", () => {
    const result = parseDecomposeOutput(VALID_STORY_JSON);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
  });

  test("parses JSON wrapped in ```json code fence", () => {
    const fenced = `\`\`\`json\n${VALID_STORY_JSON}\n\`\`\``;
    const result = parseDecomposeOutput(fenced);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
    expect(result[0].title).toBe("Setup Redis connection");
  });

  test("parses JSON wrapped in ``` code fence (no language tag)", () => {
    const fenced = `\`\`\`\n${VALID_STORY_JSON}\n\`\`\``;
    const result = parseDecomposeOutput(fenced);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
  });

  test("parses code-fenced JSON with surrounding explanation text", () => {
    const output = `Here are the decomposed stories:\n\n\`\`\`json\n${VALID_STORY_JSON}\n\`\`\`\n\nLet me know if you need adjustments.`;
    const result = parseDecomposeOutput(output);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("US-001");
  });

  test("throws when code-fenced content is not valid JSON", () => {
    const invalid = "```json\n[{bad json\n```";
    expect(() => parseDecomposeOutput(invalid)).toThrow();
  });

  test("coerces missing fields to defaults (contextFiles defaults to [])", () => {
    const minimalJson = JSON.stringify([{ id: "US-001", title: "Minimal story" }]);
    const fenced = `\`\`\`json\n${minimalJson}\n\`\`\``;
    const result = parseDecomposeOutput(fenced);
    expect(result[0].contextFiles).toEqual([]);
  });

  test("throws when code-fenced JSON is empty array", () => {
    const fenced = "```json\n[]\n```";
    expect(() => parseDecomposeOutput(fenced)).toThrow("empty story array");
  });
});

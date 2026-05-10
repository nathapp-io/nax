/**
 * Unit tests for src/utils/llm-json.ts
 *
 * Tests cover:
 * - extractJsonFromMarkdown: fence stripping with/without preamble
 * - stripTrailingCommas: trailing comma removal
 * - extractJsonObject: bare JSON extraction from narration
 */

import { describe, expect, test } from "bun:test";
import {
  extractJsonFromMarkdown,
  extractJsonObject,
  parseLLMJson,
  stripTrailingCommas,
  wrapJsonPrompt,
} from "../../../src/utils/llm-json";

// ---------------------------------------------------------------------------
// extractJsonFromMarkdown
// ---------------------------------------------------------------------------

describe("extractJsonFromMarkdown", () => {
  test("returns input unchanged when no fence present", () => {
    const input = '{"passed":true,"findings":[]}';
    expect(extractJsonFromMarkdown(input)).toBe(input);
  });

  test("extracts JSON from ```json fence", () => {
    const json = '{"passed":true,"findings":[]}';
    const input = "```json\n" + json + "\n```";
    expect(extractJsonFromMarkdown(input)).toBe(json);
  });

  test("extracts JSON from plain ``` fence", () => {
    const json = '{"passed":true,"findings":[]}';
    const input = "```\n" + json + "\n```";
    expect(extractJsonFromMarkdown(input)).toBe(json);
  });

  test("handles preamble text before fence (failure mode 2)", () => {
    const json = '{"passed":true,"findings":[]}';
    const input = "I'll verify each AC by reading the implementation files.\n```json\n" + json + "\n```";
    expect(extractJsonFromMarkdown(input)).toBe(json);
  });

  test("handles trailing text after closing fence", () => {
    const json = '{"passed":true,"findings":[]}';
    const input = "```json\n" + json + "\n```\nAll ACs are met.";
    expect(extractJsonFromMarkdown(input)).toBe(json);
  });

  test("handles both preamble and trailing text", () => {
    const json = '{"passed":false,"findings":[]}';
    const input = "Let me check.\n```json\n" + json + "\n```\nThat's my analysis.";
    expect(extractJsonFromMarkdown(input)).toBe(json);
  });

  test("returns input unchanged when fence is unclosed", () => {
    const input = "```json\n{";
    // No closing fence — returns input unchanged
    expect(extractJsonFromMarkdown(input)).toBe(input);
  });

  test("handles multiline JSON in fence", () => {
    const json = '{\n  "passed": true,\n  "findings": []\n}';
    const input = "```json\n" + json + "\n```";
    expect(extractJsonFromMarkdown(input)).toBe(json);
  });
});

// ---------------------------------------------------------------------------
// stripTrailingCommas
// ---------------------------------------------------------------------------

describe("stripTrailingCommas", () => {
  test("removes trailing comma before }", () => {
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}');
  });

  test("removes trailing comma before ]", () => {
    expect(stripTrailingCommas("[1,2,3,]")).toBe("[1,2,3]");
  });

  test("removes trailing comma with whitespace", () => {
    expect(stripTrailingCommas('{"a":1,  }')).toBe('{"a":1}');
  });

  test("handles nested trailing commas", () => {
    expect(stripTrailingCommas('{"a":[1,2,],"b":3,}')).toBe('{"a":[1,2],"b":3}');
  });

  test("leaves valid JSON unchanged", () => {
    const json = '{"passed":true,"findings":[]}';
    expect(stripTrailingCommas(json)).toBe(json);
  });
});

// ---------------------------------------------------------------------------
// extractJsonObject
// ---------------------------------------------------------------------------

describe("extractJsonObject", () => {
  test("returns null when no JSON container found", () => {
    expect(extractJsonObject("just plain text, no JSON here")).toBeNull();
  });

  test("extracts object from pure JSON string", () => {
    const json = '{"passed":true,"findings":[]}';
    expect(extractJsonObject(json)).toBe(json);
  });

  test("extracts object from narration with preamble", () => {
    const json = '{"passed":true,"findings":[]}';
    const input = "After analysis: " + json + " All ACs met.";
    expect(extractJsonObject(input)).toBe(json);
  });

  test("extracts JSON array from text", () => {
    const json = '[{"id":"1"},{"id":"2"}]';
    const input = "Here are the results: " + json;
    expect(extractJsonObject(input)).toBe(json);
  });

  test("prefers object when { appears before [", () => {
    const input = '{"key":[1,2,3]}';
    expect(extractJsonObject(input)).toBe('{"key":[1,2,3]}');
  });

  test("prefers array when [ appears before {", () => {
    const input = '[{"key":"val"}]';
    expect(extractJsonObject(input)).toBe('[{"key":"val"}]');
  });

  test("returns null when only open brace with no close", () => {
    expect(extractJsonObject("{ no closing brace")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractJsonObject("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseLLMJson — regression tests for multi-fence and bracket-in-text bugs
// ---------------------------------------------------------------------------

describe("parseLLMJson", () => {
  type Obj = Record<string, unknown>;

  test("parses clean JSON directly", () => {
    const input = '{"verdict":"test_bug","confidence":1}';
    expect(parseLLMJson<Obj>(input)).toEqual({ verdict: "test_bug", confidence: 1 });
  });

  test("extracts JSON from ```json fence with preamble reasoning", () => {
    const json = '{"verdict":"test_bug","confidence":1}';
    const input = `Some reasoning here.\n\`\`\`json\n${json}\n\`\`\``;
    expect(parseLLMJson<Obj>(input)).toEqual({ verdict: "test_bug", confidence: 1 });
  });

  // Regression: plain ``` fence (e.g. bun test output) appears before ```json fence.
  // Bug: tier 2 used to match the plain fence and extract non-JSON content.
  test("prefers ```json fence over earlier plain ``` fence", () => {
    const json = '{"verdict":"test_bug","confidence":1}';
    const input = [
      "Analysis:\n",
      "```\nbun test v1.3.13\n  5 pass\n  0 fail\nRan 5 tests [7.00ms]\n```\n",
      "The assertion is wrong.\n",
      "```json\n",
      json,
      "\n```",
    ].join("");
    expect(parseLLMJson<Obj>(input)).toEqual({ verdict: "test_bug", confidence: 1 });
  });

  // Regression: bun test output contains "[7.00ms]" before the JSON object.
  // Bug: tier 3 used to pick "[" from "[7.00ms]" as the JSON array start,
  // extracting garbage from there to the last "]" in the findings array.
  test("extracts JSON object when [ appears before { in narration text", () => {
    const json = '{"verdict":"test_bug","findings":[{"id":1}]}';
    const input = `Ran 5 tests [7.00ms]\n\nResult: ${json}`;
    expect(parseLLMJson<Obj>(input)).toEqual({ verdict: "test_bug", findings: [{ id: 1 }] });
  });

  // Combined regression: both problems at once — same shape as the real failing response.
  test("handles plain-fence-before-json-fence AND [time] before JSON object", () => {
    const json = '{"verdict":"test_bug","confidence":1,"findings":[{"fixTarget":"test"}]}';
    const input = [
      "Looking at the failing test.\n",
      "```\nbun test v1.3.13\n 5 pass\n 0 fail\nRan 5 tests [7.00ms]\n```\n",
      "The string '0 failures' never appears in the output.\n",
      "```json\n",
      json,
      "\n```",
    ].join("");
    expect(parseLLMJson<Obj>(input)).toEqual({
      verdict: "test_bug",
      confidence: 1,
      findings: [{ fixTarget: "test" }],
    });
  });

  test("throws SyntaxError when all tiers fail", () => {
    expect(() => parseLLMJson("no JSON here at all")).toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// wrapJsonPrompt
// ---------------------------------------------------------------------------

describe("wrapJsonPrompt", () => {
  test("prepends JSON-only instruction", () => {
    const result = wrapJsonPrompt("my prompt");
    expect(result).toContain("IMPORTANT:");
    expect(result).toContain("single JSON object or array");
    expect(result).toContain("my prompt");
  });

  test("appends JSON boundary reminder", () => {
    const result = wrapJsonPrompt("my prompt");
    expect(result).toContain("YOUR RESPONSE MUST START WITH");
  });

  test("trims whitespace from core prompt", () => {
    const result = wrapJsonPrompt("  spaced prompt  ");
    expect(result).toContain("spaced prompt");
    expect(result).not.toContain("  spaced prompt  ");
  });

  test("core prompt appears between preamble and suffix", () => {
    const result = wrapJsonPrompt("core content");
    const coreIdx = result.indexOf("core content");
    const importantIdx = result.indexOf("IMPORTANT:");
    const mustStartIdx = result.indexOf("YOUR RESPONSE MUST START WITH");
    expect(importantIdx).toBeLessThan(coreIdx);
    expect(coreIdx).toBeLessThan(mustStartIdx);
  });
});

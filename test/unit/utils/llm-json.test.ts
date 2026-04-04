/**
 * Unit tests for src/utils/llm-json.ts
 *
 * Tests cover:
 * - extractJsonFromMarkdown: fence stripping with/without preamble
 * - stripTrailingCommas: trailing comma removal
 * - extractJsonObject: bare JSON extraction from narration
 */

import { describe, expect, test } from "bun:test";
import { extractJsonFromMarkdown, extractJsonObject, stripTrailingCommas } from "../../../src/utils/llm-json";

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

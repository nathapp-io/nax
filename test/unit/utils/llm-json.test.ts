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

const JSON_FIXTURE = '{"passed":true,"findings":[]}';

describe("extractJsonFromMarkdown", () => {
  test("returns input unchanged when no fence present", () => {
    expect(extractJsonFromMarkdown(JSON_FIXTURE)).toBe(JSON_FIXTURE);
  });

  test.each<[string, string]>([
    ["```json", "```json\n" + JSON_FIXTURE + "\n```"],
    ["```", "```\n" + JSON_FIXTURE + "\n```"],
  ])("extracts JSON from %s fence", (_fenceType, input) => {
    expect(extractJsonFromMarkdown(input)).toBe(JSON_FIXTURE);
  });

  test("handles preamble text before fence (failure mode 2)", () => {
    const input = "I'll verify each AC by reading the implementation files.\n```json\n" + JSON_FIXTURE + "\n```";
    expect(extractJsonFromMarkdown(input)).toBe(JSON_FIXTURE);
  });

  test("handles trailing text after closing fence", () => {
    const input = "```json\n" + JSON_FIXTURE + "\n```\nAll ACs are met.";
    expect(extractJsonFromMarkdown(input)).toBe(JSON_FIXTURE);
  });

  test("handles both preamble and trailing text", () => {
    const json = '{"passed":false,"findings":[]}';
    const input = "Let me check.\n```json\n" + json + "\n```\nThat's my analysis.";
    expect(extractJsonFromMarkdown(input)).toBe(json);
  });

  test("returns input unchanged when fence is unclosed", () => {
    const input = "```json\n{";
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
  test.each<[string, string]>([
    ['{"a":1,}', '{"a":1}'],
    ["[1,2,3,]", "[1,2,3]"],
  ])("removes trailing comma: %s → %s", (input, expected) => {
    expect(stripTrailingCommas(input)).toBe(expected);
  });

  test("removes trailing comma with whitespace", () => {
    expect(stripTrailingCommas('{"a":1,  }')).toBe('{"a":1}');
  });

  test("handles nested trailing commas", () => {
    expect(stripTrailingCommas('{"a":[1,2,],"b":3,}')).toBe('{"a":[1,2],"b":3}');
  });

  test("leaves valid JSON unchanged", () => {
    expect(stripTrailingCommas(JSON_FIXTURE)).toBe(JSON_FIXTURE);
  });

  // A trailing comma is JSON *syntax*. The same characters inside a string
  // VALUE are data — an acceptance criterion quoting `{a: 1,}`, a review
  // finding quoting an array literal. Rewriting those silently corrupts the
  // payload, and because the result still parses, nothing ever errors.
  test.each<string>([
    '{"note":"use {a: 1,} not {a: 1}"}',
    '{"arr":"x,] y"}',
    '{"spaced":"trailing ,   } inside"}',
    '{"escaped":"quote \\" then ,] here"}',
  ])("preserves comma sequences inside string values: %s", (input) => {
    expect(stripTrailingCommas(input)).toBe(input);
    expect(JSON.parse(stripTrailingCommas(input))).toEqual(JSON.parse(input));
  });

  test("still strips real trailing commas that sit next to string values", () => {
    expect(stripTrailingCommas('{"a":"x,]",}')).toBe('{"a":"x,]"}');
    expect(stripTrailingCommas('["a,}","b,]",]')).toBe('["a,}","b,]"]');
  });

  test("does not treat an escaped backslash as escaping the closing quote", () => {
    // "path\\" is a complete string; the following `,]` is real syntax.
    expect(stripTrailingCommas('["path\\\\",]')).toBe('["path\\\\"]');
  });
});

// ---------------------------------------------------------------------------
// extractJsonObject
// ---------------------------------------------------------------------------

describe("extractJsonObject", () => {
  test.each([
    ["just plain text, no JSON here"],
    ["{ no closing brace"],
    [""],
  ])("returns null for %j", (input) => {
    expect(extractJsonObject(input)).toBeNull();
  });

  test("extracts object from pure JSON string", () => {
    expect(extractJsonObject(JSON_FIXTURE)).toBe(JSON_FIXTURE);
  });

  test("extracts object from narration with preamble", () => {
    const input = "After analysis: " + JSON_FIXTURE + " All ACs met.";
    expect(extractJsonObject(input)).toBe(JSON_FIXTURE);
  });

  test("extracts JSON array from text", () => {
    const json = '[{"id":"1"},{"id":"2"}]';
    const input = "Here are the results: " + json;
    expect(extractJsonObject(input)).toBe(json);
  });

  test.each<[string, string, string]>([
    ["object", '{"key":[1,2,3]}', '{"key":[1,2,3]}'],
    ["array", '[{"key":"val"}]', '[{"key":"val"}]'],
  ])("prefers %s when its delimiter appears first", (_label, input, expected) => {
    expect(extractJsonObject(input)).toBe(expected);
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

  // BUG-46: prose braces before the real JSON payload used to mis-slice a
  // naive first-{/last-} extraction (the slice spanned from the prose's
  // opening brace to the payload's closing brace, producing invalid JSON).
  // A brace-balancing scan that tries each `{` candidate in turn fixes this.
  test("parses the real object when prose braces precede it", () => {
    const input = 'the { payload } was: {"a": 1}';
    expect(parseLLMJson<Obj>(input)).toEqual({ a: 1 });
  });

  // Counter-example — a `}` inside a JSON string must still parse correctly
  // (string-state tracking must not be broken by the brace-balancing fix).
  test("counter-example — a closing brace inside a JSON string still parses", () => {
    const input = '{"ok": true, "note": "closing brace } inside string"}';
    expect(parseLLMJson<Obj>(input)).toEqual({ ok: true, note: "closing brace } inside string" });
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

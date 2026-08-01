import { describe, expect, test } from "bun:test";
import { looksLikeTruncatedJson } from "@/review";

/**
 * `looksLikeTruncatedJson` decides which retry prompt an unparseable reviewer
 * response gets: the condensed one ("your response was truncated, drop advisory
 * findings") or the plain one ("return valid JSON").
 *
 * It used to answer that by length — `raw.length >= MAX_AGENT_OUTPUT_CHARS - 100`
 * — on the premise that the ACP adapter tail-truncates at 5000 chars. Nothing
 * truncates: the constant is declared and never applied. So the predicate really
 * meant "is this review long", and July-2026 review payloads run p90 = 4,340
 * bytes with 164 records over 4,500 — complete, finding-rich reviews were being
 * told their response was truncated and asked to send less. See
 * `docs/findings/2026-08-01-review-pipeline-gap-analysis.md` (F2).
 *
 * It now answers the question it claims to: is the JSON structurally unfinished?
 */
describe("looksLikeTruncatedJson", () => {
  describe("genuinely unfinished JSON", () => {
    test("object opened and never closed", () => {
      expect(looksLikeTruncatedJson('{"passed": false, "findings": [')).toBe(true);
    });
    test("nested structure cut mid-array", () => {
      expect(looksLikeTruncatedJson('{"findings": [{"file": "a.ts"}, {"file": "b.ts"')).toBe(true);
    });
    test("cut inside a string value", () => {
      expect(looksLikeTruncatedJson('{"issue": "the handler never checks expiry and so')).toBe(true);
    });
    test("fenced block whose JSON never closes", () => {
      expect(looksLikeTruncatedJson('```json\n{"passed": true, "findings": [\n')).toBe(true);
    });
  });

  describe("complete output — not truncated, whatever its length", () => {
    test("a long but complete review", () => {
      const findings = Array.from({ length: 40 }, (_v, i) => ({
        severity: "warning",
        file: `src/file-${i}.ts`,
        issue: "x".repeat(120),
      }));
      const raw = JSON.stringify({ passed: false, findings });
      expect(raw.length).toBeGreaterThan(5000); // would have been "truncated" under the old rule
      expect(looksLikeTruncatedJson(raw)).toBe(false);
    });
    test("complete but invalid JSON gets the plain retry, not the condensed one", () => {
      expect(looksLikeTruncatedJson('{"passed": true, "findings": [],}')).toBe(false);
    });
    test("prose with no JSON at all", () => {
      expect(looksLikeTruncatedJson("I was unable to review this change because the diff was empty.")).toBe(false);
    });
    test("empty output", () => {
      expect(looksLikeTruncatedJson("")).toBe(false);
      expect(looksLikeTruncatedJson("   \n ")).toBe(false);
    });
    test("braces inside string values do not count as structure", () => {
      expect(looksLikeTruncatedJson('{"issue": "use {foo} here", "line": 3}')).toBe(false);
    });
    test("an escaped quote does not leave the string open", () => {
      expect(looksLikeTruncatedJson('{"issue": "he said \\"hi\\" loudly"}')).toBe(false);
    });
    test("stray closing brace is not truncation", () => {
      expect(looksLikeTruncatedJson('{"a": 1}}')).toBe(false);
    });
  });
});

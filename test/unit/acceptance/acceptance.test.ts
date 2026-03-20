// RE-ARCH: keep
/**
 * Tests for acceptance test generation module
 */

import { describe, expect, test } from "bun:test";
import {
  buildAcceptanceTestPrompt,
  generateSkeletonTests,
  parseAcceptanceCriteria,
} from "../../../src/acceptance/generator";

describe("parseAcceptanceCriteria", () => {
  test("parses AC-N: format", () => {
    const spec = `
## Acceptance Criteria
- AC-1: System should handle empty input
- AC-2: set(key, value, ttl) expires after ttl milliseconds
`;

    const criteria = parseAcceptanceCriteria(spec);

    expect(criteria).toHaveLength(2);
    expect(criteria[0]).toEqual({
      id: "AC-1",
      text: "System should handle empty input",
      lineNumber: 3,
    });
    expect(criteria[1]).toEqual({
      id: "AC-2",
      text: "set(key, value, ttl) expires after ttl milliseconds",
      lineNumber: 4,
    });
  });

  test("parses checklist format", () => {
    const spec = `
## Acceptance Criteria
- [ ] AC-1: Feature works correctly
- [x] AC-2: Tests pass
`;

    const criteria = parseAcceptanceCriteria(spec);

    expect(criteria).toHaveLength(2);
    expect(criteria[0].id).toBe("AC-1");
    expect(criteria[1].id).toBe("AC-2");
  });

  test("normalizes AC IDs to uppercase", () => {
    const spec = "- ac-1: lowercase id";
    const criteria = parseAcceptanceCriteria(spec);

    expect(criteria[0].id).toBe("AC-1");
  });

  test("handles AC without list marker", () => {
    const spec = `
AC-1: Standalone criterion
AC-2: Another criterion
`;

    const criteria = parseAcceptanceCriteria(spec);

    expect(criteria).toHaveLength(2);
    expect(criteria[0].text).toBe("Standalone criterion");
  });

  test("returns empty array when no AC found", () => {
    const spec = `
# Feature
This is a spec with no acceptance criteria.
`;

    const criteria = parseAcceptanceCriteria(spec);

    expect(criteria).toEqual([]);
  });

  test("tracks correct line numbers", () => {
    const spec = `Line 1
Line 2
- AC-1: First criterion
Line 4
- AC-2: Second criterion`;

    const criteria = parseAcceptanceCriteria(spec);

    expect(criteria[0].lineNumber).toBe(3);
    expect(criteria[1].lineNumber).toBe(5);
  });
});

describe("buildAcceptanceTestPrompt", () => {
  test("includes all criteria in prompt", () => {
    const criteria = [
      { id: "AC-1", text: "handles empty input", lineNumber: 5 },
      { id: "AC-2", text: "validates email format", lineNumber: 6 },
    ];

    const prompt = buildAcceptanceTestPrompt(criteria, "auth", "File tree:\nsrc/\n  auth.ts\n");

    expect(prompt).toContain("AC-1: handles empty input");
    expect(prompt).toContain("AC-2: validates email format");
    expect(prompt).toContain('"auth"');
    expect(prompt).toContain("File tree:");
  });

  test("formats prompt with correct structure", () => {
    const criteria = [{ id: "AC-1", text: "test criterion", lineNumber: 1 }];

    const prompt = buildAcceptanceTestPrompt(criteria, "feature", "context");

    expect(prompt).toContain("PROJECT FILE TREE:");
    expect(prompt).toContain("ACCEPTANCE CRITERIA:");
    expect(prompt).toContain("One test per AC");
    expect(prompt).toContain("NEVER use placeholder assertions");
  });
});

describe("generateSkeletonTests", () => {
  test("generates skeleton with TODO placeholders", () => {
    const criteria = [
      { id: "AC-1", text: "handles empty input", lineNumber: 5 },
      { id: "AC-2", text: "validates email", lineNumber: 6 },
    ];

    const skeleton = generateSkeletonTests("auth", criteria);

    expect(skeleton).toContain('describe("auth - Acceptance Tests"');
    expect(skeleton).toContain('test("AC-1: handles empty input"');
    expect(skeleton).toContain('test("AC-2: validates email"');
    expect(skeleton).toContain("// TODO: Implement acceptance test for AC-1");
    expect(skeleton).toContain("// TODO: Implement acceptance test for AC-2");
    expect(skeleton).toContain("expect(true).toBe(false)");
  });

  test("generates valid TypeScript structure", () => {
    const criteria = [{ id: "AC-1", text: "test", lineNumber: 1 }];

    const skeleton = generateSkeletonTests("feature", criteria);

    expect(skeleton).toContain('import { describe, test, expect } from "bun:test"');
    expect(skeleton).toContain("describe(");
    expect(skeleton).toContain("test(");
    expect(skeleton).toContain("async () => {");
  });

  test("handles empty criteria array", () => {
    const skeleton = generateSkeletonTests("feature", []);

    expect(skeleton).toContain('describe("feature - Acceptance Tests"');
    expect(skeleton).toContain("// No acceptance criteria found");
  });

  test("escapes special characters in criteria text", () => {
    const criteria = [{ id: "AC-1", text: 'handles "quotes" correctly', lineNumber: 1 }];

    const skeleton = generateSkeletonTests("feature", criteria);

    // Should still contain the escaped text
    expect(skeleton).toContain('handles "quotes" correctly');
  });
});

describe("integration: AC parsing and skeleton generation", () => {
  test("full workflow from spec to skeleton", () => {
    const spec = `
# Feature: URL Shortener

## Acceptance Criteria
- AC-1: Shortened URLs redirect to original URL
- AC-2: Invalid URLs return 404
- AC-3: Analytics track click counts
`;

    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria).toHaveLength(3);

    const skeleton = generateSkeletonTests("url-shortener", criteria);

    expect(skeleton).toContain("AC-1: Shortened URLs redirect to original URL");
    expect(skeleton).toContain("AC-2: Invalid URLs return 404");
    expect(skeleton).toContain("AC-3: Analytics track click counts");
    expect(skeleton).toContain("url-shortener");
  });
});

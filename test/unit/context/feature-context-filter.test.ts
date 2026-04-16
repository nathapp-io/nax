/**
 * Tests for feature-context-filter.ts
 *
 * Covers role filtering, tag parsing, and budget enforcement.
 */

import { describe, expect, test } from "bun:test";
import {
  estimateContextTokens,
  filterContextByRole,
  parseAudienceTags,
  shouldIncludeEntry,
  truncateToContextBudget,
} from "../../../src/context/feature-context-filter";

describe("parseAudienceTags", () => {
  test("returns ['all'] when no tag present", () => {
    expect(parseAudienceTags("- **No tag here.**")).toEqual(["all"]);
  });

  test("returns ['all'] for plain text", () => {
    expect(parseAudienceTags("Some text without brackets")).toEqual(["all"]);
  });

  test("parses single tag", () => {
    expect(parseAudienceTags("- **Entry.** `[implementer]`")).toEqual(["implementer"]);
  });

  test("parses multi-tag", () => {
    expect(parseAudienceTags("- **Entry.** `[implementer, test-writer]`")).toEqual([
      "implementer",
      "test-writer",
    ]);
  });

  test("parses all tag", () => {
    expect(parseAudienceTags("- **Entry.** `[all]`")).toEqual(["all"]);
  });

  test("is case insensitive", () => {
    expect(parseAudienceTags("- **Entry.** `[IMPLEMENTER]`")).toEqual(["implementer"]);
  });

  test("trims whitespace in multi-tag", () => {
    expect(parseAudienceTags("- **Entry.** `[ reviewer , reviewer-semantic ]`")).toEqual([
      "reviewer",
      "reviewer-semantic",
    ]);
  });
});

describe("shouldIncludeEntry", () => {
  test("[all] entry included for every role", () => {
    const roles = [
      "implementer",
      "test-writer",
      "verifier",
      "single-session",
      "tdd-simple",
      "no-test",
      "batch",
      "reviewer-semantic",
      "reviewer-adversarial",
    ];
    for (const role of roles) {
      expect(shouldIncludeEntry(["all"], role)).toBe(true);
    }
  });

  test("[implementer] included for implementer", () => {
    expect(shouldIncludeEntry(["implementer"], "implementer")).toBe(true);
  });

  test("[implementer] included for single-session", () => {
    expect(shouldIncludeEntry(["implementer"], "single-session")).toBe(true);
  });

  test("[implementer] included for tdd-simple", () => {
    expect(shouldIncludeEntry(["implementer"], "tdd-simple")).toBe(true);
  });

  test("[implementer] included for no-test", () => {
    expect(shouldIncludeEntry(["implementer"], "no-test")).toBe(true);
  });

  test("[implementer] included for batch", () => {
    expect(shouldIncludeEntry(["implementer"], "batch")).toBe(true);
  });

  test("[implementer] excluded for test-writer", () => {
    expect(shouldIncludeEntry(["implementer"], "test-writer")).toBe(false);
  });

  test("[implementer] excluded for verifier", () => {
    expect(shouldIncludeEntry(["implementer"], "verifier")).toBe(false);
  });

  test("[implementer] excluded for reviewer-semantic", () => {
    expect(shouldIncludeEntry(["implementer"], "reviewer-semantic")).toBe(false);
  });

  test("[test-writer] included for test-writer", () => {
    expect(shouldIncludeEntry(["test-writer"], "test-writer")).toBe(true);
  });

  test("[test-writer] included for single-session", () => {
    expect(shouldIncludeEntry(["test-writer"], "single-session")).toBe(true);
  });

  test("[test-writer] included for tdd-simple", () => {
    expect(shouldIncludeEntry(["test-writer"], "tdd-simple")).toBe(true);
  });

  test("[test-writer] included for batch", () => {
    expect(shouldIncludeEntry(["test-writer"], "batch")).toBe(true);
  });

  test("[test-writer] excluded for implementer", () => {
    expect(shouldIncludeEntry(["test-writer"], "implementer")).toBe(false);
  });

  test("[test-writer] excluded for verifier", () => {
    expect(shouldIncludeEntry(["test-writer"], "verifier")).toBe(false);
  });

  test("[test-writer] excluded for reviewer-semantic", () => {
    expect(shouldIncludeEntry(["test-writer"], "reviewer-semantic")).toBe(false);
  });

  test("[reviewer] included for reviewer-semantic", () => {
    expect(shouldIncludeEntry(["reviewer"], "reviewer-semantic")).toBe(true);
  });

  test("[reviewer] included for reviewer-adversarial", () => {
    expect(shouldIncludeEntry(["reviewer"], "reviewer-adversarial")).toBe(true);
  });

  test("[reviewer-semantic] included for reviewer-semantic only", () => {
    expect(shouldIncludeEntry(["reviewer-semantic"], "reviewer-semantic")).toBe(true);
    expect(shouldIncludeEntry(["reviewer-semantic"], "reviewer-adversarial")).toBe(false);
  });

  test("[reviewer-adversarial] included for reviewer-adversarial only", () => {
    expect(shouldIncludeEntry(["reviewer-adversarial"], "reviewer-adversarial")).toBe(true);
    expect(shouldIncludeEntry(["reviewer-adversarial"], "reviewer-semantic")).toBe(false);
  });

  test("multi-tag [implementer, test-writer] included for implementer", () => {
    expect(shouldIncludeEntry(["implementer", "test-writer"], "implementer")).toBe(true);
  });

  test("multi-tag [implementer, test-writer] included for test-writer", () => {
    expect(shouldIncludeEntry(["implementer", "test-writer"], "test-writer")).toBe(true);
  });

  test("multi-tag [implementer, test-writer] excluded for verifier", () => {
    expect(shouldIncludeEntry(["implementer", "test-writer"], "verifier")).toBe(false);
  });
});

describe("filterContextByRole", () => {
  const contextMd = `# Feature Context

_Last updated: 2024-01-01_

## Implementation Notes

- **Database schema defined.** \`[implementer]\`
  Use the schema in src/db/schema.ts.
  _Established in: US-001_

- **Test fixtures available.** \`[test-writer]\`
  Use the fixtures in test/fixtures/.

- **Shared constraint.** \`[all]\`
  Always validate input before processing.

## Review Notes

- **Security concern.** \`[reviewer-semantic]\`
  Check for SQL injection in all queries.
`;

  test("implementer sees [implementer] and [all] entries, not [test-writer]", () => {
    const result = filterContextByRole(contextMd, "implementer");
    expect(result).toContain("Database schema defined");
    expect(result).toContain("Shared constraint");
    expect(result).not.toContain("Test fixtures available");
    expect(result).not.toContain("Security concern");
  });

  test("test-writer sees [test-writer] and [all] entries, not [implementer]", () => {
    const result = filterContextByRole(contextMd, "test-writer");
    expect(result).toContain("Test fixtures available");
    expect(result).toContain("Shared constraint");
    expect(result).not.toContain("Database schema defined");
    expect(result).not.toContain("Security concern");
  });

  test("single-session sees [all], [implementer], and [test-writer] entries", () => {
    const result = filterContextByRole(contextMd, "single-session");
    expect(result).toContain("Database schema defined");
    expect(result).toContain("Test fixtures available");
    expect(result).toContain("Shared constraint");
    expect(result).not.toContain("Security concern");
  });

  test("tdd-simple sees [all], [implementer], and [test-writer] entries", () => {
    const result = filterContextByRole(contextMd, "tdd-simple");
    expect(result).toContain("Database schema defined");
    expect(result).toContain("Test fixtures available");
    expect(result).toContain("Shared constraint");
  });

  test("reviewer-semantic sees [all], [reviewer], and [reviewer-semantic] entries", () => {
    const result = filterContextByRole(contextMd, "reviewer-semantic");
    expect(result).toContain("Shared constraint");
    expect(result).toContain("Security concern");
    expect(result).not.toContain("Database schema defined");
    expect(result).not.toContain("Test fixtures available");
  });

  test("returns empty string for empty input", () => {
    expect(filterContextByRole("", "implementer")).toBe("");
    expect(filterContextByRole("   ", "implementer")).toBe("");
  });

  test("entry without tag treated as [all] — included for every role", () => {
    const md = `## Notes

- **No tag entry.**
  This has no audience tag.
`;
    for (const role of ["implementer", "test-writer", "verifier", "reviewer-semantic"]) {
      const result = filterContextByRole(md, role);
      expect(result).toContain("No tag entry");
    }
  });

  test("empty section is dropped when all entries filtered out", () => {
    const md = `## Implementation Notes

- **Implementer only.** \`[implementer]\`
  Only for implementers.

## Review Notes

- **Reviewer only.** \`[reviewer-semantic]\`
  Only for reviewers.
`;
    const result = filterContextByRole(md, "implementer");
    expect(result).toContain("Implementation Notes");
    expect(result).toContain("Implementer only");
    expect(result).not.toContain("Review Notes");
    expect(result).not.toContain("Reviewer only");
  });
});

describe("estimateContextTokens", () => {
  test("estimates 1 token per 4 chars (ceil)", () => {
    expect(estimateContextTokens("abcd")).toBe(1); // 4 chars
    expect(estimateContextTokens("abcde")).toBe(2); // 5 chars → ceil(5/4) = 2
    expect(estimateContextTokens("")).toBe(0);
  });
});

describe("truncateToContextBudget", () => {
  test("returns unchanged when within budget", () => {
    const text = "short text";
    const result = truncateToContextBudget(text, 100, "my-feature");
    expect(result).toBe(text);
  });

  test("truncates when over budget — result is shorter", () => {
    const text = "a".repeat(1000); // 1000 chars = 250 tokens
    const result = truncateToContextBudget(text, 10, "my-feature"); // budget: 10 tokens = 40 chars
    expect(result.length).toBeLessThan(text.length);
  });

  test("truncated result is tail of original (tail-biased)", () => {
    const text = "HEADER-TEXT\nLINE-ONE\nLINE-TWO\nLINE-THREE\nLINE-FOUR\nTAIL-TEXT";
    // Small budget so we get tail portion
    const result = truncateToContextBudget(text, 5, "feat"); // 5 tokens = 20 chars
    // Should contain some tail content
    expect(result.length).toBeGreaterThan(0);
    // Should not start with the very beginning of the text
    expect(result).not.toContain("HEADER-TEXT");
  });
});

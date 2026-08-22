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
} from "@/context/feature-context-filter";

describe("parseAudienceTags", () => {
  test.each([
    ["no tag present", "- **No tag here.**", ["all"]],
    ["plain text", "Some text without brackets", ["all"]],
    ["single tag", "- **Entry.** `[implementer]`", ["implementer"]],
    ["multi-tag", "- **Entry.** `[implementer, test-writer]`", ["implementer", "test-writer"]],
    ["all tag", "- **Entry.** `[all]`", ["all"]],
    ["case insensitive", "- **Entry.** `[IMPLEMENTER]`", ["implementer"]],
    ["whitespace in multi-tag", "- **Entry.** `[ reviewer , reviewer-semantic ]`", ["reviewer", "reviewer-semantic"]],
  ])("parses %s", (_label, input, expected) => {
    expect(parseAudienceTags(input)).toEqual(expected);
  });

  // BUG-57: a trailing markdown link `[text](url)` was previously mistaken for the
  // audience tag block (the LAST `[...]` on the line), shadowing a real tag earlier
  // in the headline and defaulting untagged headlines to a bogus tag that matches no
  // role. A bracket group immediately followed by '(' is link text, not a tag.
  test.each([
    ["untagged headline ending in a markdown link defaults to [all]", "- **API docs** — [docs](url)", ["all"]],
    [
      "a real tag earlier in the line is not shadowed by a trailing link",
      "- [implementer] — see [docs](url)",
      ["implementer"],
    ],
    ["multiple trailing links still fall back to [all]", "- See [one](url1) and [two](url2)", ["all"]],
  ])("BUG-57: %s", (_label, input, expected) => {
    expect(parseAudienceTags(input)).toEqual(expected);
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

  test.each(["implementer", "single-session", "tdd-simple", "no-test", "batch"])(
    "[implementer] included for %s",
    (role) => {
      expect(shouldIncludeEntry(["implementer"], role)).toBe(true);
    },
  );

  test.each(["test-writer", "verifier", "reviewer-semantic"])("[implementer] excluded for %s", (role) => {
    expect(shouldIncludeEntry(["implementer"], role)).toBe(false);
  });

  test.each(["test-writer", "single-session", "tdd-simple", "batch"])("[test-writer] included for %s", (role) => {
    expect(shouldIncludeEntry(["test-writer"], role)).toBe(true);
  });

  test.each(["implementer", "verifier", "reviewer-semantic"])("[test-writer] excluded for %s", (role) => {
    expect(shouldIncludeEntry(["test-writer"], role)).toBe(false);
  });

  test.each(["reviewer-semantic", "reviewer-adversarial"])("[reviewer] included for %s", (role) => {
    expect(shouldIncludeEntry(["reviewer"], role)).toBe(true);
  });

  test("[reviewer-semantic] included for reviewer-semantic only", () => {
    expect(shouldIncludeEntry(["reviewer-semantic"], "reviewer-semantic")).toBe(true);
    expect(shouldIncludeEntry(["reviewer-semantic"], "reviewer-adversarial")).toBe(false);
  });

  test("[reviewer-adversarial] included for reviewer-adversarial only", () => {
    expect(shouldIncludeEntry(["reviewer-adversarial"], "reviewer-adversarial")).toBe(true);
    expect(shouldIncludeEntry(["reviewer-adversarial"], "reviewer-semantic")).toBe(false);
  });

  test.each<[string, boolean]>([
    ["implementer", true],
    ["test-writer", true],
    ["verifier", false],
  ])("multi-tag [implementer, test-writer]: role %s → %s", (role, expected) => {
    expect(shouldIncludeEntry(["implementer", "test-writer"], role)).toBe(expected);
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

  test.each(["single-session", "tdd-simple"] as const)(
    "%s sees [all], [implementer], and [test-writer] entries",
    (role) => {
      const result = filterContextByRole(contextMd, role);
      expect(result).toContain("Database schema defined");
      expect(result).toContain("Test fixtures available");
      expect(result).toContain("Shared constraint");
      expect(result).not.toContain("Security concern");
    },
  );

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

describe("filterContextByRole — edge cases", () => {
  test("no trailing blank line leaks from excluded into included entry", () => {
    // When an included entry is immediately followed by an excluded entry,
    // the blank line separating them must NOT appear in the output.
    const md = [
      "## Constraints",
      "",
      "- **Included entry.** `[implementer]`",
      "  Body of included entry.",
      "",
      "- **Excluded entry.** `[test-writer]`",
      "  Body of excluded entry.",
    ].join("\n");

    const result = filterContextByRole(md, "implementer");

    // The included entry should be present
    expect(result).toContain("Included entry");
    // The excluded entry must not appear
    expect(result).not.toContain("Excluded entry");
    // The result must not end with a blank line (leaked from between entries)
    expect(result.trimEnd()).toBe(result);
    // Specifically: no double newline trailing
    expect(result).not.toMatch(/\n\s*$/);
  });

  test("narrative text under ## section heading is dropped (bullet-only format)", () => {
    // context.md entries are spec-defined as bullet form.
    // Free-form narrative paragraphs inside a ## Section are silently dropped.
    // This test documents the intentional behavior.
    const md = [
      "## Decisions",
      "",
      "This is a narrative paragraph, not a bullet entry.",
      "",
      "- **Bullet entry.** `[all]`",
      "  Body text.",
    ].join("\n");

    const result = filterContextByRole(md, "implementer");

    // Bullet entry is kept
    expect(result).toContain("Bullet entry");
    // Narrative paragraph is dropped (by design — not a supported format)
    expect(result).not.toContain("This is a narrative paragraph");
  });
});

/**
 * rules-frontmatter.ts — unit tests
 *
 * Covers parseFrontmatter and RulesFrontmatterError from the split.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  _canonicalLoaderDeps,
  FRONTMATTER_PRIORITY_DEFAULT,
  KNOWN_FRONTMATTER_KEYS,
  parseFrontmatter,
  RulesFrontmatterError,
} from "@/context/rules";

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let origGetLogger: typeof _canonicalLoaderDeps.getLogger;

beforeEach(() => {
  origGetLogger = _canonicalLoaderDeps.getLogger;
});

afterEach(() => {
  _canonicalLoaderDeps.getLogger = origGetLogger;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: parseFrontmatter() returns priority 100 when content has no frontmatter block
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC1", () => {
  test("[AC1] returns priority 100 when supplied content has no frontmatter block", () => {
    const result = parseFrontmatter("## Coding Style\n\nUse async/await.", "/project/.nax/rules/style.md");
    expect(result.priority).toBe(FRONTMATTER_PRIORITY_DEFAULT);
    expect(result.priority).toBe(100);
  });

  test("[AC1] returns the raw content unchanged when no frontmatter", () => {
    const content = "## Coding Style\n\nUse async/await.";
    const result = parseFrontmatter(content, "/project/.nax/rules/style.md");
    expect(result.content).toBe(content);
  });

  test("[AC1] priority 100 is the FRONTMATTER_PRIORITY_DEFAULT constant", () => {
    expect(FRONTMATTER_PRIORITY_DEFAULT).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: parseFrontmatter() throws RulesFrontmatterError when file opens with --- and has no closing ---
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter — AC4", () => {
  test("[AC4] throws RulesFrontmatterError when a rule file opens with --- and has no closing ---", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\npriority: 50\n", "/project/.nax/rules/bad.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("missing closing '---'");
    expect((threw as RulesFrontmatterError).context?.filePath).toBe("/project/.nax/rules/bad.md");
  });

  test("[AC4] throws on empty frontmatter with no body", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\n---\n", "/project/.nax/rules/empty.md");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("missing closing '---'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN_FRONTMATTER_KEYS
// ─────────────────────────────────────────────────────────────────────────────

describe("KNOWN_FRONTMATTER_KEYS", () => {
  test("contains priority, paths, and appliesTo", () => {
    expect(KNOWN_FRONTMATTER_KEYS.has("priority")).toBe(true);
    expect(KNOWN_FRONTMATTER_KEYS.has("paths")).toBe(true);
    expect(KNOWN_FRONTMATTER_KEYS.has("appliesTo")).toBe(true);
  });

  test("does not contain unknown keys", () => {
    expect(KNOWN_FRONTMATTER_KEYS.has("scope")).toBe(false);
    expect(KNOWN_FRONTMATTER_KEYS.has("roles")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFrontmatter — general behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses priority from frontmatter", () => {
    const result = parseFrontmatter(
      "---\npriority: 35\n---\nRule content.",
      "/project/.nax/rules/test.md",
    );
    expect(result.priority).toBe(35);
  });

  test("parses paths as array from frontmatter", () => {
    const result = parseFrontmatter(
      '---\npaths:\n  - "apps/api"\n---\nRule content.',
      "/project/.nax/rules/test.md",
    );
    expect(result.paths).toEqual(["apps/api"]);
  });

  test("parses paths as string from frontmatter", () => {
    const result = parseFrontmatter(
      '---\npaths: "apps/api"\n---\nRule content.',
      "/project/.nax/rules/test.md",
    );
    expect(result.paths).toEqual(["apps/api"]);
  });

  test("throws RulesFrontmatterError for unknown frontmatter keys", () => {
    let threw: unknown;
    try {
      parseFrontmatter(
        "---\npriority: 50\nunknownKey: value\n---\nRule content.",
        "/project/.nax/rules/test.md",
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    expect((threw as RulesFrontmatterError).message).toContain("unknown key(s)");
  });

  test("handles CRLF line endings", () => {
    const result = parseFrontmatter(
      "---\r\npriority: 50\r\n---\r\nRule content.\r\n",
      "/project/.nax/rules/test.md",
    );
    expect(result.priority).toBe(50);
  });

  test("strips frontmatter and returns body content", () => {
    const result = parseFrontmatter(
      "---\npriority: 50\n---\nRule body.",
      "/project/.nax/rules/test.md",
    );
    expect(result.content).toBe("Rule body.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RulesFrontmatterError
// ─────────────────────────────────────────────────────────────────────────────

describe("RulesFrontmatterError", () => {
  test("has correct error code", () => {
    const error = new RulesFrontmatterError("test error", "/path/to/file.md");
    expect(error.code).toBe("RULES_FRONTMATTER_INVALID");
  });

  test("includes filePath in context", () => {
    const error = new RulesFrontmatterError("test error", "/path/to/file.md");
    expect(error.context?.filePath).toBe("/path/to/file.md");
  });
});

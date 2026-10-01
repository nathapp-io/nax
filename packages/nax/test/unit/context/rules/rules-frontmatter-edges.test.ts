/**
 * rules-frontmatter.ts — characterisation tests for validation branches the
 * mirror suites leave unpinned, written before the complexity drain refactor
 * (docs/plans/STATUS-complexity-drain.md, batch C2). Every assertion below is
 * green against the unrefactored parser; the tests pin behaviour, not
 * implementation.
 */

import { describe, expect, test } from "bun:test";
import { assertCaughtInstanceOf } from "@test/helpers";
import {
  FRONTMATTER_PRIORITY_DEFAULT,
  parseFrontmatter,
  RulesFrontmatterError,
} from "@/context/rules/rules-frontmatter";

const FILE = "/project/.nax/rules/edges.md";

describe("parseFrontmatter — YAML-level validation", () => {
  test("throws 'Frontmatter must be a YAML object' when the block is a YAML list", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\n- a\n- b\n---\nBody.", FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("Frontmatter must be a YAML object");
  });

  test("throws 'Frontmatter must be a YAML object' when the block is a YAML scalar", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\njust a scalar\n---\nBody.", FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("Frontmatter must be a YAML object");
  });

  test("wraps a YAML parse failure's message in 'Failed to parse YAML frontmatter'", () => {
    let threw: unknown;
    try {
      parseFrontmatter('---\ndescription: "unclosed\n---\nBody.', FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toContain("Failed to parse YAML frontmatter:");
    expect(threw.message).toContain("Unexpected EOF");
  });
});

describe("parseFrontmatter — priority validation", () => {
  test("throws 'frontmatter.priority must be a number' when priority is a string", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\npriority: high\n---\nBody.", FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.priority must be a number");
  });

  test("throws 'frontmatter.priority must be a number' when priority is YAML null (.inf parses as null in Bun.YAML)", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\npriority: .inf\n---\nBody.", FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.priority must be a number");
  });

  test("truncates a fractional priority toward zero", () => {
    const result = parseFrontmatter("---\npriority: 3.7\n---\nBody.", FILE);
    expect(result.priority).toBe(3);
  });
});

describe("parseFrontmatter — paths validation", () => {
  test("throws 'frontmatter.paths cannot be empty' when paths is an empty string", () => {
    let threw: unknown;
    try {
      parseFrontmatter('---\npaths: ""\n---\nBody.', FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.paths cannot be empty");
  });

  test("throws 'frontmatter.paths must be a string or string[]' when paths is a number", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\npaths: 42\n---\nBody.", FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.paths must be a string or string[]");
  });

  test("throws 'frontmatter.paths must be a string or string[]' when a paths entry is empty after trimming", () => {
    let threw: unknown;
    try {
      parseFrontmatter('---\npaths:\n  - "apps/api"\n  - "   "\n---\nBody.', FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.paths must be a string or string[]");
  });
});

describe("parseFrontmatter — appliesTo validation", () => {
  test("throws 'frontmatter.appliesTo must be a list of strings' when appliesTo is a bare string", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\nappliesTo: src/**\n---\nBody.", FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.appliesTo must be a list of strings");
  });

  test("throws 'frontmatter.appliesTo must be a list of strings' when an entry is whitespace-only", () => {
    let threw: unknown;
    try {
      parseFrontmatter('---\nappliesTo:\n  - "src/**"\n  - "   "\n---\nBody.', FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.appliesTo must be a list of strings");
  });
});

describe("parseFrontmatter — stages validation", () => {
  test("throws 'frontmatter.stages must be a list of strings' when stages is a bare string", () => {
    let threw: unknown;
    try {
      parseFrontmatter("---\nstages: execution\n---\nBody.", FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.stages must be a list of strings");
  });

  test("throws 'frontmatter.stages must be a list containing only strings' when an entry is whitespace-only", () => {
    let threw: unknown;
    try {
      parseFrontmatter('---\nstages:\n  - "execution"\n  - " "\n---\nBody.', FILE);
    } catch (e) {
      threw = e;
    }
    assertCaughtInstanceOf(threw, RulesFrontmatterError, "parseFrontmatter rejection");
    expect(threw.message).toBe("frontmatter.stages must be a list containing only strings");
  });
});

describe("parseFrontmatter — displaced frontmatter with no closing delimiter", () => {
  test("returns the default result carrying the displaced warning instead of throwing", () => {
    const result = parseFrontmatter("\n---\npriority: 50\n", FILE);
    expect(result.priority).toBe(FRONTMATTER_PRIORITY_DEFAULT);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("displaced");
    expect(result.content).toContain("priority: 50");
  });
});

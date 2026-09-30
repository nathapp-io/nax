// tools/monorepo/test/rule-frontmatter.test.ts
import { describe, expect, test } from "bun:test";
import { rewriteRuleFrontmatter } from "../lib/rule-frontmatter";

const RULE = `---
priority: 35
appliesTo:
  - "src/agents/**/*.ts"
  - "src/session/session-keeper.ts"
stages:
  - "context"
---

# Body mentions src/agents/ and stays as-is
`;

describe("rewriteRuleFrontmatter", () => {
  test("prefixes appliesTo entries (globs and literals) and adds a paths filter after priority", () => {
    const out = rewriteRuleFrontmatter(RULE, "packages/nax");
    expect(out).toBe(`---
priority: 35
paths:
  - "packages/nax/*"
appliesTo:
  - "packages/nax/src/agents/**/*.ts"
  - "packages/nax/src/session/session-keeper.ts"
stages:
  - "context"
---

# Body mentions src/agents/ and stays as-is
`);
  });
  test("is idempotent on appliesTo but refuses an existing paths key", () => {
    const once = rewriteRuleFrontmatter(RULE, "packages/nax");
    expect(() => rewriteRuleFrontmatter(once, "packages/nax")).toThrow(/already declares paths/);
  });
  test("an already-prefixed appliesTo entry is not double-prefixed", () => {
    const pre = RULE.replace('"src/agents/**/*.ts"', '"packages/nax/src/agents/**/*.ts"');
    expect(rewriteRuleFrontmatter(pre, "packages/nax")).toContain('  - "packages/nax/src/agents/**/*.ts"\n');
    expect(rewriteRuleFrontmatter(pre, "packages/nax")).not.toContain("packages/nax/packages/nax");
  });
  test("throws when there is no frontmatter or no appliesTo", () => {
    expect(() => rewriteRuleFrontmatter("# no frontmatter\n", "packages/nax")).toThrow(/no frontmatter/);
    expect(() => rewriteRuleFrontmatter("---\npriority: 1\n---\nx\n", "packages/nax")).toThrow(/no appliesTo/);
  });
});

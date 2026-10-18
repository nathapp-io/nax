/**
 * US-002 — `context.rules` and `context.projectContext` schema defaults and
 * override-path validation.
 *
 * The two blocks carry the run-level rules override and the run-level project
 * context file. Their defaults are schema-derived (each block is declared as
 * `XBase.default(() => XBase.parse({}))`), so `NaxConfigSchema.parse({})`
 * carries them without a hand-written literal in `schemas.ts` — the same trap
 * `ContextConfigSchema` documents.
 *
 * Path rule under test: `overrideDir` / `file` must be absolute or `~/`-prefixed.
 * `~/` expands against the home directory (AC-5); a relative value fails
 * validation with an issue at the exact key (AC-4, AC-6), because a relative
 * path would otherwise resolve against whatever cwd the run happened to inherit.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { NaxConfigSchema } from "@/config";

/** A raw root config carrying only the given `context.rules` block. */
function withRules(rules: unknown): Record<string, unknown> {
  return { context: { rules } };
}

/** A raw root config carrying only the given `context.projectContext` block. */
function withProjectContext(projectContext: unknown): Record<string, unknown> {
  return { context: { projectContext } };
}

/** The dotted issue paths of a failed parse. */
function issuePaths(result: ReturnType<typeof NaxConfigSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("context.rules / context.projectContext — defaults (US-002)", () => {
  test("AC-1: NaxConfigSchema.parse({}) yields context.rules.delivery === 'index'", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.context.rules.delivery).toBe("index");
  });

  test("AC-2: NaxConfigSchema.parse({}) yields context.rules.overrideMode === 'merge'", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.context.rules.overrideMode).toBe("merge");
  });

  test("AC-3: NaxConfigSchema.parse({}) yields context.projectContext.mode === 'append'", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.context.projectContext.mode).toBe("append");
  });

  test("both blocks default to no override path", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.context.rules.overrideDir).toBeUndefined();
    expect(config.context.projectContext.file).toBeUndefined();
  });

  test("a partial block keeps its sibling defaults (rules.delivery set, overrideMode still 'merge')", () => {
    const result = NaxConfigSchema.safeParse(withRules({ delivery: "push" }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.context.rules.delivery).toBe("push");
    expect(result.data.context.rules.overrideMode).toBe("merge");
    expect(result.data.context.projectContext.mode).toBe("append");
  });

  test("delivery accepts only 'index' | 'push'", () => {
    expect(issuePaths(NaxConfigSchema.safeParse(withRules({ delivery: "lazy" })))).toEqual(["context.rules.delivery"]);
  });

  test("overrideMode accepts only 'merge' | 'replace'", () => {
    expect(issuePaths(NaxConfigSchema.safeParse(withRules({ overrideMode: "append" })))).toEqual([
      "context.rules.overrideMode",
    ]);
  });

  test("projectContext.mode accepts only 'append' | 'replace'", () => {
    expect(issuePaths(NaxConfigSchema.safeParse(withProjectContext({ mode: "merge" })))).toEqual([
      "context.projectContext.mode",
    ]);
  });
});

describe("context.rules.overrideDir / context.projectContext.file — paths (US-002)", () => {
  test("AC-4: a relative overrideDir fails with an issue at context.rules.overrideDir", () => {
    const result = NaxConfigSchema.safeParse(withRules({ overrideDir: "relative/dir" }));

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("context.rules.overrideDir");
  });

  test("AC-5: overrideDir '~/org-rules' expands to join(homedir(), 'org-rules')", () => {
    const result = NaxConfigSchema.safeParse(withRules({ overrideDir: "~/org-rules" }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.context.rules.overrideDir).toBe(join(homedir(), "org-rules"));
  });

  test("AC-6: a relative projectContext.file fails with an issue at context.projectContext.file", () => {
    const result = NaxConfigSchema.safeParse(withProjectContext({ file: "ctx.md" }));

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("context.projectContext.file");
  });

  test("an absolute overrideDir passes through unchanged", () => {
    const result = NaxConfigSchema.safeParse(withRules({ overrideDir: "/abs/org-rules" }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.context.rules.overrideDir).toBe("/abs/org-rules");
  });

  test("an absolute projectContext.file passes through unchanged", () => {
    const result = NaxConfigSchema.safeParse(withProjectContext({ file: "/abs/ctx.md" }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.context.projectContext.file).toBe("/abs/ctx.md");
  });

  test("projectContext.file accepts the same '~/' form as overrideDir", () => {
    const result = NaxConfigSchema.safeParse(withProjectContext({ file: "~/fleet/strict.md" }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.context.projectContext.file).toBe(join(homedir(), "fleet/strict.md"));
  });

  test("a bare '~' is rejected — only the '~/' form is a documented shorthand", () => {
    expect(issuePaths(NaxConfigSchema.safeParse(withRules({ overrideDir: "~" })))).toEqual([
      "context.rules.overrideDir",
    ]);
    expect(issuePaths(NaxConfigSchema.safeParse(withProjectContext({ file: "~" })))).toEqual([
      "context.projectContext.file",
    ]);
  });

  test("a '..'-prefixed relative path is rejected too (not silently resolved)", () => {
    expect(issuePaths(NaxConfigSchema.safeParse(withRules({ overrideDir: "../org-rules" })))).toEqual([
      "context.rules.overrideDir",
    ]);
  });
});

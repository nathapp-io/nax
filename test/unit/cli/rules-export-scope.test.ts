/**
 * `nax rules export --agent=claude` — package scope survives the export.
 *
 * Canonical `paths:` is PACKAGE scope; Claude's `paths:` is a FILE glob. These
 * used to be treated as having no correspondence, so a package-scoped rule was
 * exported with its scope dropped — and because `claudeFrontmatter` derives the
 * block solely from `appliesTo`, such a rule emitted no frontmatter at all and
 * Claude then loaded it globally. A rule written for one package silently
 * applied to the whole monorepo.
 *
 * A package glob does have a faithful file-glob reading: "every file beneath a
 * directory this pattern selects". These tests pin that translation, and pin
 * that the lossy case that remains (both scopes set, which Claude cannot express
 * as an intersection) still warns.
 *
 * Split from rules.test.ts, which is at 747 of the 800-line limit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _rulesCLIDeps, rulesExportCommand } from "../../../src/cli/rules";

let origWriteFile: typeof _rulesCLIDeps.writeFile;
let origGlobInDir: typeof _rulesCLIDeps.globInDir;
let origMkdir: typeof _rulesCLIDeps.mkdir;
let origLoadCanonicalRules: typeof _rulesCLIDeps.loadCanonicalRules;
let origGetLogger: typeof _rulesCLIDeps.getLogger;

const written: Record<string, string> = {};
let warnings: Array<{ msg: string; data: unknown }> = [];

beforeEach(() => {
  origWriteFile = _rulesCLIDeps.writeFile;
  origGlobInDir = _rulesCLIDeps.globInDir;
  origMkdir = _rulesCLIDeps.mkdir;
  origLoadCanonicalRules = _rulesCLIDeps.loadCanonicalRules;
  origGetLogger = _rulesCLIDeps.getLogger;

  Object.keys(written).forEach((k) => delete written[k]);
  warnings = [];

  _rulesCLIDeps.writeFile = async (path, content) => {
    written[path] = content;
  };
  _rulesCLIDeps.globInDir = () => [];
  _rulesCLIDeps.mkdir = async () => {};
  _rulesCLIDeps.loadCanonicalRules = async () => [];
  _rulesCLIDeps.getLogger = () =>
    ({ warn: (_s: string, msg: string, data: unknown) => warnings.push({ msg, data }) }) as never;
});

afterEach(() => {
  _rulesCLIDeps.writeFile = origWriteFile;
  _rulesCLIDeps.globInDir = origGlobInDir;
  _rulesCLIDeps.mkdir = origMkdir;
  _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRules;
  _rulesCLIDeps.getLogger = origGetLogger;
});

/** Export one rule and return the generated file body. */
async function exportOne(rule: Record<string, unknown>): Promise<string> {
  _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "r.md", content: "Body.", ...rule } as never];
  await rulesExportCommand({ dir: "/project", agent: "claude" });
  return written["/project/.claude/rules/r.md"] ?? "";
}

describe("rules export (claude) — package scope becomes a file glob", () => {
  test.each([
    // [canonical paths:, expected Claude paths:]
    ["packages/nestjs-oauth/*", "packages/nestjs-oauth/**"],
    ["packages/api/**", "packages/api/**"],
    ["apps/web", "apps/web/**"],
    ["packages/*/core", "packages/*/core/**"],
  ])("canonical paths %p exports as Claude glob %p", async (canonical, expected) => {
    const out = await exportOne({ paths: [canonical] });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain(`  - ${JSON.stringify(expected)}`);
  });

  test("a package-scoped rule is no longer emitted without frontmatter", async () => {
    const out = await exportOne({ paths: ["packages/nestjs-oauth/*"] });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("paths:");
  });

  test("translating is not a drop, so nothing warns about lost package scope", async () => {
    await exportOne({ paths: ["packages/nestjs-oauth/*"] });
    expect(warnings.find((w) => w.msg.includes("package scope"))).toBeUndefined();
  });

  test("every canonical path is carried, not just the first", async () => {
    const out = await exportOne({ paths: ["packages/a/*", "packages/b/*"] });
    expect(out).toContain('  - "packages/a/**"');
    expect(out).toContain('  - "packages/b/**"');
  });

  test("nax's own paths: spelling never reaches the generated file", async () => {
    const out = await exportOne({ paths: ["packages/api/*"] });
    expect(out).not.toContain("appliesTo:");
    // Claude reads `paths:`; the canonical key name means nothing to it.
    expect(out.split("---")[1]).toContain("paths:");
  });
});

describe("rules export (claude) — the scopes that cannot be combined", () => {
  /**
   * nax applies `appliesTo` AND `paths` as a conjunction; Claude's single
   * `paths:` list is a disjunction, so emitting both would WIDEN the rule
   * rather than narrow it. The file glob is kept and the package scope is
   * reported instead of being silently unioned in.
   */
  test("keeps the file glob and warns when both scopes are set", async () => {
    const out = await exportOne({ appliesTo: ["src/**/*.ts"], paths: ["packages/api/*"] });
    expect(out).toContain('  - "src/**/*.ts"');
    expect(out).not.toContain("packages/api");

    const w = warnings.find((x) => x.msg.includes("package scope"));
    expect(w).toBeDefined();
    expect(JSON.stringify(w?.data)).toContain("packages/api/*");
  });

  test("an unscoped rule still gets no frontmatter block", async () => {
    const out = await exportOne({});
    expect(out.startsWith("---")).toBe(false);
    expect(out).toContain("Body.");
  });
});

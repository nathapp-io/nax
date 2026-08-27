/**
 * `nax rules export --agent=claude` — US-002 description in Claude frontmatter.
 *
 * US-001 introduced `CanonicalRule.description` and validated it as a single
 * line, non-empty string. US-002 surfaces it on the Claude export: emitted
 * first in the per-rule frontmatter (so an agent prompt sees the description
 * ahead of any scope), serialised through JSON.stringify so that a colon,
 * hash, double quote, or backslash cannot produce YAML Claude fails to
 * parse, and carried into the warning that reports a dropped package scope
 * so the operator knows which rule had its scope widened.
 *
 * Exercised through `rulesExportCommand` — the outermost entry point — so
 * coverage includes the production wiring, not just `claudeFrontmatter` in
 * isolation. Sits beside rules-export-scope.test.ts because the seam and
 * injection harness are the same; splitting keeps each file under the
 * 800-line test limit and lets each describe block read end-to-end.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { _rulesCLIDeps, rulesExportCommand } from "@/cli";
import type { CanonicalRule } from "@/context/rules/rules-frontmatter";

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

  for (const k of Object.keys(written)) delete written[k];
  warnings = [];

  _rulesCLIDeps.writeFile = async (path, content) => {
    written[path] = content;
  };
  _rulesCLIDeps.globInDir = () => [];
  _rulesCLIDeps.mkdir = async () => {};
  _rulesCLIDeps.loadCanonicalRules = async () => [];
  _rulesCLIDeps.getLogger = () => {
    const logger = makeLogger();
    logger.warn = mock((_s: string, msg: string, data: unknown) => warnings.push({ msg, data })) as typeof logger.warn;
    return logger;
  };
});

afterEach(() => {
  _rulesCLIDeps.writeFile = origWriteFile;
  _rulesCLIDeps.globInDir = origGlobInDir;
  _rulesCLIDeps.mkdir = origMkdir;
  _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRules;
  _rulesCLIDeps.getLogger = origGetLogger;
});

/** Export one rule and return the generated file body. */
async function exportOne(rule: Partial<CanonicalRule>): Promise<string> {
  _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "r.md", content: "Body.", ...rule }];
  await rulesExportCommand({ dir: "/project", agent: "claude" });
  return written["/project/.claude/rules/r.md"] ?? "";
}

/** Strip the leading frontmatter block; returns the body the agent will read. */
function bodyAfterFrontmatter(out: string): string {
  // claudeFrontmatter emits `---\n...\n---\n` and then the body. If there is
  // no frontmatter, the input is returned unchanged.
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(out);
  return m ? out.slice(m[0].length) : out;
}

/** Return the YAML block delimited by the FIRST pair of `---` markers. */
function frontmatterBlock(out: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(out);
  return m?.[1] ?? "";
}

describe("rules export (claude) — US-002 description in Claude frontmatter", () => {
  test("[AC1] description appears before paths in the generated frontmatter", async () => {
    const out = await exportOne({ description: "Use when editing OAuth controllers", appliesTo: ["src/**/*.ts"] });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    const descIdx = fm.indexOf("description:");
    const pathsIdx = fm.indexOf("paths:");
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(pathsIdx).toBeGreaterThanOrEqual(0);
    expect(descIdx).toBeLessThan(pathsIdx);
  });

  test("[AC2] description with no scope still emits a frontmatter block, with no paths entry", async () => {
    const out = await exportOne({ description: "Standalone rule" });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    expect(fm).toContain("description:");
    expect(fm).not.toContain("paths:");
    // The body still follows the frontmatter.
    expect(bodyAfterFrontmatter(out)).toContain("Body.");
  });

  test("[AC3] canonical package scope becomes the corresponding file glob next to description", async () => {
    const out = await exportOne({ description: "API-only rule", paths: ["packages/api/*"] });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    expect(fm).toContain("description:");
    expect(fm).toContain('  - "packages/api/**"');
    expect(fm).not.toContain('packages/api/*"');

    // No "dropping package scope" warning — translating is not dropping.
    expect(warnings.find((w) => w.msg.includes("package scope"))).toBeUndefined();
  });

  test("[AC4] neither description nor scope => no frontmatter block at all", async () => {
    const out = await exportOne({});

    expect(out.startsWith("---")).toBe(false);
    // Body still present.
    expect(out).toContain("Body.");
  });

  test("[AC5] description with colon, hash, double quote, and backslash parses as YAML and round-trips exactly", async () => {
    const tricky = 'status: ok # note "quote"\\';
    const out = await exportOne({ description: tricky, appliesTo: ["src/**/*.ts"] });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    expect(fm).toContain(`description: ${JSON.stringify(tricky)}`);

    // The block — the same substring the YAML parser would see — must parse
    // cleanly and yield back the original, unescaped text.
    const parsed = Bun.YAML.parse(fm) as { description?: unknown; paths?: unknown };
    expect(typeof parsed.description).toBe("string");
    expect(parsed.description).toBe(tricky);
    // paths still present alongside description.
    expect(parsed.paths).toEqual(["src/**/*.ts"]);
  });

  test("[AC6] the both-scopes warning carries the rule's description through to its structured data", async () => {
    const description = "Auth-facing controller rules";
    const out = await exportOne({
      description,
      appliesTo: ["src/**/*.ts"],
      paths: ["packages/api/*"],
    });

    // The file keeps appliesTo and drops paths (Claude cannot express both).
    expect(out).toContain('  - "src/**/*.ts"');
    expect(out).not.toContain("packages/api");

    const w = warnings.find((x) => x.msg.includes("package scope"));
    expect(w).toBeDefined();
    const payload = JSON.stringify(w?.data);
    expect(payload).toContain(`"description":${JSON.stringify(description)}`);
  });

  test("[AC7] a rule with appliesTo but no description emits no description entry", async () => {
    const out = await exportOne({ appliesTo: ["src/**/*.ts"] });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    expect(fm).not.toContain("description:");
    expect(fm).toContain("paths:");
    expect(fm).toContain('  - "src/**/*.ts"');
  });
});

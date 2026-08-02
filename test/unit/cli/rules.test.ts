/**
 * rules.ts CLI commands — unit tests
 *
 * Covers neutralizeContent, rulesExportCommand, and rulesMigrateCommand.
 * Filesystem calls are intercepted via _rulesCLIDeps injection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { lintForNeutrality } from "../../../src/context/rules/canonical-loader";
import { withTempDir } from "@test/helpers";
import {
  neutralizeContent,
  rulesExportCommand,
  rulesLintCommand,
  rulesMigrateCommand,
  translateLegacyFrontmatter,
  withReviewNotice,
  _rulesCLIDeps,
} from "../../../src/cli/rules";

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let origReadFile: typeof _rulesCLIDeps.readFile;
let origWriteFile: typeof _rulesCLIDeps.writeFile;
let origFileExists: typeof _rulesCLIDeps.fileExists;
let origGlobInDir: typeof _rulesCLIDeps.globInDir;
let origGlobCanonicalRuleFiles: typeof _rulesCLIDeps.globCanonicalRuleFiles;
let origMkdir: typeof _rulesCLIDeps.mkdir;
let origLoadCanonicalRules: typeof _rulesCLIDeps.loadCanonicalRules;

const written: Record<string, string> = {};

beforeEach(() => {
  origReadFile = _rulesCLIDeps.readFile;
  origWriteFile = _rulesCLIDeps.writeFile;
  origFileExists = _rulesCLIDeps.fileExists;
  origGlobInDir = _rulesCLIDeps.globInDir;
  origGlobCanonicalRuleFiles = _rulesCLIDeps.globCanonicalRuleFiles;
  origMkdir = _rulesCLIDeps.mkdir;
  origLoadCanonicalRules = _rulesCLIDeps.loadCanonicalRules;

  Object.keys(written).forEach((k) => delete written[k]);

  _rulesCLIDeps.readFile = async () => "";
  _rulesCLIDeps.writeFile = async (path, content) => { written[path] = content; };
  _rulesCLIDeps.fileExists = async () => false;
  _rulesCLIDeps.globInDir = () => [];
  _rulesCLIDeps.globCanonicalRuleFiles = () => [];
  _rulesCLIDeps.mkdir = async () => {};
  _rulesCLIDeps.loadCanonicalRules = async () => [];
});

afterEach(() => {
  _rulesCLIDeps.readFile = origReadFile;
  _rulesCLIDeps.writeFile = origWriteFile;
  _rulesCLIDeps.fileExists = origFileExists;
  _rulesCLIDeps.globInDir = origGlobInDir;
  _rulesCLIDeps.globCanonicalRuleFiles = origGlobCanonicalRuleFiles;
  _rulesCLIDeps.mkdir = origMkdir;
  _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRules;
});

// ─────────────────────────────────────────────────────────────────────────────
// neutralizeContent
// ─────────────────────────────────────────────────────────────────────────────

describe("neutralizeContent", () => {
  test("removes system-reminder tags, replaces tool-name phrasing, and handles multiple tool names", () => {
    const r1 = neutralizeContent("<system-reminder>Do this.</system-reminder>\n\nKeep this.");
    expect(r1.content).not.toContain("system-reminder");
    expect(r1.content).toContain("Keep this.");

    const r2 = neutralizeContent("Use the Grep tool to search.");
    expect(r2.content).not.toContain("the Grep tool");
    expect(r2.content).toContain("the Grep capability");
    expect(r2.replacements).toBeGreaterThan(0);

    const r3 = neutralizeContent("Call the TodoWrite tool and the WebFetch tool.");
    expect(r3.content).not.toContain("the TodoWrite tool");
    expect(r3.content).not.toContain("the WebFetch tool");
    expect(r3.content).toContain("TodoWrite capability");
    expect(r3.content).toContain("WebFetch capability");
  });

  test("replaces CLAUDE.md references and .claude/ directory references", () => {
    const r1 = neutralizeContent("See CLAUDE.md for details.");
    expect(r1.content).not.toContain("CLAUDE.md");
    expect(r1.content).toContain("project conventions");

    const r2 = neutralizeContent("Rules live in .claude/rules/.");
    expect(r2.content).not.toContain(".claude/");
    expect(r2.content).toContain(".nax/rules/");
  });

  test("replaces IMPORTANT: with Note: and strips emoji", () => {
    const r1 = neutralizeContent("IMPORTANT: Never mutate.");
    expect(r1.content).not.toContain("IMPORTANT:");
    expect(r1.content).toContain("Note:");

    const r2 = neutralizeContent("Write tests 🎯 always.");
    expect(r2.content).not.toContain("🎯");
    expect(r2.content).toContain("Write tests");
  });

  test("returns zero replacements for clean content, counts occurrences not pattern hits, and trims whitespace", () => {
    expect(neutralizeContent("## Style\n\nUse async/await.").replacements).toBe(0);
    expect(neutralizeContent("IMPORTANT: one.\nIMPORTANT: two.\nIMPORTANT: three.").replacements).toBe(3);
    const { content } = neutralizeContent("\n\n## Style\n\nContent.\n\n");
    expect(content.startsWith("\n")).toBe(false);
    expect(content.endsWith("\n")).toBe(false);
  });

  test("round-trips clean against the lint table for every banned pattern (migrate<->lint parity)", () => {
    // Previously neutralizeContent and the linter's BANNED_PATTERNS were two
    // independent tables that had drifted: migrate never touched AGENTS.md /
    // GEMINI.md / .codex/ / .gemini/ / <ide_diagnostics>, and its tool-phrasing
    // match was case-sensitive on the first letter while the linter's was not
    // — so migrated content could still fail `nax rules lint`. Both now read
    // from the same NEUTRALITY_RULES table, so this must produce zero
    // violations for every pattern the linter checks.
    const dirty = [
      "<system-reminder>internal</system-reminder>",
      "<ide_diagnostics>errors</ide_diagnostics>",
      "See CLAUDE.md, AGENTS.md, and GEMINI.md.",
      "Rules live in .claude/, .codex/, and .gemini/.",
      "use the grep tool to search (lowercase, was previously missed)",
      "IMPORTANT: read this.",
      "Ship it 🚀",
    ].join("\n");

    const { content, replacements } = neutralizeContent(dirty);
    expect(replacements).toBeGreaterThan(0);
    expect(lintForNeutrality(content, "test.md")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rulesExportCommand
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesExportCommand", () => {
  test("throws NaxError for unsupported agent", async () => {
    let threw: unknown;
    try {
      await rulesExportCommand({ agent: "unknown-agent" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("RULES_EXPORT_UNSUPPORTED_AGENT");
  });

  test("throws NaxError when canonical store is empty", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [];
    let threw: unknown;
    try {
      await rulesExportCommand({ agent: "claude" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("RULES_EXPORT_NO_CANONICAL_RULES");
  });

  test.each([
    ["claude", "/project/CLAUDE.md"],
    ["codex", "/project/AGENTS.md"],
  ] as const)("writes correct shim file for agent=%s", async (agent, expectedPath) => {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "style.md", content: "## Style\n\nContent." },
    ];
    await rulesExportCommand({ dir: "/project", agent });
    expect(expectedPath in written).toBe(true);
  });

  test("shim content includes auto-generated header and all canonical rule files", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "style.md", content: "Style content." },
      { fileName: "testing.md", content: "Testing content." },
    ];
    await rulesExportCommand({ dir: "/project", agent: "claude" });
    const content = written["/project/CLAUDE.md"]!;
    expect(content).toContain("AUTO-GENERATED");
    expect(content).toContain(".nax/rules/");
    expect(content).toContain("Style content.");
    expect(content).toContain("Testing content.");
  });

  test("dry run does not write any files", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "style.md", content: "## Style\n\nContent." },
    ];
    await rulesExportCommand({ dir: "/project", agent: "claude", dryRun: true });
    expect(Object.keys(written)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rulesMigrateCommand
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesMigrateCommand", () => {
  test("does nothing when no source files found", async () => {
    await rulesMigrateCommand({ dir: "/project" });
    expect(Object.keys(written)).toHaveLength(0);
  });

  test("migrates CLAUDE.md to project-conventions.md", async () => {
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nUse async/await.";
    await rulesMigrateCommand({ dir: "/project" });
    expect("/project/.nax/rules/project-conventions.md" in written).toBe(true);
  });

  test("migrates .claude/rules/*.md to same file name in .nax/rules/", async () => {
    _rulesCLIDeps.fileExists = async () => false;
    _rulesCLIDeps.globInDir = (dir) => {
      if (dir.includes(".claude/rules")) return ["/project/.claude/rules/testing.md"];
      return [];
    };
    _rulesCLIDeps.readFile = async () => "## Testing\n\nWrite tests first.";
    await rulesMigrateCommand({ dir: "/project" });
    expect("/project/.nax/rules/testing.md" in written).toBe(true);
  });

  test.each([
    [false, false],
    [true, true],
  ] as const)("force=%s: existing file written=%s", async (force, expectedWritten) => {
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md" || p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project", ...(force ? { force } : {}) });
    expect("/project/.nax/rules/project-conventions.md" in written).toBe(expectedWritten);
  });

  test("applies neutralization during migration", async () => {
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md";
    _rulesCLIDeps.readFile = async () => "See CLAUDE.md. IMPORTANT: do this. 🎯";
    await rulesMigrateCommand({ dir: "/project" });
    const content = written["/project/.nax/rules/project-conventions.md"]!;
    expect(content).not.toContain("CLAUDE.md");
    expect(content).not.toContain("IMPORTANT:");
    expect(content).not.toContain("🎯");
  });

  test("includes neutralization notice when replacements were made and creates .nax/rules/ directory", async () => {
    const createdDirs: string[] = [];
    _rulesCLIDeps.mkdir = async (dir) => { createdDirs.push(dir); };
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md";
    _rulesCLIDeps.readFile = async () => "IMPORTANT: do this.";
    await rulesMigrateCommand({ dir: "/project" });
    const content = written["/project/.nax/rules/project-conventions.md"]!;
    expect(content).toContain("neutralization");
    expect(createdDirs.some((d) => d.includes(".nax/rules"))).toBe(true);
  });

  test("dry run does not write any files", async () => {
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project", dryRun: true });
    expect(Object.keys(written)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rulesLintCommand
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesLintCommand", () => {
  test("lints repo root when no package overlays are present", async () => {
    const calls: string[] = [];
    _rulesCLIDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      return [];
    };
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];

    await rulesLintCommand({ dir: "/project" });

    expect(calls).toEqual(["/project"]);
  });

  test("lints package overlays discovered from nested canonical rule paths", async () => {
    const calls: string[] = [];
    _rulesCLIDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      return [];
    };
    _rulesCLIDeps.globCanonicalRuleFiles = () => [
      ".nax/rules/root.md",
      "packages/api/.nax/rules/api.md",
      "packages/web/.nax/rules/web.md",
    ];

    await rulesLintCommand({ dir: "/repo" });

    expect(calls).toContain("/repo");
    expect(calls).toContain("/repo/packages/api");
    expect(calls).toContain("/repo/packages/web");
  });

  test("end-to-end: real glob discovery feeds package-overlay roots into loadCanonicalRules", async () => {
    // Uses the REAL (unstubbed) globCanonicalRuleFiles against a real temp
    // dir, so this fails if the dot:true fix regresses — unlike the two
    // tests above, which stub the glob and so can't detect that class of bug.
    _rulesCLIDeps.globCanonicalRuleFiles = origGlobCanonicalRuleFiles;
    const calls: string[] = [];
    _rulesCLIDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      return [];
    };

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      await mkdir(join(workdir, "packages", "api", ".nax", "rules"), { recursive: true });
      await Bun.write(join(workdir, ".nax", "rules", "root.md"), "# root\n");
      await Bun.write(join(workdir, "packages", "api", ".nax", "rules", "api.md"), "# api\n");

      await rulesLintCommand({ dir: workdir });

      expect(calls).toContain(workdir);
      expect(calls).toContain(join(workdir, "packages", "api"));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// globCanonicalRuleFiles (real implementation)
// ─────────────────────────────────────────────────────────────────────────────

describe("globCanonicalRuleFiles", () => {
  test("finds hidden .nax/rules dirs (dot:true)", async () => {
    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      await mkdir(join(workdir, "packages", "api", ".nax", "rules"), { recursive: true });
      await Bun.write(join(workdir, ".nax", "rules", "root.md"), "# root\n");
      await Bun.write(join(workdir, "packages", "api", ".nax", "rules", "api.md"), "# api\n");

      const found = origGlobCanonicalRuleFiles(workdir);

      expect(found).toContain(".nax/rules/root.md");
      expect(found).toContain("packages/api/.nax/rules/api.md");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy `paths:` → `appliesTo:` translation
// ─────────────────────────────────────────────────────────────────────────────

describe("translateLegacyFrontmatter", () => {
  test("rewrites a legacy `paths:` block to `appliesTo:`", () => {
    // In tool-session rule files `paths:` is a FILE glob. In nax it is PACKAGE
    // scope, and `ruleMatchesPackage` returns true unconditionally when
    // packageDir === repoRoot — so copying it verbatim into a single-package
    // repo yields config that looks scoped and does nothing.
    const src = ['---', 'paths:', '  - "test/**/*.test.ts"', '---', '', '# Test Architecture', ''].join("\n");
    const { content, translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(true);
    expect(content).toContain("appliesTo:");
    expect(content).not.toContain("paths:");
    expect(content).toContain('- "test/**/*.test.ts"');
    expect(content).toContain("# Test Architecture");
  });

  test("preserves a multi-entry glob list verbatim", () => {
    const src = ['---', 'paths:', '  - "src/agents/**/*.ts"', '  - "src/operations/**/*.ts"', '---', '', 'body'].join("\n");
    const { content } = translateLegacyFrontmatter(src);
    expect(content).toContain('  - "src/agents/**/*.ts"');
    expect(content).toContain('  - "src/operations/**/*.ts"');
  });

  test("keeps other frontmatter keys untouched", () => {
    const src = ['---', 'priority: 40', 'paths:', '  - "src/**"', '---', '', 'body'].join("\n");
    const { content } = translateLegacyFrontmatter(src);
    expect(content).toContain("priority: 40");
    expect(content).toContain("appliesTo:");
  });

  test("is a no-op when there is no frontmatter", () => {
    const src = "# Just a heading\n\nbody\n";
    const { content, translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(false);
    expect(content).toBe(src);
  });

  test("is a no-op when the file has no `paths:` key", () => {
    const src = ['---', 'priority: 50', '---', '', 'body'].join("\n");
    const { translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(false);
  });

  test("does not translate when `appliesTo:` is already present", () => {
    // Re-running migrate must not produce two competing scope keys.
    const src = ['---', 'appliesTo:', '  - "src/**"', 'paths:', '  - "apps/api/*"', '---', '', 'body'].join("\n");
    const { content, translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(false);
    expect(content).toBe(src);
  });

  test("ignores a `paths:` that appears in the body rather than the frontmatter", () => {
    const src = "# Rule\n\nSet `paths:` in frontmatter to scope a rule.\n";
    const { translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(false);
  });
});

describe("rulesMigrateCommand — legacy scope translation", () => {
  test("migrated rules carry appliesTo, never an inert paths block", async () => {
    _rulesCLIDeps.globInDir = () => ["/repo/.claude/rules/test-architecture.md"];
    _rulesCLIDeps.fileExists = async (p: string) => p.startsWith("/repo/.claude/");
    _rulesCLIDeps.readFile = async () =>
      ['---', 'paths:', '  - "test/**/*.test.ts"', '---', '', '# Test Architecture', ''].join("\n");

    await rulesMigrateCommand({ dir: "/repo" });

    const out = written["/repo/.nax/rules/test-architecture.md"];
    expect(out).toBeDefined();
    expect(out).toContain("appliesTo:");
    expect(out).not.toMatch(/^paths:/m);
  });
});

describe("withReviewNotice", () => {
  test("places the notice after frontmatter so the block stays at byte 0", () => {
    // Frontmatter is only recognised at the start of the file. A notice emitted
    // first pushes it out of position and the scope key is silently ignored —
    // which hits every rule that both needed neutralizing and carried a scope.
    const src = ['---', 'appliesTo:', '  - "src/**"', '---', '', '# Body'].join("\n");
    const out = withReviewNotice(src, 3);
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("<!-- NOTE: 3 neutralization(s)");
    expect(out.indexOf("appliesTo:")).toBeLessThan(out.indexOf("<!-- NOTE:"));
    expect(/^---\n[\s\S]*?\n---\n/.test(out)).toBe(true);
  });

  test("prepends normally when there is no frontmatter", () => {
    const out = withReviewNotice("# Body\n", 2);
    expect(out.startsWith("<!-- NOTE: 2 neutralization(s)")).toBe(true);
  });

  test("adds nothing when no replacements were made", () => {
    expect(withReviewNotice("# Body\n", 0)).toBe("# Body\n");
  });

  test("a translated scope survives neutralization end to end", async () => {
    // The regression that motivates both fixes: paths -> appliesTo is useless
    // if the notice then knocks the frontmatter out of parse position.
    _rulesCLIDeps.globInDir = () => ["/repo/.claude/rules/retry-strategy.md"];
    _rulesCLIDeps.fileExists = async (p: string) => p.startsWith("/repo/.claude/");
    _rulesCLIDeps.readFile = async () =>
      ['---', 'paths:', '  - "src/agents/**/*.ts"', '---', '', '# Retry', '', 'See CLAUDE.md for more.'].join("\n");

    await rulesMigrateCommand({ dir: "/repo" });

    const out = written["/repo/.nax/rules/retry-strategy.md"];
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("appliesTo:");
    expect(out).toContain("<!-- NOTE:");
    expect(/^---\n[\s\S]*?\n---\n/.test(out)).toBe(true);
  });
});

/**
 * rules-migrate.ts — unit tests
 *
 * Covers rulesMigrateCommand plus the two pure helpers that exist only to feed
 * it: translateLegacyFrontmatter and withReviewNotice. Split out of
 * rules.test.ts, which breached the 800-line test-file limit once the
 * CLAUDE.md-collision regression coverage landed. neutralizeContent stays in
 * rules.test.ts — its tests assert against the shared NEUTRALITY_RULES table
 * via lintForNeutrality, so it belongs with the canonical-loader coverage.
 *
 * Filesystem calls are intercepted via _rulesCLIDeps injection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import {
  _rulesCLIDeps,
  type MigrationOutcome,
  rulesMigrateCommand,
  translateLegacyFrontmatter,
  withReviewNotice,
} from "@/cli";

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
let origGetLogger: typeof _rulesCLIDeps.getLogger;

const written: Record<string, string> = {};

beforeEach(() => {
  origReadFile = _rulesCLIDeps.readFile;
  origWriteFile = _rulesCLIDeps.writeFile;
  origFileExists = _rulesCLIDeps.fileExists;
  origGlobInDir = _rulesCLIDeps.globInDir;
  origGlobCanonicalRuleFiles = _rulesCLIDeps.globCanonicalRuleFiles;
  origMkdir = _rulesCLIDeps.mkdir;
  origLoadCanonicalRules = _rulesCLIDeps.loadCanonicalRules;
  origGetLogger = _rulesCLIDeps.getLogger;

  for (const k of Object.keys(written)) delete written[k];

  _rulesCLIDeps.readFile = async () => "";
  _rulesCLIDeps.writeFile = async (path, content) => {
    written[path] = content;
  };
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
  _rulesCLIDeps.getLogger = origGetLogger;
});

// ─────────────────────────────────────────────────────────────────────────────
// rulesMigrateCommand
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesMigrateCommand", () => {
  test("does nothing when no source files found", async () => {
    await rulesMigrateCommand({ dir: "/project" });
    expect(Object.keys(written)).toHaveLength(0);
  });

  test("CLAUDE.md alone is not a migration source — nothing is written", async () => {
    // CLAUDE.md was dropped as a migration source entirely: it and
    // .claude/rules/project-conventions.md both targeted the same basename,
    // and planMigration resolved fileExists for both BEFORE either write —
    // so the second write silently clobbered the first. .claude/rules/*.md
    // is now the only source, which removes the collision at its root. A
    // repo with only CLAUDE.md and no .claude/rules/ now has nothing to
    // migrate.
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nUse async/await.";

    const lines: string[] = [];
    const origConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    let outcome: MigrationOutcome;
    try {
      outcome = await rulesMigrateCommand({ dir: "/project" });
    } finally {
      console.log = origConsoleLog;
    }

    expect(Object.keys(written)).toHaveLength(0);
    expect(outcome).toEqual({ written: [], skipped: [] });
    // The operator is looking at a CLAUDE.md that used to migrate, so "no source
    // files found" on its own reads as a bug. The boundary must be named.
    expect(lines.join("\n")).toContain("Root CLAUDE.md is not a migration source");
  });

  test("regression: root CLAUDE.md and .claude/rules/project-conventions.md never both target the same file", async () => {
    // Real-fs repro of the original defect: both sources mapped to the same
    // target basename. planMigration resolved fileExists for BOTH sources
    // before either write, so with an empty .nax/rules/ both became writes
    // to the identical path — the second write clobbered the first, and the
    // CLI reported 2 file(s) written when only 1 file existed on disk.
    _rulesCLIDeps.fileExists = origFileExists;
    _rulesCLIDeps.readFile = origReadFile;
    _rulesCLIDeps.writeFile = origWriteFile;
    _rulesCLIDeps.globInDir = origGlobInDir;
    _rulesCLIDeps.mkdir = origMkdir;

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".claude", "rules"), { recursive: true });
      await Bun.write(join(workdir, "CLAUDE.md"), "# Root marker — must NOT survive migration.\n");
      await Bun.write(
        join(workdir, ".claude", "rules", "project-conventions.md"),
        "# Rules-dir marker — must be the ONLY source.\n",
      );

      const outcome = await rulesMigrateCommand({ dir: workdir });

      const occurrences = outcome.written.filter((f) => f === "project-conventions.md");
      expect(occurrences).toHaveLength(1);

      const targetPath = join(workdir, ".nax", "rules", "project-conventions.md");
      const content = await Bun.file(targetPath).text();
      expect(content).toContain("Rules-dir marker");
      expect(content).not.toContain("Root marker");

      const filesOnDisk = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: join(workdir, ".nax", "rules") }));
      expect(filesOnDisk).toEqual(["project-conventions.md"]);
    });
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
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project", ...(force ? { force } : {}) });
    expect("/project/.nax/rules/project-conventions.md" in written).toBe(expectedWritten);
  });

  test("applies neutralization during migration", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.readFile = async () => "See CLAUDE.md. IMPORTANT: do this. 🎯";
    await rulesMigrateCommand({ dir: "/project" });
    const content = written["/project/.nax/rules/project-conventions.md"];
    assertDefined(content, "written[/project/.nax/rules/project-conventions.md]");
    expect(content).not.toContain("CLAUDE.md");
    expect(content).not.toContain("IMPORTANT:");
    expect(content).not.toContain("🎯");
  });

  test("includes neutralization notice when replacements were made and creates .nax/rules/ directory", async () => {
    const createdDirs: string[] = [];
    _rulesCLIDeps.mkdir = async (dir) => {
      createdDirs.push(dir);
    };
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.readFile = async () => "IMPORTANT: do this.";
    await rulesMigrateCommand({ dir: "/project" });
    const content = written["/project/.nax/rules/project-conventions.md"];
    assertDefined(content, "written[/project/.nax/rules/project-conventions.md]");
    expect(content).toContain("neutralization");
    expect(createdDirs.some((d) => d.includes(".nax/rules"))).toBe(true);
  });

  test("dry run does not write any files", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project", dryRun: true });
    expect(Object.keys(written)).toHaveLength(0);
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
    const src = ["---", "paths:", '  - "test/**/*.test.ts"', "---", "", "# Test Architecture", ""].join("\n");
    const { content, translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(true);
    expect(content).toContain("appliesTo:");
    expect(content).not.toContain("paths:");
    expect(content).toContain('- "test/**/*.test.ts"');
    expect(content).toContain("# Test Architecture");
  });

  test("preserves a multi-entry glob list verbatim", () => {
    const src = ["---", "paths:", '  - "src/agents/**/*.ts"', '  - "src/operations/**/*.ts"', "---", "", "body"].join(
      "\n",
    );
    const { content } = translateLegacyFrontmatter(src);
    expect(content).toContain('  - "src/agents/**/*.ts"');
    expect(content).toContain('  - "src/operations/**/*.ts"');
  });

  test("keeps other frontmatter keys untouched", () => {
    const src = ["---", "priority: 40", "paths:", '  - "src/**"', "---", "", "body"].join("\n");
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
    const src = ["---", "priority: 50", "---", "", "body"].join("\n");
    const { translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(false);
  });

  test("does not translate when `appliesTo:` is already present", () => {
    // Re-running migrate must not produce two competing scope keys.
    const src = ["---", "appliesTo:", '  - "src/**"', "paths:", '  - "apps/api/*"', "---", "", "body"].join("\n");
    const { content, translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(false);
    expect(content).toBe(src);
  });

  test("ignores a `paths:` that appears in the body rather than the frontmatter", () => {
    const src = "# Rule\n\nSet `paths:` in frontmatter to scope a rule.\n";
    const { translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(false);
  });

  test("rewrites a legacy `paths:` block using CRLF line endings", () => {
    const src = ["---", "paths:", '  - "test/**/*.test.ts"', "---", "", "# Test Architecture", ""].join("\r\n");
    const { content, translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(true);
    expect(content).toContain("appliesTo:");
    expect(content).not.toContain("paths:");
    expect(content.startsWith("---\r\n")).toBe(true);
  });

  test("wraps a scalar `paths:` value into a single-element appliesTo list", () => {
    // `paths` accepts a bare scalar (canonical-loader.ts); `appliesTo` only accepts a
    // list (spec AC US-004.2). A verbatim key rename would migrate a scalar `paths:`
    // into a scalar `appliesTo:` that loadCanonicalRules rejects as malformed.
    const src = ["---", 'paths: "src/agents/**/*.ts"', "---", "", "body"].join("\n");
    const { content, translated } = translateLegacyFrontmatter(src);
    expect(translated).toBe(true);
    expect(content).toContain('appliesTo: ["src/agents/**/*.ts"]');
    expect(content).not.toContain("paths:");
  });

  test("wraps an unquoted scalar `paths:` value without producing a YAML alias", () => {
    // An unquoted flow-sequence element starting with `*` (e.g. `[**/*.ts]`) parses as
    // a YAML alias reference, not a glob string — the wrapper must always quote.
    const src = ["---", "paths: **/*.ts", "---", "", "body"].join("\n");
    const { content } = translateLegacyFrontmatter(src);
    expect(content).toContain('appliesTo: ["**/*.ts"]');
  });

  test("leaves an inline `paths: [...]` list as a plain key rename", () => {
    const src = ["---", 'paths: ["src/**", "apps/**"]', "---", "", "body"].join("\n");
    const { content } = translateLegacyFrontmatter(src);
    expect(content).toContain('appliesTo: ["src/**", "apps/**"]');
  });
});

describe("rulesMigrateCommand — legacy scope translation", () => {
  test("migrated rules carry appliesTo, never an inert paths block", async () => {
    _rulesCLIDeps.globInDir = () => ["/repo/.claude/rules/test-architecture.md"];
    _rulesCLIDeps.fileExists = async (p: string) => p.startsWith("/repo/.claude/");
    _rulesCLIDeps.readFile = async () =>
      ["---", "paths:", '  - "test/**/*.test.ts"', "---", "", "# Test Architecture", ""].join("\n");

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
    const src = ["---", "appliesTo:", '  - "src/**"', "---", "", "# Body"].join("\n");
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
      ["---", "paths:", '  - "src/agents/**/*.ts"', "---", "", "# Retry", "", "See CLAUDE.md for more."].join("\n");

    await rulesMigrateCommand({ dir: "/repo" });

    const out = written["/repo/.nax/rules/retry-strategy.md"];
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("appliesTo:");
    expect(out).toContain("<!-- NOTE:");
    expect(/^---\n[\s\S]*?\n---\n/.test(out)).toBe(true);
  });

  test("a CRLF-authored legacy rule keeps its translated scope readable after neutralization", async () => {
    // Regression: translateLegacyFrontmatter/withReviewNotice previously only
    // recognised LF frontmatter delimiters, so a CRLF-authored source file
    // skipped translation and then had the notice pushed in front of the
    // still-untouched block, losing the scope on read-back.
    _rulesCLIDeps.globInDir = () => ["/repo/.claude/rules/crlf-rule.md"];
    _rulesCLIDeps.fileExists = async (p: string) => p.startsWith("/repo/.claude/");
    _rulesCLIDeps.readFile = async () =>
      ["---", "paths:", '  - "src/agents/**/*.ts"', "---", "", "# CRLF Rule", "", "IMPORTANT: see CLAUDE.md."].join(
        "\r\n",
      );

    await rulesMigrateCommand({ dir: "/repo" });

    const out = written["/repo/.nax/rules/crlf-rule.md"];
    expect(out).toContain("appliesTo:");
    expect(out).toContain("<!-- NOTE:");
    expect(/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(out)).toBe(true);
  });
});

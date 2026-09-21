/**
 * rules.ts CLI commands — unit tests
 *
 * Covers neutralizeContent, rulesExportCommand, rulesLintCommand, and
 * globCanonicalRuleFiles, plus the rulesMigrateCommand dry-run/prod parity
 * (AC-7..AC-14) and the US-001 AC9 description migrate-then-load round-trip.
 * Filesystem calls are intercepted via _rulesCLIDeps injection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, assertNaxError, makeLogger, withTempDir } from "@test/helpers";
import {
  _rulesCLIDeps,
  type MigrationOutcome,
  neutralizeContent,
  rulesExportCommand,
  rulesLintCommand,
  rulesMigrateCommand,
  translateLegacyFrontmatter,
} from "@/cli/rules";
import { lintForNeutrality } from "@/context/rules/canonical-loader";

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
    assertNaxError(threw);
    expect(threw.code).toBe("RULES_EXPORT_UNSUPPORTED_AGENT");
  });

  test("throws NaxError when canonical store is empty", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [];
    let threw: unknown;
    try {
      await rulesExportCommand({ agent: "claude" });
    } catch (e) {
      threw = e;
    }
    assertNaxError(threw);
    expect(threw.code).toBe("RULES_EXPORT_NO_CANONICAL_RULES");
  });

  test.each([
    ["claude", "/project/.claude/rules/style.md"],
    ["codex", "/project/AGENTS.md"],
  ] as const)("writes correct target for agent=%s", async (agent, expectedPath) => {
    _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "style.md", content: "## Style\n\nContent." }];
    await rulesExportCommand({ dir: "/project", agent });
    expect(expectedPath in written).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Issue #1442 — CLAUDE.md is the wrong target for rules. Claude Code reads
  // .claude/rules/*.md natively and path-scopes them; CLAUDE.md is the CONTEXT
  // file that `nax generate` owns. Exporting rules into it made the two
  // generators clobber each other and collapsed the context/rules distinction.
  // ───────────────────────────────────────────────────────────────────────────

  describe("agent=claude writes a rules DIRECTORY", () => {
    test("writes one file per canonical rule, never CLAUDE.md", async () => {
      _rulesCLIDeps.loadCanonicalRules = async () => [
        { fileName: "style.md", content: "Body A." },
        { fileName: "testing.md", content: "Body B." },
      ];
      await rulesExportCommand({ dir: "/project", agent: "claude" });

      expect(Object.keys(written).sort()).toEqual([
        "/project/.claude/rules/style.md",
        "/project/.claude/rules/testing.md",
      ]);
      expect("/project/CLAUDE.md" in written).toBe(false);
    });

    test("mirrors nested relative paths so basenames cannot collide", async () => {
      _rulesCLIDeps.loadCanonicalRules = async () => [
        { fileName: "style.md", path: "frontend/style.md", content: "FE." },
        { fileName: "style.md", path: "backend/style.md", content: "BE." },
      ];
      await rulesExportCommand({ dir: "/project", agent: "claude" });

      expect(Object.keys(written).sort()).toEqual([
        "/project/.claude/rules/backend/style.md",
        "/project/.claude/rules/frontend/style.md",
      ]);
    });

    test("translates canonical appliesTo: into Claude's paths: file glob", async () => {
      _rulesCLIDeps.loadCanonicalRules = async () => [
        { fileName: "t.md", content: "Body.", appliesTo: ["test/**/*.test.ts"], priority: 100 },
      ];
      await rulesExportCommand({ dir: "/project", agent: "claude" });

      const out = written["/project/.claude/rules/t.md"] ?? "";
      expect(out).toContain("paths:");
      expect(out).toContain('"test/**/*.test.ts"');
      // nax's own appliesTo: spelling means nothing to Claude Code.
      expect(out).not.toContain("appliesTo:");
    });

    // The exact bug withReviewNotice exists to fix, in the opposite direction:
    // frontmatter is only recognised at byte 0, so an HTML-comment header
    // emitted FIRST pushes it out of position and the scoping silently dies.
    test("keeps frontmatter at byte 0 with the generated-header comment below it", async () => {
      _rulesCLIDeps.loadCanonicalRules = async () => [
        { fileName: "t.md", content: "Body.", appliesTo: ["src/**/*.ts"] },
      ];
      await rulesExportCommand({ dir: "/project", agent: "claude" });

      const out = written["/project/.claude/rules/t.md"] ?? "";
      expect(out.startsWith("---\n")).toBe(true);
      const fmEnd = out.indexOf("\n---\n") + 5;
      expect(out.indexOf("AUTO-GENERATED")).toBeGreaterThan(fmEnd);
    });

    test("emits no frontmatter block for an unscoped rule", async () => {
      _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "g.md", content: "Global." }];
      await rulesExportCommand({ dir: "/project", agent: "claude" });

      const out = written["/project/.claude/rules/g.md"] ?? "";
      expect(out.startsWith("---")).toBe(false);
      expect(out).toContain("AUTO-GENERATED");
      expect(out).toContain("Global.");
    });
  });

  // Package scope used to be dropped here (warned about, but dropped), which
  // left the rule with no frontmatter at all and therefore globally loaded.
  // It is now carried across as the equivalent file glob. The lossy case that
  // remains — both scopes set, which Claude cannot express as an intersection —
  // is covered in rules-export-scope.test.ts.
  test("carries canonical package scope across instead of widening the rule", async () => {
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger;
    _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "pkg.md", content: "Body.", paths: ["apps/api/**"] }];

    await rulesExportCommand({ dir: "/project", agent: "claude" });

    const out = written["/project/.claude/rules/pkg.md"] ?? "";
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain('  - "apps/api/**"');
    expect(logger.calls.find((c) => c.level === "warn" && c.message.includes("package scope"))).toBeUndefined();
  });

  test("warns about a generated rule file with no canonical source", async () => {
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger;
    _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "a.md", content: "Body." }];
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/orphan.md"];

    await rulesExportCommand({ dir: "/project", agent: "claude" });

    expect(logger.calls.some((c) => c.level === "warn" && c.message.includes("no canonical source"))).toBe(true);
  });

  test("rejects a rule path that escapes the rules directory", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "x.md", path: "../../escape.md", content: "Body." }];
    let threw: unknown;
    try {
      await rulesExportCommand({ dir: "/project", agent: "claude" });
    } catch (e) {
      threw = e;
    }
    assertNaxError(threw);
    expect(threw.code).toBe("RULES_EXPORT_PATH_ESCAPE");
  });

  // The design's Risks section mandates this: it is the single test pinning the
  // two translations against each other, so neither side can drift alone.
  test("round-trip: a Claude paths: rule survives migrate -> canonical -> export", async () => {
    const original = '---\npaths:\n  - "test/**/*.test.ts"\n---\nRule body.\n';
    const { content: canonical } = translateLegacyFrontmatter(original);
    expect(canonical).toContain("appliesTo:");

    // Feed the migrated form back through the loader's own parse, then export.
    const globs = [...canonical.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "t.md", content: "Rule body.", appliesTo: globs as string[] },
    ];
    await rulesExportCommand({ dir: "/project", agent: "claude" });

    const out = written["/project/.claude/rules/t.md"] ?? "";
    expect(out.startsWith("---")).toBe(true);
    expect(out).toContain("paths:");
    expect(out).toContain('"test/**/*.test.ts"');
  });

  describe("--check drift detection", () => {
    test("resolves silently when the generated output matches what is on disk", async () => {
      _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "a.md", content: "Body." }];
      // Prime disk with exactly what export would write.
      await rulesExportCommand({ dir: "/project", agent: "claude" });
      const onDisk = { ...written };
      _rulesCLIDeps.readFile = async (path: string) => onDisk[path] ?? "";

      await rulesExportCommand({ dir: "/project", agent: "claude", check: true });
      // No throw = no drift.
    });

    test("throws RULES_EXPORT_DRIFT naming each stale file", async () => {
      _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "a.md", content: "NEW body." }];
      _rulesCLIDeps.readFile = async () => "stale content";

      let threw: unknown;
      try {
        await rulesExportCommand({ dir: "/project", agent: "claude", check: true });
      } catch (e) {
        threw = e;
      }
      assertNaxError(threw);
      expect(threw.code).toBe("RULES_EXPORT_DRIFT");
      expect(threw.message).toContain("a.md");
    });

    test("--check writes nothing", async () => {
      _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "a.md", content: "Body." }];
      _rulesCLIDeps.readFile = async () => "stale";
      const before = Object.keys(written).length;
      try {
        await rulesExportCommand({ dir: "/project", agent: "claude", check: true });
      } catch {
        // drift expected
      }
      expect(Object.keys(written).length).toBe(before);
    });
  });

  // Retargeted to codex: the single-shim blob format still applies to
  // codex/gemini/cursor, but claude now writes a directory (issue #1442).
  test("shim content includes auto-generated header and all canonical rule files", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "style.md", content: "Style content." },
      { fileName: "testing.md", content: "Testing content." },
    ];
    await rulesExportCommand({ dir: "/project", agent: "codex" });
    const content = written["/project/AGENTS.md"];
    assertDefined(content, "written[/project/AGENTS.md]");
    expect(content).toContain("AUTO-GENERATED");
    expect(content).toContain(".nax/rules/");
    expect(content).toContain("Style content.");
    expect(content).toContain("Testing content.");
  });

  test("dry run does not write any files", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "style.md", content: "## Style\n\nContent." }];
    await rulesExportCommand({ dir: "/project", agent: "claude", dryRun: true });
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

  test("[US-004 AC 4] warns (does not throw) naming the rule file and pattern when an appliesTo glob matches zero files", async () => {
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger;
    _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRules;
    _rulesCLIDeps.globCanonicalRuleFiles = origGlobCanonicalRuleFiles;

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      await Bun.write(
        join(workdir, ".nax", "rules", "dead-glob.md"),
        ["---", "appliesTo:", '  - "no/such/path/**"', "---", "", "Body."].join("\n"),
      );
      await Bun.write(join(workdir, "real-file.ts"), "export const x = 1;\n");

      await expect(rulesLintCommand({ dir: workdir })).resolves.toBeUndefined();

      const warnings = logger.calls.filter((c) => c.level === "warn");
      expect(warnings.length).toBeGreaterThan(0);
      const combined = warnings.map((c) => `${c.message} ${JSON.stringify(c.data ?? {})}`).join(" | ");
      expect(combined).toContain("dead-glob.md");
      expect(combined).toContain("no/such/path/**");
    });
  });

  test("[US-004 AC 4] does not warn when an appliesTo glob only matches dotfiles", async () => {
    // Bun.Glob.scanSync skips dotfiles/dot-directories unless dot:true is
    // passed, so a pattern that legitimately targets a hidden path (e.g.
    // .github/**) must not be reported as a dead glob.
    const logger = makeLogger();
    _rulesCLIDeps.getLogger = () => logger;
    _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRules;
    _rulesCLIDeps.globCanonicalRuleFiles = origGlobCanonicalRuleFiles;

    await withTempDir(async (workdir) => {
      await mkdir(join(workdir, ".nax", "rules"), { recursive: true });
      await mkdir(join(workdir, ".github", "workflows"), { recursive: true });
      await Bun.write(
        join(workdir, ".nax", "rules", "ci-scope.md"),
        ["---", "appliesTo:", '  - ".github/**"', "---", "", "Body."].join("\n"),
      );
      await Bun.write(join(workdir, ".github", "workflows", "ci.yml"), "name: ci\n");

      await expect(rulesLintCommand({ dir: workdir })).resolves.toBeUndefined();

      const warnings = logger.calls.filter((c) => c.level === "warn");
      expect(warnings).toHaveLength(0);
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
// US-001 AC9: legacy .claude/rules/ entry declaring description + paths
// migrates and the migrated file loads with description intact.
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesMigrateCommand + loadCanonicalRules — US-001 AC9 description round-trips through migrate", () => {
  test("[AC9] loadCanonicalRules does not throw and the loaded rule's description equals the original legacy value", async () => {
    const { _canonicalLoaderDeps, loadCanonicalRules } = await import("@/context/rules/canonical-loader");
    const legacyPath = "/repo/.claude/rules/ctrl-rule.md";
    const targetPath = "/repo/.nax/rules/ctrl-rule.md";
    _rulesCLIDeps.globInDir = () => [legacyPath];
    _rulesCLIDeps.fileExists = async (p: string) => p.startsWith("/repo/.claude/");
    _rulesCLIDeps.readFile = async () =>
      [
        "---",
        "description: Use when editing controllers",
        "paths:",
        '  - "src/controllers/**"',
        "---",
        "",
        "Body.",
      ].join("\n");

    await rulesMigrateCommand({ dir: "/repo" });

    const migrated = written[targetPath];
    expect(migrated).toBeDefined();
    expect(migrated).toContain("description: Use when editing controllers");

    // Now load the migrated store. The loader's deps are independent of the
    // migrate side, so we can re-route its I/O through the snapshot of what
    // migrate wrote.
    const origGlobInDir = _canonicalLoaderDeps.globInDir;
    const origReadFile = _canonicalLoaderDeps.readFile;
    const origGetLogger = _canonicalLoaderDeps.getLogger;
    _canonicalLoaderDeps.globInDir = () => [targetPath];
    _canonicalLoaderDeps.readFile = async (p: string) => {
      if (p === targetPath) return migrated;
      throw new Error(`unexpected file: ${p}`);
    };
    _canonicalLoaderDeps.getLogger = () => makeLogger();
    try {
      const rules = await loadCanonicalRules("/repo");
      expect(rules).toHaveLength(1);
      expect(rules[0]?.description).toBe("Use when editing controllers");
    } finally {
      _canonicalLoaderDeps.globInDir = origGlobInDir;
      _canonicalLoaderDeps.readFile = origReadFile;
      _canonicalLoaderDeps.getLogger = origGetLogger;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001: dry-run preview must equal the real run.
//
// The original defect: dry-run reported writes it did not earn (it skipped
// the existing-target check), counted those targets as written, and
// suppressed the summary. Both modes must now go through the same
// planMigration and the same write-or-skip decision, with dry-run producing
// a parallel outcome and a summary line that matches the real run.
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesMigrateCommand — dry-run / real-run parity", () => {
  test("AC-7: dry-run with an existing target does not call writeFile", async () => {
    const calls: Array<[string, string]> = [];
    _rulesCLIDeps.writeFile = async (path, content) => {
      calls.push([path, content]);
    };
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project", dryRun: true });
    expect(calls).toHaveLength(0);
  });

  test("AC-8: dry-run with an existing target returns that target as skipped", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    const outcome = await rulesMigrateCommand({ dir: "/project", dryRun: true });
    expect(outcome.skipped).toEqual(["project-conventions.md"]);
  });

  test("AC-9: dry-run and real-run report equal written file-name sets (force=true)", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    const dryRun = await rulesMigrateCommand({ dir: "/project", force: true, dryRun: true });
    for (const k of Object.keys(written)) delete written[k];
    const realRun = await rulesMigrateCommand({ dir: "/project", force: true, dryRun: false });
    expect(new Set(dryRun.written)).toEqual(new Set(realRun.written));
  });

  test("AC-10: dry-run and real-run report equal skipped file-name sets (force=false)", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    const dryRun = await rulesMigrateCommand({ dir: "/project", dryRun: true });
    for (const k of Object.keys(written)) delete written[k];
    const realRun = await rulesMigrateCommand({ dir: "/project", dryRun: false });
    expect(new Set(dryRun.skipped)).toEqual(new Set(realRun.skipped));
  });

  test("AC-11: dry-run does not call the injected mkdir dependency", async () => {
    const mkdirCalls: string[] = [];
    _rulesCLIDeps.mkdir = async (dir) => {
      mkdirCalls.push(dir);
    };
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project", dryRun: true });
    expect(mkdirCalls).toHaveLength(0);
  });

  test("AC-12: dry-run summary reports the same counts as the real run, with dry-run wording", async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    let dryRun: MigrationOutcome | undefined;
    try {
      dryRun = await rulesMigrateCommand({ dir: "/project", dryRun: true });
    } finally {
      console.log = originalLog;
    }
    for (const k of Object.keys(written)) delete written[k];
    const realRun = await rulesMigrateCommand({ dir: "/project", dryRun: false });
    const summary = lines.find((line) => /^\s*Dry run: \d+ file\(s\) would be written, \d+ skipped\.$/.test(line));
    expect(summary).toBeDefined();
    expect(summary).toContain(
      `Dry run: ${realRun.written.length} file(s) would be written, ${realRun.skipped.length} skipped.`,
    );
    expect(dryRun?.written).toEqual(realRun.written);
    expect(dryRun?.skipped).toEqual(realRun.skipped);
  });

  test("AC-13: an existing unforced target is skipped in both dry-run and real-run", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    const dryRun = await rulesMigrateCommand({ dir: "/project", dryRun: true });
    for (const k of Object.keys(written)) delete written[k];
    const realRun = await rulesMigrateCommand({ dir: "/project", dryRun: false });
    expect(dryRun.skipped).toContain("project-conventions.md");
    expect(realRun.skipped).toContain("project-conventions.md");
  });

  test("AC-14: an existing unforced target is absent from writes in both dry-run and real-run", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    const dryRun = await rulesMigrateCommand({ dir: "/project", dryRun: true });
    for (const k of Object.keys(written)) delete written[k];
    const realRun = await rulesMigrateCommand({ dir: "/project", dryRun: false });
    expect(dryRun.written).not.toContain("project-conventions.md");
    expect(realRun.written).not.toContain("project-conventions.md");
  });
});

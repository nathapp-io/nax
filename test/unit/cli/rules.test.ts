/**
 * rules.ts CLI commands — unit tests
 *
 * Covers neutralizeContent, rulesExportCommand, and rulesMigrateCommand.
 * Filesystem calls are intercepted via _rulesCLIDeps injection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NaxError } from "../../../src/errors";
import {
  neutralizeContent,
  rulesExportCommand,
  rulesLintCommand,
  rulesMigrateCommand,
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
});

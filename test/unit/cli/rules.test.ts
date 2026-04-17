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
let origMkdir: typeof _rulesCLIDeps.mkdir;
let origLoadCanonicalRules: typeof _rulesCLIDeps.loadCanonicalRules;

const written: Record<string, string> = {};

beforeEach(() => {
  origReadFile = _rulesCLIDeps.readFile;
  origWriteFile = _rulesCLIDeps.writeFile;
  origFileExists = _rulesCLIDeps.fileExists;
  origGlobInDir = _rulesCLIDeps.globInDir;
  origMkdir = _rulesCLIDeps.mkdir;
  origLoadCanonicalRules = _rulesCLIDeps.loadCanonicalRules;

  Object.keys(written).forEach((k) => delete written[k]);

  _rulesCLIDeps.readFile = async () => "";
  _rulesCLIDeps.writeFile = async (path, content) => { written[path] = content; };
  _rulesCLIDeps.fileExists = async () => false;
  _rulesCLIDeps.globInDir = () => [];
  _rulesCLIDeps.mkdir = async () => {};
  _rulesCLIDeps.loadCanonicalRules = async () => [];
});

afterEach(() => {
  _rulesCLIDeps.readFile = origReadFile;
  _rulesCLIDeps.writeFile = origWriteFile;
  _rulesCLIDeps.fileExists = origFileExists;
  _rulesCLIDeps.globInDir = origGlobInDir;
  _rulesCLIDeps.mkdir = origMkdir;
  _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRules;
});

// ─────────────────────────────────────────────────────────────────────────────
// neutralizeContent
// ─────────────────────────────────────────────────────────────────────────────

describe("neutralizeContent", () => {
  test("removes <system-reminder> tags", () => {
    const { content } = neutralizeContent("<system-reminder>Do this.</system-reminder>\n\nKeep this.");
    expect(content).not.toContain("system-reminder");
    expect(content).toContain("Keep this.");
  });

  test("replaces tool-name phrasing with '<Name> capability'", () => {
    const { content, replacements } = neutralizeContent("Use the Grep tool to search.");
    expect(content).not.toContain("the Grep tool");
    expect(content).toContain("the Grep capability");
    expect(replacements).toBeGreaterThan(0);
  });

  test("replaces any capitalised tool name, not just a hardcoded list", () => {
    const { content } = neutralizeContent("Call the TodoWrite tool and the WebFetch tool.");
    expect(content).not.toContain("the TodoWrite tool");
    expect(content).not.toContain("the WebFetch tool");
    expect(content).toContain("TodoWrite capability");
    expect(content).toContain("WebFetch capability");
  });

  test("replaces CLAUDE.md references", () => {
    const { content } = neutralizeContent("See CLAUDE.md for details.");
    expect(content).not.toContain("CLAUDE.md");
    expect(content).toContain("project conventions");
  });

  test("replaces .claude/ directory references", () => {
    const { content } = neutralizeContent("Rules live in .claude/rules/.");
    expect(content).not.toContain(".claude/");
    expect(content).toContain(".nax/rules/");
  });

  test("replaces IMPORTANT: with Note:", () => {
    const { content } = neutralizeContent("IMPORTANT: Never mutate.");
    expect(content).not.toContain("IMPORTANT:");
    expect(content).toContain("Note:");
  });

  test("strips emoji", () => {
    const { content } = neutralizeContent("Write tests 🎯 always.");
    expect(content).not.toContain("🎯");
    expect(content).toContain("Write tests");
  });

  test("returns zero replacements for clean content", () => {
    const { replacements } = neutralizeContent("## Style\n\nUse async/await.");
    expect(replacements).toBe(0);
  });

  test("replacements counts occurrences, not pattern hits", () => {
    // 3 occurrences of IMPORTANT: — should count as 3, not 1
    const { replacements } = neutralizeContent("IMPORTANT: one.\nIMPORTANT: two.\nIMPORTANT: three.");
    expect(replacements).toBe(3);
  });

  test("trims whitespace from result", () => {
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

  test("writes CLAUDE.md for agent=claude", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "coding-style.md", content: "## Style\n\nUse immutable data." },
    ];
    await rulesExportCommand({ dir: "/project", agent: "claude" });
    expect("/project/CLAUDE.md" in written).toBe(true);
  });

  test("writes AGENTS.md for agent=codex", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "style.md", content: "## Style\n\nContent." },
    ];
    await rulesExportCommand({ dir: "/project", agent: "codex" });
    expect("/project/AGENTS.md" in written).toBe(true);
  });

  test("shim content includes auto-generated header", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "style.md", content: "## Style\n\nContent." },
    ];
    await rulesExportCommand({ dir: "/project", agent: "claude" });
    const content = written["/project/CLAUDE.md"]!;
    expect(content).toContain("AUTO-GENERATED");
    expect(content).toContain(".nax/rules/");
  });

  test("shim content includes all canonical rule files", async () => {
    _rulesCLIDeps.loadCanonicalRules = async () => [
      { fileName: "style.md", content: "Style content." },
      { fileName: "testing.md", content: "Testing content." },
    ];
    await rulesExportCommand({ dir: "/project", agent: "claude" });
    const content = written["/project/CLAUDE.md"]!;
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

  test("skips existing files unless --force", async () => {
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md" || p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project" });
    expect("/project/.nax/rules/project-conventions.md" in written).toBe(false);
  });

  test("overwrites existing files when --force", async () => {
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md" || p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project", force: true });
    expect("/project/.nax/rules/project-conventions.md" in written).toBe(true);
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

  test("includes neutralization notice when replacements were made", async () => {
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md";
    _rulesCLIDeps.readFile = async () => "IMPORTANT: do this.";
    await rulesMigrateCommand({ dir: "/project" });
    const content = written["/project/.nax/rules/project-conventions.md"]!;
    expect(content).toContain("neutralization");
  });

  test("dry run does not write any files", async () => {
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project", dryRun: true });
    expect(Object.keys(written)).toHaveLength(0);
  });

  test("creates .nax/rules/ directory", async () => {
    const createdDirs: string[] = [];
    _rulesCLIDeps.mkdir = async (dir) => { createdDirs.push(dir); };
    _rulesCLIDeps.fileExists = async (p) => p === "/project/CLAUDE.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    await rulesMigrateCommand({ dir: "/project" });
    expect(createdDirs.some((d) => d.includes(".nax/rules"))).toBe(true);
  });
});

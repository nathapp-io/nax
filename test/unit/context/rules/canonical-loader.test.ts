/**
 * canonical-loader.ts — unit tests
 *
 * Covers lintForNeutrality, loadCanonicalRules, and NeutralityLintError.
 * Filesystem calls are intercepted via _canonicalLoaderDeps injection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NaxError } from "../../../../src/errors";
import {
  applyCanonicalRulesBudget,
  lintForNeutrality,
  loadCanonicalRules,
  NeutralityLintError,
  RulesFrontmatterError,
  CANONICAL_RULES_DIR,
  _canonicalLoaderDeps,
} from "../../../../src/context/rules/canonical-loader";


// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
let origReadFile: typeof _canonicalLoaderDeps.readFile;

beforeEach(() => {
  origGlobInDir = _canonicalLoaderDeps.globInDir;
  origReadFile = _canonicalLoaderDeps.readFile;
  // Default: no rules files present
  _canonicalLoaderDeps.globInDir = () => [];
  _canonicalLoaderDeps.readFile = async () => "";
});

afterEach(() => {
  _canonicalLoaderDeps.globInDir = origGlobInDir;
  _canonicalLoaderDeps.readFile = origReadFile;
});

function setupFiles(files: Record<string, string>) {
  const paths = Object.keys(files).sort();
  _canonicalLoaderDeps.globInDir = () => paths;
  _canonicalLoaderDeps.readFile = async (p: string) => {
    if (p in files) return files[p]!;
    throw new Error(`File not found: ${p}`);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL_RULES_DIR
// ─────────────────────────────────────────────────────────────────────────────

describe("CANONICAL_RULES_DIR", () => {
  test("is .nax/rules", () => {
    expect(CANONICAL_RULES_DIR).toBe(".nax/rules");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lintForNeutrality
// ─────────────────────────────────────────────────────────────────────────────

describe("lintForNeutrality", () => {
  test("returns empty array for clean content", () => {
    const violations = lintForNeutrality(
      "## Coding Style\n\nUse async/await. Prefer immutable data.",
      "coding-style.md",
    );
    expect(violations).toHaveLength(0);
  });

  test("flags <system-reminder> tag", () => {
    const violations = lintForNeutrality("<system-reminder>Do this.</system-reminder>", "rules.md");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.pattern).toContain("XML tag");
  });

  test("flags CLAUDE.md reference", () => {
    const violations = lintForNeutrality("See CLAUDE.md for more info.", "rules.md");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.pattern).toContain("CLAUDE.md");
    expect(violations[0]?.ruleId).toBe("claude-reference");
  });

  test("flags .claude/ directory reference", () => {
    const violations = lintForNeutrality("Rules are in .claude/rules/.", "rules.md");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.pattern).toContain("directory");
  });

  test("flags 'the Grep tool' phrasing", () => {
    const violations = lintForNeutrality("Use the Grep tool to search files.", "rules.md");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.pattern).toContain("tool-name phrasing");
  });

  test("flags 'IMPORTANT:' shout", () => {
    const violations = lintForNeutrality("IMPORTANT: Never mutate objects.", "rules.md");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.pattern).toContain("IMPORTANT:");
  });

  test("flags emoji character", () => {
    const violations = lintForNeutrality("Always write tests 🎯", "rules.md");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.pattern).toContain("emoji");
  });

  test("reports correct line number", () => {
    const content = "Clean line.\n\nSee CLAUDE.md for details.";
    const violations = lintForNeutrality(content, "rules.md");
    expect(violations[0]?.lineNumber).toBe(3);
  });

  test("reports the file name in violation", () => {
    const violations = lintForNeutrality("CLAUDE.md reference here", "test-file.md");
    expect(violations[0]?.file).toBe("test-file.md");
  });

  test("supports per-line override marker for CLAUDE.md reference", () => {
    const violations = lintForNeutrality(
      "<!-- nax-rules-allow: claude-reference --> See CLAUDE.md for migration notes.",
      "rules.md",
    );
    expect(violations).toHaveLength(0);
  });

  test("override applies only to the same line", () => {
    const violations = lintForNeutrality(
      "<!-- nax-rules-allow: claude-reference -->\nSee CLAUDE.md for migration notes.",
      "rules.md",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.ruleId).toBe("claude-reference");
  });

  test("only flags one violation per line (most specific pattern wins)", () => {
    // Line has both CLAUDE.md and IMPORTANT: — only one violation per line
    const violations = lintForNeutrality("IMPORTANT: See CLAUDE.md", "rules.md");
    expect(violations).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NeutralityLintError
// ─────────────────────────────────────────────────────────────────────────────

describe("NeutralityLintError", () => {
  test("is a NaxError", () => {
    const err = new NeutralityLintError([{
      file: "a.md", lineNumber: 1, line: "CLAUDE.md", ruleId: "claude-reference", pattern: "agent-specific file",
    }]);
    expect(err).toBeInstanceOf(NaxError);
    expect(err.code).toBe("NEUTRALITY_LINT_FAILED");
  });

  test("exposes violations array", () => {
    const violation = { file: "a.md", lineNumber: 5, line: "IMPORTANT:", ruleId: "important-shouting", pattern: "shouting" };
    const err = new NeutralityLintError([violation]);
    expect(err.violations).toHaveLength(1);
    expect(err.violations[0]).toEqual(violation);
  });

  test("message includes file and line number", () => {
    const err = new NeutralityLintError([{
      file: "coding.md", lineNumber: 12, line: "CLAUDE.md", ruleId: "claude-reference", pattern: "agent-specific",
    }]);
    expect(err.message).toContain("coding.md");
    expect(err.message).toContain("12");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadCanonicalRules
// ─────────────────────────────────────────────────────────────────────────────

describe("loadCanonicalRules", () => {
  test("returns empty array when .nax/rules/ directory has no files", async () => {
    _canonicalLoaderDeps.globInDir = () => [];
    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(0);
  });

  test("returns loaded rules in alphabetical order", async () => {
    setupFiles({
      "/project/.nax/rules/testing.md": "## Testing\n\nWrite tests first.",
      "/project/.nax/rules/coding-style.md": "## Style\n\nUse immutable data.",
    });
    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(2);
    // globInDir sorts alphabetically; fileName is the basename
    expect(rules[0]?.fileName).toBe("coding-style.md");
    expect(rules[1]?.fileName).toBe("testing.md");
  });

  test("loads nested one-level rule files", async () => {
    setupFiles({
      "/project/.nax/rules/core.md": "Core rule.",
      "/project/.nax/rules/frontend/style.md": "Frontend style rule.",
    });
    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.path)).toContain("core.md");
    expect(rules.map((r) => r.path)).toContain("frontend/style.md");
  });

  test("ignores files deeper than one nested level", async () => {
    setupFiles({
      "/project/.nax/rules/core.md": "Core rule.",
      "/project/.nax/rules/frontend/react/style.md": "Too deep rule.",
    });
    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.path).toBe("core.md");
  });

  test("each rule has fileName (basename) and content", async () => {
    setupFiles({ "/project/.nax/rules/coding-style.md": "## Style\n\nUse async/await." });
    const rules = await loadCanonicalRules("/project");
    expect(rules[0]?.fileName).toBe("coding-style.md");
    expect(rules[0]?.content).toContain("async/await");
  });

  test("skips empty files", async () => {
    setupFiles({
      "/project/.nax/rules/empty.md": "   ",
      "/project/.nax/rules/coding-style.md": "## Style\n\nUse async/await.",
    });
    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.fileName).toContain("coding-style.md");
  });

  test("throws NeutralityLintError when a file contains banned markers", async () => {
    setupFiles({
      "/project/.nax/rules/rules.md": "See CLAUDE.md for conventions.",
    });
    let threw: unknown;
    try {
      await loadCanonicalRules("/project");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NeutralityLintError);
    expect((threw as NeutralityLintError).code).toBe("NEUTRALITY_LINT_FAILED");
  });

  test("collects all violations across files before throwing", async () => {
    setupFiles({
      "/project/.nax/rules/a.md": "See CLAUDE.md.",
      "/project/.nax/rules/b.md": "IMPORTANT: do this.",
    });
    let threw: unknown;
    try {
      await loadCanonicalRules("/project");
    } catch (e) {
      threw = e;
    }
    expect((threw as NeutralityLintError).violations.length).toBeGreaterThanOrEqual(2);
  });

  test("content is trimmed", async () => {
    setupFiles({ "/project/.nax/rules/style.md": "\n\n## Style\n\nContent.\n\n" });
    const rules = await loadCanonicalRules("/project");
    expect(rules[0]?.content).toBe("## Style\n\nContent.");
  });

  test("parses frontmatter priority and appliesTo", async () => {
    setupFiles({
      "/project/.nax/rules/agents.md": `---
priority: 50
appliesTo:
  - "src/agents/**"
  - "test/agents/**"
---
Only for agent files.`,
    });
    const rules = await loadCanonicalRules("/project");
    expect(rules[0]?.priority).toBe(50);
    expect(rules[0]?.appliesTo).toEqual(["src/agents/**", "test/agents/**"]);
    expect(rules[0]?.content).toBe("Only for agent files.");
  });

  test("throws RulesFrontmatterError on malformed frontmatter", async () => {
    setupFiles({
      "/project/.nax/rules/bad.md": `---
priority: [not-a-number]
---
Broken`,
    });
    await expect(loadCanonicalRules("/project")).rejects.toBeInstanceOf(RulesFrontmatterError);
  });

  test("applies budget truncation when budgetTokens is provided", async () => {
    setupFiles({
      "/project/.nax/rules/a.md": `---
priority: 1
---
${"A".repeat(800)}`,
      "/project/.nax/rules/b.md": `---
priority: 2
---
${"B".repeat(800)}`,
      "/project/.nax/rules/c.md": `---
priority: 3
---
${"C".repeat(800)}`,
    });
    const rules = await loadCanonicalRules("/project", { budgetTokens: 200 });
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.length).toBeLessThan(3);
  });
});

describe("applyCanonicalRulesBudget", () => {
  test("keeps higher-priority rules first when truncating", () => {
    const rules = [
      { fileName: "a.md", id: "a", content: "A".repeat(400), tokens: 100, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(400), tokens: 100, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(400), tokens: 100, priority: 3 },
    ];
    const result = applyCanonicalRulesBudget(rules, 200);
    expect(result.rules).toHaveLength(2);
    expect(result.rules.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.droppedCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M10: logger calls must not carry sentinel storyId "_rules"
// ─────────────────────────────────────────────────────────────────────────────

describe("loadCanonicalRules — #508-M10 no sentinel storyId in logger calls", () => {
  let origGetLogger: typeof _canonicalLoaderDeps.getLogger;

  beforeEach(() => {
    origGetLogger = _canonicalLoaderDeps.getLogger;
  });

  afterEach(() => {
    _canonicalLoaderDeps.getLogger = origGetLogger;
  });

  function makeLoggerSpy(warnData: Array<Record<string, unknown>>, debugData: Array<Record<string, unknown>>) {
    return () =>
      ({
        warn: (_stage: string, _msg: string, data: Record<string, unknown>) => warnData.push(data),
        debug: (_stage: string, _msg: string, data: Record<string, unknown>) => debugData.push(data),
        info: () => {},
        error: () => {},
      }) as unknown as ReturnType<typeof _canonicalLoaderDeps.getLogger>;
  }

  test("warn log data does not contain storyId when readFile fails", async () => {
    const warnData: Array<Record<string, unknown>> = [];
    _canonicalLoaderDeps.getLogger = makeLoggerSpy(warnData, []);
    _canonicalLoaderDeps.globInDir = () => ["/project/.nax/rules/rules.md"];
    _canonicalLoaderDeps.readFile = async () => {
      throw new Error("disk error");
    };

    await loadCanonicalRules("/project");

    expect(warnData).toHaveLength(1);
    expect("storyId" in (warnData[0] ?? {})).toBe(false);
  });

  test("debug log data does not contain storyId when rules load successfully", async () => {
    const debugData: Array<Record<string, unknown>> = [];
    _canonicalLoaderDeps.getLogger = makeLoggerSpy([], debugData);
    _canonicalLoaderDeps.globInDir = () => ["/project/.nax/rules/style.md"];
    _canonicalLoaderDeps.readFile = async () => "## Style\n\nUse async/await.";

    await loadCanonicalRules("/project");

    expect(debugData).toHaveLength(1);
    expect("storyId" in (debugData[0] ?? {})).toBe(false);
  });
});

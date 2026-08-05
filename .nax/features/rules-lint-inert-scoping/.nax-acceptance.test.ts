import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  FRONTMATTER_PRIORITY_DEFAULT,
  parseFrontmatter,
} from "../../../src/context/rules/rules-frontmatter";
import { loadCanonicalRules } from "../../../src/context/rules/canonical-loader";
import { _rulesLintDeps, rulesLintCommand } from "../../../src/cli/rules-lint";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers/temp";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures / helpers
// ─────────────────────────────────────────────────────────────────────────────

const RULE_BODY = "This rule describes a coding convention used across the project.";

async function writeRuleFile(root: string, name: string, content: string): Promise<string> {
  const filePath = join(root, ".nax", "rules", `${name}.md`);
  await Bun.write(filePath, content);
  return filePath;
}

/** Captures raw variadic call args so tests don't depend on a specific positional convention. */
function createMockLogger() {
  const warnCalls: unknown[][] = [];
  const infoCalls: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    info: (...args: unknown[]) => {
      infoCalls.push(args);
    },
    error: (..._args: unknown[]) => {},
    debug: (..._args: unknown[]) => {},
  };
  return { logger, warnCalls, infoCalls };
}

function hasObjectArg(args: unknown[], predicate: (o: Record<string, unknown>) => boolean): boolean {
  return args.some((a) => typeof a === "object" && a !== null && predicate(a as Record<string, unknown>));
}

function hasStringArgContaining(args: unknown[], substr: string): boolean {
  return args.some((a) => typeof a === "string" && a.includes(substr));
}

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir("nax-rules-lint-inert-scoping-");
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001: parseFrontmatter detects comment-displaced frontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: parseFrontmatter comment-displaced frontmatter", () => {
  const filePath = "/repo/.nax/rules/displaced.md";
  const singleCommentDisplaced = [
    "<!-- reviewed by legacy migrate -->",
    "---",
    "priority: 90",
    'paths: ["src/**/*.ts"]',
    'appliesTo: ["*.ts"]',
    "---",
    RULE_BODY,
    "",
  ].join("\n");

  test("AC-1: HTML comment immediately followed by frontmatter produces a displaced-frontmatter warning naming filePath", () => {
    const result = parseFrontmatter(singleCommentDisplaced, filePath);
    expect(
      result.warnings.some((w) => /displac/i.test(w) && w.includes(filePath)),
    ).toBe(true);
  });

  test("AC-2: priority falls back to FRONTMATTER_PRIORITY_DEFAULT despite declared priority: 90", () => {
    const result = parseFrontmatter(singleCommentDisplaced, filePath);
    expect(result.priority).toBe(FRONTMATTER_PRIORITY_DEFAULT);
  });

  test("AC-3: paths is undefined when frontmatter is comment-displaced", () => {
    const result = parseFrontmatter(singleCommentDisplaced, filePath);
    expect(result.paths).toBeUndefined();
  });

  test("AC-4: appliesTo is undefined when frontmatter is comment-displaced", () => {
    const result = parseFrontmatter(singleCommentDisplaced, filePath);
    expect(result.appliesTo).toBeUndefined();
  });

  test("AC-5: multi-line leading HTML comment followed by frontmatter produces a displaced-frontmatter warning", () => {
    const multilineComment = [
      "<!--",
      "  reviewed by legacy migrate",
      "  do not edit below",
      "-->",
      "---",
      "priority: 50",
      "---",
      RULE_BODY,
      "",
    ].join("\n");

    const result = parseFrontmatter(multilineComment, filePath);
    expect(result.warnings.some((w) => /displac/i.test(w))).toBe(true);
  });

  test("AC-6: leading HTML comment with no '---' anywhere produces an empty warnings array", () => {
    const noFrontmatter = ["<!-- reviewed by legacy migrate -->", "Just ordinary prose, no frontmatter block.", ""].join(
      "\n",
    );

    const result = parseFrontmatter(noFrontmatter, filePath);
    expect(result.warnings).toEqual([]);
  });

  test("AC-7: leading HTML comment, prose, then a later markdown horizontal rule produces an empty warnings array", () => {
    const laterHorizontalRule = [
      "<!-- reviewed by legacy migrate -->",
      "Some introductory prose paragraph.",
      "",
      "---",
      "",
      "More prose after the horizontal rule.",
      "",
    ].join("\n");

    const result = parseFrontmatter(laterHorizontalRule, filePath);
    expect(result.warnings).toEqual([]);
  });

  test("AC-8: blank line, then leading HTML comment, then frontmatter produces exactly one warnings entry", () => {
    const blankThenComment = [
      "",
      "<!-- reviewed by legacy migrate -->",
      "---",
      "priority: 20",
      "---",
      RULE_BODY,
      "",
    ].join("\n");

    const result = parseFrontmatter(blankThenComment, filePath);
    expect(result.warnings.length).toBe(1);
  });

  test("AC-9: frontmatter block starting at byte 0 produces an empty warnings array", () => {
    const cleanFrontmatter = ["---", "priority: 90", "---", RULE_BODY, ""].join("\n");

    const result = parseFrontmatter(cleanFrontmatter, filePath);
    expect(result.warnings).toEqual([]);
  });

  test("AC-10: leading blank line directly followed by valid frontmatter returns priority 90 and exactly one displaced-frontmatter warning", () => {
    const blankLineThenFrontmatter = ["", "---", "priority: 90", "---", RULE_BODY, ""].join("\n");

    const result = parseFrontmatter(blankLineThenFrontmatter, filePath);
    expect(result.priority).toBe(90);
    expect(result.warnings.length).toBe(1);
  });
});

describe("US-001: loadCanonicalRules propagates displaced-frontmatter warning", () => {
  test("AC-11: a rule store containing a comment-displaced file returns a rule whose warnings include the displaced-frontmatter entry", async () => {
    const content = ["<!-- reviewed by legacy migrate -->", "---", "priority: 90", "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "displaced", content);

    const rules = await loadCanonicalRules(tempDir);
    const rule = rules.find((r) => r.fileName === "displaced.md");

    expect(rule).toBeDefined();
    expect((rule?.warnings ?? []).some((w) => /displac/i.test(w))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002: rulesLintCommand warns on inert paths: and surfaces displacement
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002: rulesLintCommand — displacement surfaced through lint", () => {
  test("AC-12: emits a rules-lint warning carrying the displaced HTML comment text", async () => {
    const htmlComment = "<!-- reviewed by legacy migrate -->";
    const content = [htmlComment, "---", "priority: 90", "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "displaced", content);

    const { logger, warnCalls } = createMockLogger();
    await rulesLintCommand(
      { dir: tempDir },
      {
        ..._rulesLintDeps,
        getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
        discoverWorkspacePackages: async () => [],
      } as unknown as Parameters<typeof rulesLintCommand>[1],
    );

    const match = warnCalls.find(
      (args) =>
        args[0] === "rules-lint" &&
        (hasObjectArg(args, (o) => o.displacedFrontmatter === htmlComment) ||
          hasStringArgContaining(args, htmlComment)),
    );
    expect(match).toBeDefined();
  });
});

describe("US-002: rulesLintCommand — inert paths: warning", () => {
  test("AC-13: warns naming the rule file's absolute path with code INERT_PATHS when discoverWorkspacePackages resolves empty", async () => {
    const content = ["---", 'paths: ["*.ts"]', "---", RULE_BODY, ""].join("\n");
    const filePath = await writeRuleFile(tempDir, "scoped", content);

    const { logger, warnCalls } = createMockLogger();
    await rulesLintCommand(
      { dir: tempDir },
      {
        ..._rulesLintDeps,
        getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
        discoverWorkspacePackages: async () => [],
      } as unknown as Parameters<typeof rulesLintCommand>[1],
    );

    const match = warnCalls.find((args) => hasObjectArg(args, (o) => o.code === "INERT_PATHS" && o.file === filePath));
    expect(match).toBeDefined();
  });

  test("AC-14: the INERT_PATHS warning message names appliesTo as the alternative", async () => {
    const content = ["---", 'paths: ["*.ts"]', "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "scoped", content);

    const { logger, warnCalls } = createMockLogger();
    await rulesLintCommand(
      { dir: tempDir },
      {
        ..._rulesLintDeps,
        getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
        discoverWorkspacePackages: async () => [],
      } as unknown as Parameters<typeof rulesLintCommand>[1],
    );

    const match = warnCalls.find(
      (args) => hasObjectArg(args, (o) => o.code === "INERT_PATHS") && hasStringArgContaining(args, "appliesTo"),
    );
    expect(match).toBeDefined();
  });

  test("AC-15: emits no INERT_PATHS warning when discoverWorkspacePackages resolves a non-empty package list", async () => {
    const content = ["---", 'paths: ["*.ts"]', "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "scoped", content);

    const { logger, warnCalls } = createMockLogger();
    await rulesLintCommand(
      { dir: tempDir },
      {
        ..._rulesLintDeps,
        getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
        discoverWorkspacePackages: async () => ["pkg/a", "pkg/b"],
      } as unknown as Parameters<typeof rulesLintCommand>[1],
    );

    const hasInert = warnCalls.some((args) => hasObjectArg(args, (o) => o.code === "INERT_PATHS"));
    expect(hasInert).toBe(false);
  });

  test("AC-16: emits no INERT_PATHS warning for a rule declaring no paths key", async () => {
    const content = ["---", "priority: 10", "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "unscoped", content);

    const { logger, warnCalls } = createMockLogger();
    await rulesLintCommand(
      { dir: tempDir },
      {
        ..._rulesLintDeps,
        getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
        discoverWorkspacePackages: async () => [],
      } as unknown as Parameters<typeof rulesLintCommand>[1],
    );

    const hasInert = warnCalls.some((args) => hasObjectArg(args, (o) => o.code === "INERT_PATHS"));
    expect(hasInert).toBe(false);
  });
});

describe("US-002: rulesLintCommand — exit code and summary line", () => {
  test("AC-17: resolves without setting a non-zero process.exitCode when only warnings occur", async () => {
    const content = ["---", 'paths: ["*.ts"]', "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "scoped", content);

    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    const { logger } = createMockLogger();
    try {
      await rulesLintCommand(
        { dir: tempDir },
        {
          ..._rulesLintDeps,
          getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
          discoverWorkspacePackages: async () => [],
        } as unknown as Parameters<typeof rulesLintCommand>[1],
      );

      expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  test("AC-18: the summary line reports N warning(s) and a logger call carries a matching warningCount field", async () => {
    const content = ["---", 'paths: ["*.ts"]', "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "scoped", content);

    const { logger, warnCalls, infoCalls } = createMockLogger();
    const originalLog = console.log;
    const stdoutLines: string[] = [];
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    };

    try {
      await rulesLintCommand(
        { dir: tempDir },
        {
          ..._rulesLintDeps,
          getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
          discoverWorkspacePackages: async () => [],
        } as unknown as Parameters<typeof rulesLintCommand>[1],
      );
    } finally {
      console.log = originalLog;
    }

    const summaryLine = stdoutLines.find((l) => /\[WARN\] Canonical rules lint completed with \d+ warning\(s\)/.test(l));
    expect(summaryLine).toBeDefined();

    const match = summaryLine?.match(/completed with (\d+) warning\(s\)/);
    const n = match ? Number(match[1]) : Number.NaN;
    expect(n).toBeGreaterThanOrEqual(1);

    const allCalls = [...warnCalls, ...infoCalls];
    const countMatch = allCalls.find((args) => hasObjectArg(args, (o) => o.warningCount === n));
    expect(countMatch).toBeDefined();
  });
});

describe("US-002: rulesLintCommand — fail-open on discoverWorkspacePackages rejection", () => {
  test("AC-19: emits no INERT_PATHS warning when discoverWorkspacePackages rejects", async () => {
    const content = ["---", 'paths: ["*.ts"]', "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "scoped", content);

    const { logger, warnCalls } = createMockLogger();
    await rulesLintCommand(
      { dir: tempDir },
      {
        ..._rulesLintDeps,
        getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
        discoverWorkspacePackages: async () => {
          throw new Error("failed");
        },
      } as unknown as Parameters<typeof rulesLintCommand>[1],
    );

    const hasInert = warnCalls.some((args) => hasObjectArg(args, (o) => o.code === "INERT_PATHS"));
    expect(hasInert).toBe(false);
  });

  test("AC-20: still emits its final summary line when discoverWorkspacePackages rejects", async () => {
    const content = ["---", 'paths: ["*.ts"]', "---", RULE_BODY, ""].join("\n");
    await writeRuleFile(tempDir, "scoped", content);

    const { logger } = createMockLogger();
    const originalLog = console.log;
    const stdoutLines: string[] = [];
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    };

    try {
      await rulesLintCommand(
        { dir: tempDir },
        {
          ..._rulesLintDeps,
          getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
          discoverWorkspacePackages: async () => {
            throw new Error("failed");
          },
        } as unknown as Parameters<typeof rulesLintCommand>[1],
      );
    } finally {
      console.log = originalLog;
    }

    const summaryLine = stdoutLines.find(
      (l) =>
        /\[WARN\] Canonical rules lint completed with \d+ warning\(s\)/.test(l) ||
        /\[OK\] Canonical rules lint passed/.test(l),
    );
    expect(summaryLine).toBeDefined();
  });
});
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { NaxError } from "../../../src/errors";
import {
  _rulesCLIDeps,
  rulesMigrateCommand,
} from "../../../src/cli/rules";
import { rulesLintCommand, type RulesLintDeps } from "../../../src/cli/rules-lint";
import { planMigration } from "../../../src/cli/rules-migrate-plan";

const SOURCE = {
  sourcePath: "/source/rule.md",
  targetFileName: "target.md",
  targetPath: "/target/rule.md",
  content: "# Rule",
};
const TARGET_DIR = "/target";
const RULE_ROOT = "/repo";
const ROOT_ONE = join(RULE_ROOT, "packages/one");
const ROOT_TWO = join(RULE_ROOT, "packages/two");
const ROOT_THREE = join(RULE_ROOT, "packages/three");

type Rule = Awaited<ReturnType<RulesLintDeps["loadCanonicalRules"]>>[number];

let originalMigrationDeps: Pick<
  typeof _rulesCLIDeps,
  "fileExists" | "globInDir" | "mkdir" | "readFile" | "writeFile"
>;

beforeEach(() => {
  originalMigrationDeps = {
    fileExists: _rulesCLIDeps.fileExists,
    globInDir: _rulesCLIDeps.globInDir,
    mkdir: _rulesCLIDeps.mkdir,
    readFile: _rulesCLIDeps.readFile,
    writeFile: _rulesCLIDeps.writeFile,
  };
});

afterEach(() => {
  _rulesCLIDeps.fileExists = originalMigrationDeps.fileExists;
  _rulesCLIDeps.globInDir = originalMigrationDeps.globInDir;
  _rulesCLIDeps.mkdir = originalMigrationDeps.mkdir;
  _rulesCLIDeps.readFile = originalMigrationDeps.readFile;
  _rulesCLIDeps.writeFile = originalMigrationDeps.writeFile;
});

function configureMigration(options: {
  exists: boolean;
  writeFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
}): void {
  const commandTarget = "/source/.nax/rules/target.md";
  _rulesCLIDeps.fileExists = async (path) => path === commandTarget && options.exists;
  _rulesCLIDeps.globInDir = () => ["/source/.claude/rules/target.md"];
  _rulesCLIDeps.readFile = async () => SOURCE.content;
  _rulesCLIDeps.writeFile = options.writeFile ?? (async () => {});
  _rulesCLIDeps.mkdir = options.mkdir ?? (async () => {});
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => (console.log = originalLog) };
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    fileName: "rule.md",
    path: "rule.md",
    content: "# Rule",
    warnings: ["rule warning"],
    ...overrides,
  } as Rule;
}

function makeLintDeps(options: {
  roots: string[];
  rulesForRoot: (root: string) => Promise<Rule[]>;
  logger?: { warn: ReturnType<typeof mock> };
}): RulesLintDeps {
  return {
    globCanonicalRuleFiles: () => options.roots.flatMap((root) => [`${root.slice(RULE_ROOT.length + 1)}/.nax/rules/rule.md`]),
    loadCanonicalRules: options.rulesForRoot,
    globHasMatch: () => true,
    getLogger: () =>
      (options.logger ?? { warn: mock(() => {}) }) as unknown as ReturnType<RulesLintDeps["getLogger"]>,
    discoverWorkspacePackages: async () => ["packages/one"],
  };
}

describe("rules-cli-honesty acceptance", () => {
  test("AC-1: existing target without force is planned as skipped", async () => {
    const plan = await planMigration([SOURCE], { targetDir: TARGET_DIR, force: false, fileExists: async () => true });
    expect(plan.skips.map((entry) => entry.targetFileName)).toContain("target.md");
  });

  test("AC-2: existing target without force has no planned writes", async () => {
    const plan = await planMigration([SOURCE], { targetDir: TARGET_DIR, force: false, fileExists: async () => true });
    expect(plan.writes).toEqual([]);
  });

  test("AC-3: existing target with force is planned for one write", async () => {
    const plan = await planMigration([SOURCE], { targetDir: TARGET_DIR, force: true, fileExists: async () => true });
    expect(plan.writes.map((entry) => entry.targetFileName)).toEqual(["target.md"]);
  });

  test("AC-4: existing target with force has no planned skips", async () => {
    const plan = await planMigration([SOURCE], { targetDir: TARGET_DIR, force: true, fileExists: async () => true });
    expect(plan.skips).toEqual([]);
  });

  test("AC-5: absent target without force is planned for one write", async () => {
    const plan = await planMigration([SOURCE], { targetDir: TARGET_DIR, force: false, fileExists: async () => false });
    expect(plan.writes.map((entry) => entry.targetFileName)).toEqual(["target.md"]);
  });

  test("AC-6: absent target with force is planned for one write", async () => {
    const plan = await planMigration([SOURCE], { targetDir: TARGET_DIR, force: true, fileExists: async () => false });
    expect(plan.writes.map((entry) => entry.targetFileName)).toEqual(["target.md"]);
  });

  test("AC-7: dry-run with an existing target never writes a file", async () => {
    const writeFile = mock(async () => {});
    configureMigration({ exists: true, writeFile });
    await rulesMigrateCommand({ dir: "/source", force: false, dryRun: true });
    expect(writeFile).not.toHaveBeenCalled();
  });

  test("AC-8: dry-run with an existing target returns that target as skipped", async () => {
    configureMigration({ exists: true });
    const outcome = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: true });
    expect(outcome.skipped).toEqual(["target.md"]);
  });

  test("AC-9: forced dry-run and real-run report equal written file sets", async () => {
    configureMigration({ exists: true });
    const dryRun = await rulesMigrateCommand({ dir: "/source", force: true, dryRun: true });
    const realRun = await rulesMigrateCommand({ dir: "/source", force: true, dryRun: false });
    expect(new Set(dryRun.written)).toEqual(new Set(realRun.written));
  });

  test("AC-10: unforced dry-run and real-run report equal skipped file sets", async () => {
    configureMigration({ exists: true });
    const dryRun = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: true });
    const realRun = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: false });
    expect(new Set(dryRun.skipped)).toEqual(new Set(realRun.skipped));
  });

  test("AC-11: dry-run never creates the target directory", async () => {
    const mkdir = mock(async () => {});
    configureMigration({ exists: false, mkdir });
    await rulesMigrateCommand({ dir: "/source", force: false, dryRun: true });
    expect(mkdir).not.toHaveBeenCalled();
  });

  test("AC-12: dry-run summary reports the same counts as a real run", async () => {
    configureMigration({ exists: false });
    const dryCapture = captureStdout();
    let dryRun;
    try {
      dryRun = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: true });
    } finally {
      dryCapture.restore();
    }
    const realRun = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: false });
    const summary = dryCapture.lines.find((line) => /\d+ written, \d+ skipped/.test(line));
    expect(summary).toBeDefined();
    expect(summary).toContain(`${realRun.written.length} written, ${realRun.skipped.length} skipped`);
    expect(dryRun).toEqual(realRun);
  });

  test("AC-13: an existing unforced target is skipped in dry-run and real-run", async () => {
    configureMigration({ exists: true });
    const dryRun = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: true });
    const realRun = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: false });
    expect(dryRun.skipped).toContain("target.md");
    expect(realRun.skipped).toContain("target.md");
  });

  test("AC-14: an existing unforced target is absent from writes in dry-run and real-run", async () => {
    configureMigration({ exists: true });
    const dryRun = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: true });
    const realRun = await rulesMigrateCommand({ dir: "/source", force: false, dryRun: false });
    expect(dryRun.written).not.toContain("target.md");
    expect(realRun.written).not.toContain("target.md");
  });

  test("AC-15: a healthy root still emits its rule warning after another root fails", async () => {
    const logger = { warn: mock(() => {}) };
    const deps = makeLintDeps({
      roots: [ROOT_TWO],
      rulesForRoot: async (root) => {
        if (root === RULE_ROOT) throw new Error("broken root");
        return [makeRule({ path: "healthy.md", warnings: ["healthy warning"] })];
      },
      logger,
    });
    await expect(rulesLintCommand({ dir: RULE_ROOT }, deps)).rejects.toBeInstanceOf(NaxError);
    const healthyWarning = logger.warn.mock.calls.find(([, , context]) => (context as { root?: string })?.root === ROOT_TWO);
    expect(healthyWarning).toBeDefined();
  });

  test("AC-16: a rejected root produces RULES_LINT_ROOT_FAILED", async () => {
    const deps = makeLintDeps({ roots: [], rulesForRoot: async () => Promise.reject(new Error("broken root")) });
    try {
      await rulesLintCommand({ dir: RULE_ROOT }, deps);
      throw new Error("expected rules lint to reject");
    } catch (error) {
      expect((error as NaxError).code).toBe("RULES_LINT_ROOT_FAILED");
    }
  });

  test("AC-17: aggregate root failure context lists exactly the failed roots", async () => {
    const deps = makeLintDeps({
      roots: [ROOT_THREE],
      rulesForRoot: async (root) => {
        if (root === RULE_ROOT || root === ROOT_THREE) throw new Error("broken root");
        return [makeRule()];
      },
    });
    try {
      await rulesLintCommand({ dir: RULE_ROOT }, deps);
      throw new Error("expected rules lint to reject");
    } catch (error) {
      const lintError = error as NaxError;
      expect(lintError.code).toBe("RULES_LINT_ROOT_FAILED");
      expect(lintError.context?.failedRoots).toEqual([RULE_ROOT, ROOT_THREE]);
    }
  });

  test("AC-18: warning-only lint resolves", async () => {
    const deps = makeLintDeps({ roots: [ROOT_ONE], rulesForRoot: async () => [makeRule()] });
    await expect(rulesLintCommand({ dir: RULE_ROOT }, deps)).resolves.toBeUndefined();
  });

  test("AC-19: warning-only lint writes a WARN summary", async () => {
    const capture = captureStdout();
    try {
      await rulesLintCommand({ dir: RULE_ROOT }, makeLintDeps({ roots: [ROOT_ONE], rulesForRoot: async () => [makeRule()] }));
    } finally {
      capture.restore();
    }
    expect(capture.lines.some((line) => /\[WARN\].*\d+ warning/.test(line))).toBe(true);
  });

  test("AC-20: an empty rule store emits an empty-store logger warning", async () => {
    const logger = { warn: mock(() => {}) };
    await rulesLintCommand({ dir: RULE_ROOT }, makeLintDeps({ roots: [], rulesForRoot: async () => [], logger }));
    expect(logger.warn.mock.calls.some(([, message]) => /empty/i.test(String(message)) && /store|rules/i.test(String(message)))).toBe(true);
  });

  test("AC-21: an empty rule store resolves", async () => {
    await expect(rulesLintCommand({ dir: RULE_ROOT }, makeLintDeps({ roots: [], rulesForRoot: async () => [] }))).resolves.toBeUndefined();
  });

  test("AC-22: an empty rule store writes a WARN summary", async () => {
    const capture = captureStdout();
    try {
      await rulesLintCommand({ dir: RULE_ROOT }, makeLintDeps({ roots: [], rulesForRoot: async () => [] }));
    } finally {
      capture.restore();
    }
    expect(capture.lines.some((line) => /\[WARN\]/.test(line))).toBe(true);
  });

  test("AC-23: an empty rule store does not write an OK summary", async () => {
    const capture = captureStdout();
    try {
      await rulesLintCommand({ dir: RULE_ROOT }, makeLintDeps({ roots: [], rulesForRoot: async () => [] }));
    } finally {
      capture.restore();
    }
    expect(capture.lines.some((line) => /\[OK\]/.test(line))).toBe(false);
  });

  test("AC-24: a non-empty warning-free store emits no empty-store warning", async () => {
    const logger = { warn: mock(() => {}) };
    await rulesLintCommand(
      { dir: RULE_ROOT },
      makeLintDeps({ roots: [ROOT_ONE], rulesForRoot: async () => [makeRule({ warnings: [] })], logger }),
    );
    expect(logger.warn.mock.calls.some(([, message]) => /empty.*store|empty.*rules/i.test(String(message)))).toBe(false);
  });
});
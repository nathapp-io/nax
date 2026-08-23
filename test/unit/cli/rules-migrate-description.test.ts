/**
 * rules.ts CLI — US-001 AC9 description migrate-then-load test
 *
 * Split from rules.test.ts to keep that file under the 800-line file-size limit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _rulesCLIDeps, rulesMigrateCommand } from "@/cli/rules";
import { makeLogger } from "@test/helpers";

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

/**
 * rules.ts CLI — US-001 dry-run / real-run parity tests
 *
 * Split from rules.test.ts to keep that file under the 800-line file-size
 * limit. Covers AC-7 through AC-14: the dry-run preview must equal the
 * real run by going through the same planMigration and the same write-or-
 * skip decision.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type MigrationOutcome, _rulesCLIDeps, rulesMigrateCommand } from "@/cli";

let origReadFile: typeof _rulesCLIDeps.readFile;
let origWriteFile: typeof _rulesCLIDeps.writeFile;
let origFileExists: typeof _rulesCLIDeps.fileExists;
let origGlobInDir: typeof _rulesCLIDeps.globInDir;
let origMkdir: typeof _rulesCLIDeps.mkdir;

const written: Record<string, string> = {};

beforeEach(() => {
  origReadFile = _rulesCLIDeps.readFile;
  origWriteFile = _rulesCLIDeps.writeFile;
  origFileExists = _rulesCLIDeps.fileExists;
  origGlobInDir = _rulesCLIDeps.globInDir;
  origMkdir = _rulesCLIDeps.mkdir;

  Object.keys(written).forEach((k) => delete written[k]);

  _rulesCLIDeps.readFile = async () => "";
  _rulesCLIDeps.writeFile = async (path, content) => {
    written[path] = content;
  };
  _rulesCLIDeps.fileExists = async () => false;
  _rulesCLIDeps.globInDir = () => [];
  _rulesCLIDeps.mkdir = async () => {};
});

afterEach(() => {
  _rulesCLIDeps.readFile = origReadFile;
  _rulesCLIDeps.writeFile = origWriteFile;
  _rulesCLIDeps.fileExists = origFileExists;
  _rulesCLIDeps.globInDir = origGlobInDir;
  _rulesCLIDeps.mkdir = origMkdir;
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
    Object.keys(written).forEach((k) => delete written[k]);
    const realRun = await rulesMigrateCommand({ dir: "/project", force: true, dryRun: false });
    expect(new Set(dryRun.written)).toEqual(new Set(realRun.written));
  });

  test("AC-10: dry-run and real-run report equal skipped file-name sets (force=false)", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    const dryRun = await rulesMigrateCommand({ dir: "/project", dryRun: true });
    Object.keys(written).forEach((k) => delete written[k]);
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
    Object.keys(written).forEach((k) => delete written[k]);
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
    Object.keys(written).forEach((k) => delete written[k]);
    const realRun = await rulesMigrateCommand({ dir: "/project", dryRun: false });
    expect(dryRun.skipped).toContain("project-conventions.md");
    expect(realRun.skipped).toContain("project-conventions.md");
  });

  test("AC-14: an existing unforced target is absent from writes in both dry-run and real-run", async () => {
    _rulesCLIDeps.globInDir = () => ["/project/.claude/rules/project-conventions.md"];
    _rulesCLIDeps.fileExists = async (p) => p === "/project/.nax/rules/project-conventions.md";
    _rulesCLIDeps.readFile = async () => "## Style\n\nContent.";
    const dryRun = await rulesMigrateCommand({ dir: "/project", dryRun: true });
    Object.keys(written).forEach((k) => delete written[k]);
    const realRun = await rulesMigrateCommand({ dir: "/project", dryRun: false });
    expect(dryRun.written).not.toContain("project-conventions.md");
    expect(realRun.written).not.toContain("project-conventions.md");
  });
});

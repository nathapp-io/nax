import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { type RulesLintDeps, rulesLintCommand } from "@/cli/rules-lint";
import type { CanonicalRule } from "@/context/rules/canonical-loader";

const WORKDIR = "/project";
const FILE_GLOB = "apps/api/src/**/*";

function makeRule(paths?: string[]): CanonicalRule {
  return { fileName: "scoped.md", path: "scoped.md", content: "Body.", warnings: [], paths };
}

function setup(paths?: string[], packages = ["apps/api"]) {
  const logger = makeLogger();
  const deps: RulesLintDeps = {
    globCanonicalRuleFiles: () => [],
    loadCanonicalRules: async () => [makeRule(paths)],
    globHasMatch: () => "match",
    discoverWorkspacePackages: async () => packages,
    getLogger: () => logger,
  };
  const warnings = () =>
    logger.calls.filter(
      (call) => call.level === "warn" && call.stage === "rules-lint" && call.data?.code === "PATHS_MATCH_NO_PACKAGE",
    );
  return { deps, logger, warnings };
}

describe("rulesLintCommand — package paths", () => {
  let stdout: ReturnType<typeof spyOn<typeof console, "log">>;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = spyOn(console, "log").mockImplementation(() => {});
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdout.mockRestore();
    process.exitCode = savedExitCode;
  });

  test("AC-1: warns for a file glob that matches no package directory", async () => {
    const { deps, warnings } = setup([FILE_GLOB]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings()).toHaveLength(1);
  });

  test.each([
    ["AC-2", "pattern", FILE_GLOB],
    ["AC-3", "file", "scoped.md"],
    ["root metadata", "root", WORKDIR],
  ])("%s: identifies the unmatched rule path (%s)", async (_ac, field, expected) => {
    const { deps, warnings } = setup([FILE_GLOB]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings()[0]?.data?.[field]).toBe(expected);
  });

  test("AC-4: recommends appliesTo: for file globs", async () => {
    const { deps, warnings } = setup([FILE_GLOB]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings()[0]?.message).toContain("appliesTo:");
  });

  test.each(["apps/api/*", "apps/api/**"])("AC-5/AC-6: accepts package glob %s", async (pattern) => {
    const { deps, warnings } = setup([pattern]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings()).toEqual([]);
  });

  test("AC-7: warns separately for each unmatched glob", async () => {
    const paths = ["packages/core/src/x/*", "packages/core/tests/unit/x/*"];
    const { deps, warnings } = setup(paths, ["packages/core"]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings().map((call) => call.data?.pattern)).toEqual(paths);
  });

  test("AC-8: warns only for the unmatched glob in a mixed list", async () => {
    const { deps, warnings } = setup(["apps/api/*", FILE_GLOB]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings().map((call) => call.data?.pattern)).toEqual([FILE_GLOB]);
  });

  test("AC-9: retains INERT_PATHS instead for a single-package repo", async () => {
    const { deps, logger, warnings } = setup([FILE_GLOB], []);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings()).toEqual([]);
    expect(logger.calls.filter((call) => call.data?.code === "INERT_PATHS")).toHaveLength(1);
  });

  test("AC-10: skips package-scope checks when discovery rejects", async () => {
    const { deps, logger, warnings } = setup([FILE_GLOB]);
    deps.discoverWorkspacePackages = async () => {
      throw new Error("discovery failed");
    };
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings()).toEqual([]);
    expect(logger.calls).toEqual([]);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("[OK]"));
  });

  test("AC-11: counts the package-path warning in the stdout summary", async () => {
    const { deps, logger } = setup([FILE_GLOB]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("[WARN] Canonical rules lint completed with 1 warning(s)"),
    );
    expect(logger.calls).toHaveLength(1);
  });

  test("AC-12: a package-path warning does not fail lint or set an exit code", async () => {
    const { deps, warnings } = setup([FILE_GLOB]);
    await expect(rulesLintCommand({ dir: WORKDIR }, deps)).resolves.toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  test("does not check rules loaded from nested package roots", async () => {
    const { deps, warnings } = setup([FILE_GLOB]);
    deps.globCanonicalRuleFiles = () => ["apps/api/.nax/rules/scoped.md"];
    deps.loadCanonicalRules = async (root) => (root === WORKDIR ? [makeRule()] : [makeRule([FILE_GLOB])]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings()).toEqual([]);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("2 file(s) across 2 rule roots"));
  });

  test("accepts a glob matching any discovered package, not only the first", async () => {
    const { deps, warnings } = setup(["apps/api/**"], ["apps/web", "apps/api"]);
    await rulesLintCommand({ dir: WORKDIR }, deps);
    expect(warnings()).toEqual([]);
  });
});

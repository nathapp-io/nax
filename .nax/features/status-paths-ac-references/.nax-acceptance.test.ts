import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Command } from "commander";

const referenceSpec = [
  "# Feature",
  "## Acceptance Criteria",
  "### US-001",
  "1. [unit] foo() returns 1.",
  "2. [unit] In the AC-1 setup, foo() returns 2.",
].join("\n");
const warning = "PRD acceptance criterion refers to another criterion by number — AC numbering is not stable across plan runs";
const stamp = "2026-09-28T10-00-00";

function story(id: string, status: "passed" | "pending" = "pending", acceptanceCriteria: string[] = ["foo() returns 1"]) {
  return {
    id, title: `Story ${id}`, description: "Test story", acceptanceCriteria,
    tags: [], dependencies: [], escalations: [], attempts: 0,
    status, passes: status === "passed",
  };
}
function prd(feature: string, userStories = [story("US-001", "passed"), story("US-002")]) {
  return {
    project: "test-project", feature, branchName: `feat/${feature}`,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", userStories,
  };
}
function status(runStatus: "crashed" | "completed" = "completed", spent = 1.5) {
  return {
    version: 1,
    run: { id: "run-test", feature: "feat-a", startedAt: "2026-01-01T00:00:00.000Z", status: runStatus, dryRun: false, pid: 999999 },
    progress: { total: 2, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 1 },
    cost: { spent, limit: null }, current: null, iterations: 1,
    updatedAt: "2026-01-01T00:00:00.000Z", durationMs: 100,
  };
}
function put(path: string, content: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}
async function stdout(action: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { await action(); } finally { console.log = original; }
  return lines.join("\n");
}
function rows(output: string): string[] {
  return output.split("\n").map((line) => line.trimStart());
}
function cell(output: string, name: string, column: string): string {
  const lines = output.split("\n");
  const header = lines.find((line) => /\bFeature\s+Done\s+Failed\s+Pending\s+Last Run\s+Cost\s+Status\b/.test(line));
  expect(header).toBeDefined();
  const starts = ["Feature", "Done", "Failed", "Pending", "Last Run", "Cost", "Status"].map((label) => header!.indexOf(label));
  expect(starts.every((n) => n >= 0)).toBe(true);
  const row = lines.find((line) => line.trimStart().startsWith(`${name} `));
  expect(row).toBeDefined();
  const index = ["Feature", "Done", "Failed", "Pending", "Last Run", "Cost", "Status"].indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  return row!.slice(starts[index], starts[index + 1] ?? undefined).trim();
}

// All status checks are runtime checks with isolated filesystem fixtures and a restored dependency seam.
describe("status paths acceptance", () => {
  let R: string;
  let O: string;
  let originalOutputDir: ((...args: any[]) => string) | undefined;
  beforeEach(async () => {
    R = mkdtempSync(join(tmpdir(), "nax-status-root-"));
    O = mkdtempSync(join(tmpdir(), "nax-status-output-"));
    put(join(R, ".nax", "config.json"), { name: "status-test" });
    put(join(R, ".nax", "features", "feat-a", "prd.json"), prd("feat-a"));
    const { _statusFeaturesDeps } = await import("../../../src/cli/status-features");
    originalOutputDir = _statusFeaturesDeps.projectOutputDir;
    _statusFeaturesDeps.projectOutputDir = () => O;
  });
  afterEach(async () => {
    const { _statusFeaturesDeps } = await import("../../../src/cli/status-features");
    _statusFeaturesDeps.projectOutputDir = originalOutputDir!;
    rmSync(R, { recursive: true, force: true });
    rmSync(O, { recursive: true, force: true });
  });
  async function display(options: { feature?: string; dir: string }) {
    const { displayFeatureStatus } = await import("../../../src/cli/status-features");
    return stdout(() => displayFeatureStatus(options));
  }
  test("AC-1: single-feature status reads both stories from the project .nax fixture", async () => {
    const out = await display({ feature: "feat-a", dir: R });
    expect(out).toContain("US-001"); expect(out).toContain("US-002"); expect(out).not.toContain("No prd.json found");
  });
  test("AC-2: crashed feature status displays a crashed-run banner", async () => {
    put(join(R, ".nax/features/feat-a/status.json"), status("crashed"));
    expect(await display({ feature: "feat-a", dir: R })).toContain("Crashed Run Detected");
  });
  test("AC-3: single-feature status resolves a nested package without its own .nax", async () => {
    mkdirSync(join(R, "packages/app"), { recursive: true });
    const out = await display({ feature: "feat-a", dir: join(R, "packages/app") });
    expect(out).toContain("US-001"); expect(out).not.toContain("No prd.json found");
  });
  test("AC-4: output directory PRD cannot override project feature PRD", async () => {
    put(join(O, "features/feat-a/prd.json"), prd("feat-a", [story("US-099")]));
    const out = await display({ feature: "feat-a", dir: R });
    expect(out).toContain("US-001"); expect(out).not.toContain("US-099");
  });
  test("AC-5: missing feature PRD gives a planning hint", async () => {
    mkdirSync(join(R, ".nax/features/feat-b"), { recursive: true });
    const out = await display({ feature: "feat-b", dir: R });
    expect(out).toContain("No prd.json found"); expect(out).toContain("nax plan -f feat-b --from <spec>");
  });
  test("AC-6: all-features view lists project features even when output features is absent", async () => {
    expect(existsSync(join(O, "features"))).toBe(false);
    put(join(R, ".nax/features/feat-b/prd.json"), prd("feat-b", [story("US-003")]));
    const lines = rows(await display({ dir: R }));
    expect(lines.filter((line) => line.startsWith("feat-a "))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("feat-b "))).toHaveLength(1);
  });
  test("AC-7: feature table counts passed and pending stories", async () => {
    const out = await display({ dir: R });
    expect(cell(out, "feat-a", "Done")).toBe("1"); expect(cell(out, "feat-a", "Pending")).toBe("1");
  });
  test("AC-8: feature table uses the output directory for the latest run", async () => {
    put(join(O, `features/feat-a/runs/${stamp}.jsonl`), "");
    expect(cell(await display({ dir: R }), "feat-a", "Last Run")).toBe(stamp);
  });
  test("AC-9: feature table uses project feature status for cost", async () => {
    put(join(R, ".nax/features/feat-a/status.json"), status("completed", 1.5));
    expect(cell(await display({ dir: R }), "feat-a", "Cost")).toBe("$1.5000");
  });
  test("AC-10: output-only ghost runs do not create a feature row", async () => {
    put(join(O, `features/ghost/runs/${stamp}.jsonl`), "");
    expect(existsSync(join(R, ".nax/features/ghost"))).toBe(false);
    expect(rows(await display({ dir: R })).some((line) => line.startsWith("ghost "))).toBe(false);
  });
  test("AC-11: project with no feature directory reports no features", async () => {
    rmSync(join(R, ".nax/features"), { recursive: true, force: true });
    expect(await display({ dir: R })).toContain("No features found.");
  });
  test("AC-12: all-features view resolves nested package project root", async () => {
    mkdirSync(join(R, "packages/app"), { recursive: true });
    expect(rows(await display({ dir: join(R, "packages/app") })).some((line) => line.startsWith("feat-a "))).toBe(true);
  });
  test("AC-13: Commander default status action reads project feature PRD", async () => {
    const { registerStatusCommand } = await import("../../../src/cli/status-dispatch");
    const program = new Command();
    registerStatusCommand(program);
    const out = await stdout(() => program.parseAsync(["status", "-f", "feat-a", "--dir", R], { from: "user" }));
    expect(out).toContain("US-001"); expect(out).not.toContain("No prd.json found");
  });
  test("AC-14: feature without runs displays No runs yet", async () => {
    expect(existsSync(join(O, "features/feat-a/runs"))).toBe(false);
    expect(cell(await display({ dir: R }), "feat-a", "Last Run")).toBe("No runs yet");
  });
  test("AC-15: uninitialized isolated directory still shows a missing PRD hint", async () => {
    const T = mkdtempSync(join(tmpdir(), "nax-uninitialized-"));
    try {
      expect(existsSync(join(T, ".nax/config.json"))).toBe(false);
      const out = await display({ feature: "feat-a", dir: T });
      expect(out).toContain("No prd.json found"); expect(out).toContain("nax plan -f feat-a --from <spec>");
    } finally { rmSync(T, { recursive: true, force: true }); }
  });
  test("AC-16: malformed config falls back to project root basename for output lookup", async () => {
    put(join(R, ".nax/config.json"), "not json");
    const { _statusFeaturesDeps } = await import("../../../src/cli/status-features");
    const calls: unknown[][] = [];
    _statusFeaturesDeps.projectOutputDir = (...args: any[]) => { calls.push(args); return O; };
    await display({ dir: R });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(([key]) => key === basename(R))).toBe(true);
  });
  test("AC-17: feature without PRD has zero story counts in the table", async () => {
    mkdirSync(join(R, ".nax/features/feat-b"), { recursive: true });
    const out = await display({ dir: R });
    expect(cell(out, "feat-b", "Done")).toBe("0");
    expect(cell(out, "feat-b", "Failed")).toBe("0");
    expect(cell(out, "feat-b", "Pending")).toBe("0");
  });
});

// Numeric-reference parsing and linting are pure runtime checks.
describe("numeric AC references acceptance", () => {
  test("AC-18: hyphenated numeric reference is found via PRD barrel", async () => {
    const { findAcNumericReferences } = await import("../../../src/prd");
    expect(findAcNumericReferences("In the AC-7 shape, a write fails")).toEqual(["AC-7"]);
  });
  test("AC-19: spaced numeric reference is normalized", async () => {
    const { findAcNumericReferences } = await import("../../../src/prd");
    expect(findAcNumericReferences("Given the AC 14 setup, the call is rejected")).toEqual(["AC-14"]);
  });
  test("AC-20: repeated references deduplicate in first-seen order", async () => {
    const { findAcNumericReferences } = await import("../../../src/prd");
    expect(findAcNumericReferences("AC-3 holds, then AC-12 and AC-3 again")).toEqual(["AC-3", "AC-12"]);
  });
  test("AC-21: nondigit AC-ERROR and AC-HOOK sentinels are excluded", async () => {
    const { findAcNumericReferences } = await import("../../../src/prd");
    expect(findAcNumericReferences('failedACs equals ["AC-ERROR"] and the AC-HOOK sentinel is set')).toEqual([]);
  });
  test("AC-22: inline code reference is excluded", async () => {
    const { findAcNumericReferences } = await import("../../../src/prd");
    expect(findAcNumericReferences("the test titled `AC-1: a` passes.")).toEqual([]);
  });
  test("AC-23: ordinary prose has no numeric references", async () => {
    const { findAcNumericReferences } = await import("../../../src/prd");
    expect(findAcNumericReferences("the refined criterion is returned unchanged")).toEqual([]);
  });
  test("AC-24: spec lint produces one warning for a numeric cross-reference", async () => {
    const { lintSpecContent } = await import("../../../src/prd");
    const findings = lintSpecContent(referenceSpec);
    expect(findings).toHaveLength(1); expect(findings[0].code).toBe("ac-numeric-reference"); expect(findings[0].level).toBe("warn");
  });
  test("AC-25: lint warning identifies the story, criterion and reference", async () => {
    const { lintSpecContent } = await import("../../../src/prd");
    const findings = lintSpecContent(referenceSpec);
    expect(findings.filter((f) => f.code === "ac-numeric-reference")).toHaveLength(1);
    expect(findings[0].message).toContain("US-001 AC 2"); expect(findings[0].message).toContain("AC-1");
  });
  test("AC-26: numeric-reference warning is not a blocking lint code", async () => {
    const { BLOCKING_SPEC_LINT_CODES } = await import("../../../src/prd");
    expect(BLOCKING_SPEC_LINT_CODES.has("ac-numeric-reference")).toBe(false);
  });
  test("AC-27: inline code inside an AC bullet is not a lint reference", async () => {
    const { lintSpecContent } = await import("../../../src/prd");
    const spec = "## Acceptance Criteria\n### US-001\n1. [unit] the test titled `AC-1: a` passes.";
    expect(lintSpecContent(spec).filter((f) => f.code === "ac-numeric-reference")).toHaveLength(0);
  });
  test("AC-28: numeric reference in design prose is not an AC lint finding", async () => {
    const { lintSpecContent } = await import("../../../src/prd");
    const spec = "## Design\nsee AC-3 below\n## Acceptance Criteria\n### US-001\n1. [unit] foo() returns 1.";
    expect(lintSpecContent(spec).filter((f) => f.code === "ac-numeric-reference")).toHaveLength(0);
  });
  test("AC-29: spec lint gate returns the nonblocking numeric-reference finding", async () => {
    const { assertSpecLintClean } = await import("../../../src/plan/spec-lint-gate");
    const tempDir = mkdtempSync(join(tmpdir(), "nax-spec-gate-"));
    try {
      const findings = assertSpecLintClean(referenceSpec, { specPath: "spec.md", featureName: "f", workdir: tempDir });
      expect(findings.some((f) => f.code === "ac-numeric-reference")).toBe(true);
    } finally { rmSync(tempDir, { recursive: true, force: true }); }
  });
  test("AC-30: strict CLI spec lint accepts warning-only reference spec", async () => {
    const { specLintCommand, _specLintCommandDeps } = await import("../../../src/cli/spec-lint-command");
    const tempDir = mkdtempSync(join(tmpdir(), "nax-spec-cli-"));
    try {
      const referenceSpecPath = join(tempDir, "spec.md");
      put(referenceSpecPath, referenceSpec);
      const result = await specLintCommand({ dir: tempDir, paths: [referenceSpecPath], strict: true }, {
        ..._specLintCommandDeps, readFile: async () => referenceSpec, write: () => {},
      });
      expect(result.exitCode).toBe(0);
    } finally { rmSync(tempDir, { recursive: true, force: true }); }
  });
});

async function withWarnings<T>(action: (entries: import("../../../src/logger").LogEntry[]) => T | Promise<T>): Promise<T> {
  const { addSink, initLogger, resetLogger } = await import("../../../src/logger");
  resetLogger();
  initLogger({ level: "debug", suppressConsole: true });
  const entries: import("../../../src/logger").LogEntry[] = [];
  addSink((entry) => entries.push(entry));
  try { return await action(entries); } finally { resetLogger(); }
}

describe("plan warning acceptance", () => {
  const one = () => prd("feat", [story("US-001", "pending", ["foo() returns 1", "Given the AC-1 setup, foo() returns 2"])]);
  test("AC-31: PRD numeric reference emits exactly one plan warning with prescribed message", async () => {
    const { warnOnAcCrossReferences } = await import("../../../src/operations/plan-fidelity");
    await withWarnings((entries) => {
      warnOnAcCrossReferences(one(), "feat");
      const warns = entries.filter((e) => e.level === "warn");
      expect(warns).toHaveLength(1); expect(warns[0].stage).toBe("plan"); expect(warns[0].message).toBe(warning);
    });
  });
  test("AC-32: warning data leads with storyId and records criterion index and references", async () => {
    const { warnOnAcCrossReferences } = await import("../../../src/operations/plan-fidelity");
    await withWarnings((entries) => {
      warnOnAcCrossReferences(one(), "feat");
      const warns = entries.filter((e) => e.level === "warn");
      expect(warns).toHaveLength(1);
      const data = warns[0].data!;
      expect(Object.keys(data)[0]).toBe("storyId"); expect(data.storyId).toBe("US-001");
      expect(data.featureName).toBe("feat"); expect(data.acIndex).toBe(2); expect(data.references).toEqual(["AC-1"]);
    });
  });
  test("AC-33: cross-references in two stories yield one warning per story", async () => {
    const { warnOnAcCrossReferences } = await import("../../../src/operations/plan-fidelity");
    const input = prd("feat", [
      story("US-001", "pending", ["foo() returns 1", "In the AC-1 shape, bar() throws"]),
      story("US-002", "pending", ["Given the AC 3 setup, baz() returns 0"]),
    ]);
    await withWarnings((entries) => {
      warnOnAcCrossReferences(input, "feat");
      const warns = entries.filter((e) => e.level === "warn" && e.message === warning);
      expect(warns).toHaveLength(2);
      expect(warns.map((e) => e.data?.storyId).sort()).toEqual(["US-001", "US-002"]);
    });
  });
  test("AC-34: PRD with no numeric references emits no cross-reference warning", async () => {
    const { warnOnAcCrossReferences } = await import("../../../src/operations/plan-fidelity");
    await withWarnings((entries) => {
      warnOnAcCrossReferences(prd("feat", [story("US-001", "pending", ["foo() returns 1", "bar() throws"])]), "feat");
      expect(entries.filter((e) => e.level === "warn" && e.message === warning)).toHaveLength(0);
    });
  });
  test("AC-35: plan fidelity emits cross-reference warning without optional spec sections", async () => {
    const { applyPlanFidelity } = await import("../../../src/operations/plan-fidelity");
    await withWarnings((entries) => {
      applyPlanFidelity(one(), "# Feature\n\n## Design\nSimple design.", "feat");
      expect(entries.filter((e) => e.level === "warn" && e.message === warning)).toHaveLength(1);
    });
  });
  test("AC-36: plan fidelity warning leaves PRD acceptance criteria intact", async () => {
    const { applyPlanFidelity } = await import("../../../src/operations/plan-fidelity");
    await withWarnings(() => {
      const input = one();
      const before = [...input.userStories[0].acceptanceCriteria];
      const result = applyPlanFidelity(input, "# Feature\n\n## Design\nSimple design.", "feat");
      expect(result.userStories[0].acceptanceCriteria).toEqual(before);
    });
  });
});
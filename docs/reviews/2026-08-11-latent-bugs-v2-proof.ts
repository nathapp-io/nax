#!/usr/bin/env bun
/**
 * Reproducible proof harness for docs/reviews/2026-08-11-code-review-latent-bugs-v2.md
 *
 * Run from anywhere:  bun docs/reviews/2026-08-11-latent-bugs-v2-proof.ts
 *
 * Every check is an ASSERTION against the real production module: it prints
 * PASS when the defect reproduces exactly as the finding describes, and FAIL
 * when it does not. The process exits non-zero if any check fails, so the
 * harness is self-verifying — "it printed something" is not evidence.
 *
 * Scope: only findings whose trigger is reachable from a pure function or an
 * injectable-dep boundary. GRAPH/SRC-proved findings (dead wiring, call-site
 * traces) are not executable and are listed in Appendix A of the review instead.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH = await mkdtemp(join(tmpdir(), "nax-proof-"));

let passed = 0;
let failed = 0;

/** Assert a finding reproduces. `actual` and `expected` are compared as JSON. */
function check(id: string, what: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`PASS  ${id}  ${what}\n        => ${a}`);
  } else {
    failed++;
    console.log(`FAIL  ${id}  ${what}\n        expected: ${e}\n        actual:   ${a}`);
  }
}

/** Run `git` in `cwd`, returning stdout. */
function git(cwd: string, args: string[]): string {
  return Bun.spawnSync(["git", ...args], { cwd }).stdout.toString();
}

// ─── BUG-01/02: PRD dependency normalization + duplicate ids ────────────────
async function bug01and02(): Promise<void> {
  const { validatePlanOutput } = await import(`${ROOT}/src/prd/schema.ts`);
  const story = (id: string, deps: string[]) => ({
    id,
    title: "t",
    description: "d",
    acceptanceCriteria: ["AC-1: x"],
    complexity: "simple",
    testStrategy: "tdd-simple",
    dependencies: deps,
  });

  // BUG-01: dep "ST001" (unnormalized) is accepted, stored raw, never matches "ST-001".
  const prd = validatePlanOutput({ userStories: [story("ST-001", []), story("ST-002", ["ST001"])] }, "f", "b");
  const storedDep = prd.userStories[1].dependencies[0];
  const storyIds = new Set(prd.userStories.map((s: { id: string }) => s.id));
  check(
    "BUG-01",
    "validatePlanOutput accepts dep 'ST001'; stored raw and unmatched by story ids",
    { storedDep, matched: storyIds.has(storedDep) },
    { storedDep: "ST001", matched: false },
  );

  // BUG-02: two stories with the same id pass validation unchanged.
  const dup = validatePlanOutput({ userStories: [story("ST-001", []), story("ST-001", [])] }, "f", "b");
  check(
    "BUG-02",
    "validatePlanOutput accepts duplicate story id ST-001 x2",
    dup.userStories.map((s: { id: string }) => s.id),
    ["ST-001", "ST-001"],
  );
}

// ─── BUG-03: empty canonical-rule frontmatter throws ────────────────────────
async function bug03(): Promise<void> {
  const { parseFrontmatter } = await import(`${ROOT}/src/context/rules/rules-frontmatter.ts`);
  const outcome = (input: string): string => {
    try {
      parseFrontmatter(input, "rules/x.md");
      return "parsed";
    } catch (e) {
      return `throws: ${(e as Error).message}`;
    }
  };
  check(
    "BUG-03",
    "compact empty block '---\\n---\\n' cannot match the closing regex",
    outcome("---\n---\n"),
    "throws: Canonical rule frontmatter is missing closing '---'",
  );
  check(
    "BUG-03",
    "one blank line between the delimiters parses fine (isolates the regex as the cause)",
    outcome("---\n\n---\n"),
    "parsed",
  );
}

// ─── BUG-06: scoped verify returns "passed" on exit 0 with zero tests run ────
async function bug06(): Promise<void> {
  const { verifyScopedOp } = await import(`${ROOT}/src/operations/verify-scoped.ts`);
  const { parseTestOutput } = await import(`${ROOT}/src/test-runners/parser.ts`);
  const config = {
    quality: { commands: { test: "go test ./...", testScoped: "go test -run '{{testNames}}' ./..." } },
    execution: { regressionGate: { timeoutSeconds: 600 }, smartTestRunner: { enabled: true } },
  };
  const ctx = {
    packageView: { select: () => config, hasOverride: false, packageDir: ".", repoRoot: SCRATCH },
    runtime: {},
  };
  const deps = {
    selectScopedTests: async () => ({
      effectiveCommand: "go test -run X ./...",
      isFullSuite: false,
      scopeTestFallback: false,
      thresholdFallback: false,
      isMonorepoOrchestrator: false,
      changedTestFiles: [],
      mappedTestCount: 1,
      selectionBasis: "unchanged-files",
    }),
    // Go emits "[no test files]" and exits 0 when a package has only helpers.
    regression: async () => ({
      success: true,
      exitCode: 0,
      status: "passed",
      output: "?   \tpackage [no test files]\nok  \tpackage/helper (0.00s)\n",
      durationMs: 10,
    }),
    parseTestOutput,
    testSummaryToFindings: () => [],
  };
  // biome-ignore lint/suspicious/noExplicitAny: harness injects minimal ctx/deps shapes
  const out = await verifyScopedOp.execute(
    { workdir: SCRATCH, storyId: "US-001", packageDir: "." },
    ctx as any,
    deps as any,
  );
  check(
    "BUG-06",
    "exit 0 + '[no test files]' on a scoped run reports a false green",
    { success: out.success, status: out.status, passCount: out.passCount },
    { success: true, status: "passed", passCount: 0 },
  );
}

// ─── BUG-10: per-package models override replaces the whole tier map ─────────
async function bug10(): Promise<void> {
  const { mergePackageConfig } = await import(`${ROOT}/src/config/merge.ts`);
  const root = {
    agent: {},
    models: {
      claude: { fast: { model: "claude-fast" }, balanced: { model: "claude-bal" }, powerful: { model: "claude-pow" } },
      gemini: { fast: { model: "gem-fast" }, balanced: { model: "gem-bal" }, powerful: { model: "gem-pow" } },
    },
    routing: {},
    execution: {
      worktreeDependencies: {},
      regressionGate: {},
      flakeDetection: {},
      mutationCheck: {},
      rectification: {},
    },
    review: { commands: {}, semantic: {}, adversarial: {} },
    acceptance: { fix: {} },
    quality: { commands: {}, testing: {}, autofix: {}, lintOutput: {} },
    context: { testCoverage: {}, v2: { stages: {}, rules: {} } },
    project: {},
  };
  // biome-ignore lint/suspicious/noExplicitAny: partial config shapes are the point of the test
  const merged = mergePackageConfig(root as any, { models: { claude: { fast: { model: "pkg-claude-fast" } } } } as any);
  check(
    "BUG-10",
    "overriding models.claude.fast drops the root balanced/powerful tiers",
    { claude: Object.keys(merged.models.claude), gemini: Object.keys(merged.models.gemini) },
    { claude: ["fast"], gemini: ["fast", "balanced", "powerful"] },
  );
}

// ─── BUG-13: unanchored AC regex fabricates phantom AC ids ──────────────────
async function bug13(): Promise<void> {
  const { parseTestFailures } = await import(`${ROOT}/src/test-runners/ac-parser.ts`);
  // Counter-example: the review's original `TestACL2_Check` example does NOT match.
  check(
    "BUG-13",
    "counter-example — 'TestACL2_Check' does not produce a phantom AC",
    parseTestFailures("--- FAIL: TestACL2_Check (0.00s)\n    x_test.go:10: failed"),
    [],
  );
  check(
    "BUG-13",
    "go branch — 'TestMac_2' fabricates AC-2",
    parseTestFailures("--- FAIL: TestMac_2 (0.00s)\n    mac_test.go:10: failed"),
    ["AC-2"],
  );
  check(
    "BUG-13",
    "jest/vitest branch — 'TestMac2' fabricates AC-2",
    parseTestFailures("● TestMac2 > does stuff\n\n  AssertionError: nope"),
    ["AC-2"],
  );
  check(
    "BUG-13",
    "pytest branch — 'test_mac_2.py' fabricates AC-2",
    parseTestFailures("FAILED tests/test_mac_2.py::test_x - AssertionError"),
    ["AC-2"],
  );
}

// ─── BUG-14: `(\d+)\s+fail` fallback misreads green suites with log noise ────
async function bug14(): Promise<void> {
  const { analyzeTestExitCode } = await import(`${ROOT}/src/test-runners/parser.ts`);
  const r = analyzeTestExitCode("suite start\nWARN: 3 failed requests in the log\ntests ran fine\n", 0);
  check(
    "BUG-14",
    "an app log line 'WARN: 3 failed requests' turns an exit-0 run red",
    { allTestsPassed: r.allTestsPassed, failCount: r.failCount, isEnvironmentalFailure: r.isEnvironmentalFailure },
    { allTestsPassed: false, failCount: 3, isEnvironmentalFailure: false },
  );
}

// ─── BUG-15: parseMochaOutput takes the FIRST `N passing` match ──────────────
async function bug15(): Promise<void> {
  const { parseMochaOutput } = await import(`${ROOT}/src/test-runners/parse-mocha.ts`);
  const r = parseMochaOutput("spec1: 0 passing\nspec2: 5 passing, 1 failing\n\n5 passing\n1 failing\n");
  check(
    "BUG-15",
    "per-spec '0 passing' wins over the final '5 passing' summary",
    { passed: r.passed, failed: r.failed },
    { passed: 0, failed: 1 },
  );
}

// ─── BUG-16/17: bun parser file attribution + (fail) name truncation ─────────
async function bug16and17(): Promise<void> {
  const { parseBunTestOutput } = await import(`${ROOT}/src/test-runners/parser.ts`);
  const r = parseBunTestOutput(
    ["test/foo.test.tsx:", "  ✗ it renders", "(fail) render [5ms] timeout handling [1.2ms]", "0 pass", "1 fail"].join(
      "\n",
    ),
  );
  check(
    "BUG-16",
    "a .test.tsx header is not recognised — failure attributed to 'unknown'",
    r.failures[0]?.file,
    "unknown",
  );
  check(
    "BUG-17",
    "a test name containing '[5ms]' is truncated at the first bracket",
    r.failures[0]?.testName,
    "render",
  );
}

// ─── BUG-25: queue commands lost on crash between rename and clear ───────────
async function bug25(): Promise<void> {
  const { readQueueFile, clearQueueFile } = await import(`${ROOT}/src/execution/queue-handler.ts`);
  const dir = join(SCRATCH, "queue-crash");
  await Bun.write(join(dir, ".queue.txt"), "PAUSE\n");

  // biome-ignore lint/suspicious/noExplicitAny: queue command union narrowed to .type only
  const first = (await readQueueFile(dir)).map((c: any) => c.type);
  // Simulated crash: the run dies here, so clearQueueFile never runs and
  // .queue.txt.processing is left behind holding the un-applied PAUSE.
  await Bun.write(join(dir, ".queue.txt"), "SKIP US-002\n");
  // biome-ignore lint/suspicious/noExplicitAny: same
  const second = (await readQueueFile(dir)).map((c: any) => c.type);
  const orphaned = await Bun.file(join(dir, ".queue.txt.processing")).text();

  check(
    "BUG-25",
    "the next readQueueFile renames over the orphaned .processing — PAUSE is gone forever",
    { first, second, pauseRecovered: orphaned.includes("PAUSE") },
    { first: ["PAUSE"], second: ["SKIP"], pauseRecovered: false },
  );
  await clearQueueFile(dir);
}

// ─── BUG-26: queue-writer read-modify-write resurrects consumed commands ─────
async function bug26(): Promise<void> {
  const { writeQueueCommand } = await import(`${ROOT}/src/utils/queue-writer.ts`);
  const { readQueueFile, clearQueueFile } = await import(`${ROOT}/src/execution/queue-handler.ts`);
  const dir = join(SCRATCH, "queue-toctou");
  const path = join(dir, ".queue.txt");
  await Bun.write(path, "SKIP US-001\n");

  // Drive the REAL writeQueueCommand and interleave the consumer inside its
  // read-modify-write window by intercepting the write half of the operation.
  const realWrite = Bun.write;
  let consumed: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: temporary global interception for the race window
  (Bun as any).write = async (target: unknown, data: unknown, ...rest: unknown[]) => {
    if (target === path) {
      // biome-ignore lint/suspicious/noExplicitAny: restore before re-entering consumer code
      (Bun as any).write = realWrite;
      // Consumer runs between the writer's read (queue-writer.ts:64) and its
      // write (queue-writer.ts:68): it renames the file away and clears it.
      // biome-ignore lint/suspicious/noExplicitAny: queue command union narrowed to .type only
      consumed = (await readQueueFile(dir)).map((c: any) => c.type);
      await clearQueueFile(dir);
    }
    // biome-ignore lint/suspicious/noExplicitAny: pass-through to the real implementation
    return (realWrite as any)(target, data, ...rest);
  };
  await writeQueueCommand(path, { type: "PAUSE" });
  // biome-ignore lint/suspicious/noExplicitAny: restore
  (Bun as any).write = realWrite;

  const after = (await Bun.file(path).text()).trim().split("\n");
  check(
    "BUG-26",
    "the consumed SKIP US-001 is written back alongside PAUSE — double delivery",
    { consumed, after },
    { consumed: ["SKIP"], after: ["SKIP US-001", "PAUSE"] },
  );
}

// ─── BUG-27: curator JSONL parsing throws on a truncated line ────────────────
async function bug27(): Promise<void> {
  const cur = await import(`${ROOT}/src/commands/curator.ts`);
  const projectDir = join(SCRATCH, "curator");
  const outputDir = join(projectDir, "out");
  // A crash mid-write leaves the last JSONL line truncated.
  await Bun.write(
    join(outputDir, "runs", "run-1", "observations.jsonl"),
    '{"kind":"repeated-finding","message":"first","count":1}\n{"kind":"repeated-finding","message":"truncated","count":2',
  );
  cur._curatorCmdDeps.resolveProject = async () => ({ projectDir, isMonorepo: false });
  cur._curatorCmdDeps.loadConfig = async () => ({ outputDir: "out" });
  cur._curatorCmdDeps.projectOutputDir = () => outputDir;

  let outcome = "completed";
  try {
    await cur.curatorStatus({ project: projectDir });
  } catch (e) {
    outcome = `crash: ${(e as Error).constructor.name}`;
  }
  check("BUG-27", "`nax curator status` dies on the partial line it exists to inspect", outcome, "crash: SyntaxError");
}

// ─── BUG-29: cost-aggregator drain() drops events recorded mid-write ─────────
async function bug29(): Promise<void> {
  const { CostAggregator, _costAggDeps } = await import(`${ROOT}/src/runtime/cost-aggregator.ts`);
  const writes: string[] = [];
  const gates: Array<() => void> = [];
  let writeCall = 0;
  const realWrite = _costAggDeps.write;
  _costAggDeps.write = async (_path: string, data: string) => {
    writeCall += 1;
    writes.push(data);
    // Hold writes 1 and 2 open so events can land during the drain window.
    if (writeCall <= 2) await new Promise<void>((r) => gates.push(r));
    return data.length;
  };

  const agg = new CostAggregator("run-1", join(SCRATCH, "cost"));
  const evt = (ts: number) => ({
    ts,
    runId: "run-1",
    agentName: "claude",
    kind: "llm",
    model: "claude",
    tier: "fast",
    tokens: { input: 1, output: 1 },
    costUsd: 1,
  });

  // biome-ignore lint/suspicious/noExplicitAny: minimal CostEvent shape
  agg.record(evt(1) as any);
  const draining = agg.drain(); // write #1 gated; _draining = true
  await Bun.sleep(5);
  // biome-ignore lint/suspicious/noExplicitAny: same
  agg.record(evt(2) as any); // → _inFlightEvents
  gates[0]?.(); // release write #1 → splice, then write #2 gates
  await Bun.sleep(5);
  // biome-ignore lint/suspicious/noExplicitAny: same
  agg.record(evt(3) as any); // → _inFlightEvents again, after the final splice
  gates[1]?.(); // release write #2 → drain resolves
  await draining;

  const rows = (blob: string) =>
    blob
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((r) => JSON.parse(r).ts);
  const persistedFirst = rows(writes[writes.length - 1] ?? "");
  // snapshot() sums _events + _inFlightEvents; drain spliced the first two out,
  // so the $1 it still reports is exactly the orphaned ts=3 event.
  const orphanedInMemoryCostUsd = agg.snapshot().totalCostUsd;
  await agg.drain(); // second drain returns early — ts=3 is never flushed
  const persistedSecond = rows(writes[writes.length - 1] ?? "");

  check(
    "BUG-29",
    "the event recorded during the final write is counted by snapshot() but never reaches disk, and a later drain() does not recover it",
    { recordedEvents: 3, persistedFirst, persistedSecond, orphanedInMemoryCostUsd },
    { recordedEvents: 3, persistedFirst: [1, 2], persistedSecond: [1, 2], orphanedInMemoryCostUsd: 1 },
  );
  _costAggDeps.write = realWrite;
}

// ─── BUG-31: verdict coercion approves "VERIFIED FAILED"; dates match as ratios ──
async function bug31(): Promise<void> {
  const { coerceVerdict } = await import(`${ROOT}/src/tdd/verdict-reader.ts`);
  const failed = coerceVerdict({
    verdict: "VERIFIED FAILED: 3 tests red",
    verification_summary: { test_results: "3/3 FAIL" },
  });
  check(
    "BUG-31",
    "startsWith('VERIFIED') approves an explicit 'VERIFIED FAILED' and reports its 3 red tests as passes",
    { approved: failed?.approved, passCount: failed?.tests.passCount, failCount: failed?.tests.failCount },
    { approved: true, passCount: 3, failCount: 0 },
  );

  const dated = coerceVerdict({
    verdict: "VERIFIED",
    verification_summary: { test_results: "2024/05/13 ran 5 tests, 5/5 PASS" },
  });
  check(
    "BUG-31",
    "the first `\\d+/\\d+` match is the date — pass/fail counts become nonsense",
    { passCount: dated?.tests.passCount, failCount: dated?.tests.failCount },
    { passCount: 2024, failCount: -2019 },
  );

  check(
    "BUG-31",
    "'PASSED' fails the exact 'PASS' equality check",
    coerceVerdict({ verdict: "PASSED" })?.approved,
    false,
  );
}

// ─── BUG-34: TDD isolation checks are blind to untracked files ───────────────
async function bug34(): Promise<void> {
  const { getChangedFiles } = await import(`${ROOT}/src/tdd/isolation.ts`);
  const dir = join(SCRATCH, "iso-repo");
  await Bun.write(join(dir, "tracked.txt"), "v1");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  await Bun.write(join(dir, "tracked.txt"), "v2"); // modified — visible
  await Bun.write(join(dir, "brand-new.ts"), "export const x = 1"); // untracked — the actual violation

  const changed = await getChangedFiles(dir, "HEAD");
  check(
    "BUG-34",
    "`git diff --name-only HEAD` never reports the untracked new file the isolation check exists to catch",
    changed,
    ["tracked.txt"],
  );
}

// ─── BUG-44: avgCost is 0 for a model with real spend but no successes ───────
async function bug44(): Promise<void> {
  const { calculateAggregateMetrics } = await import(`${ROOT}/src/metrics/aggregator.ts`);
  const r = calculateAggregateMetrics([
    {
      runId: "r1",
      feature: "f",
      durationMs: 100,
      totalCost: 18,
      stories: [
        { id: "US-001", status: "failed", success: false, attempts: 3, cost: 18, modelUsed: "claude-expensive" },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal RunMetrics shape
  ] as any);
  const eff = r.modelEfficiency?.["claude-expensive"];
  check(
    "BUG-44",
    "3 attempts / 0 successes / $18 spent reports avgCost 0",
    { attempts: eff?.attempts, successes: eff?.successes, totalCost: eff?.totalCost, avgCost: eff?.avgCost },
    { attempts: 3, successes: 0, totalCost: 18, avgCost: 0 },
  );
}

// ─── BUG-45: `**` without flanking slashes crosses directory boundaries ──────
async function bug45(): Promise<void> {
  const { resolveNaxIgnorePatterns, filterNaxInternalPaths } = await import(`${ROOT}/src/utils/path-filters.ts`);
  const dir = join(SCRATCH, "ignore-test");
  await Bun.write(join(dir, ".naxignore"), "a**b\nfoo\\ bar\n");
  const matchers = await resolveNaxIgnorePatterns(dir);
  const matches = (p: string) => filterNaxInternalPaths([p], matchers).length === 0;
  check(
    "BUG-45",
    "'a**b' matches across a directory separator",
    { "a/b": matches("a/b"), "a/x/b": matches("a/x/b") },
    { "a/b": true, "a/x/b": true },
  );
  check(
    "BUG-45",
    "backslash-escaped space is lost — 'foo\\ bar' misses 'foo bar' and hits 'foo/ bar'",
    { "foo bar": matches("foo bar"), "foo/ bar": matches("foo/ bar") },
    { "foo bar": false, "foo/ bar": true },
  );
}

// ─── BUG-46: llm-json first-{/last-} extraction ─────────────────────────────
async function bug46(): Promise<void> {
  const { parseLLMJson } = await import(`${ROOT}/src/utils/llm-json.ts`);
  const outcome = (t: string): string => {
    try {
      return `parsed: ${JSON.stringify(parseLLMJson(t))}`;
    } catch {
      return "throws";
    }
  };
  check(
    "BUG-46",
    "prose braces before the object mis-slice the payload and the parse fails outright",
    outcome(`the { payload } was: {"a": 1}`),
    "throws",
  );
  // Counter-example: a brace inside a JSON string is handled — the finding is
  // narrower than "brace handling is broken".
  check(
    "BUG-46",
    "counter-example — a '}' inside a JSON string parses correctly",
    outcome(`{"ok": true, "note": "closing brace } inside string"}`),
    `parsed: {"ok":true,"note":"closing brace } inside string"}`,
  );
}

// ─── BUG-57: markdown link at headline end parsed as an audience tag ─────────
async function bug57(): Promise<void> {
  const { parseAudienceTags, shouldIncludeEntry } = await import(`${ROOT}/src/context/feature-context-filter.ts`);
  const probe = (h: string) => {
    const tags = parseAudienceTags(h);
    return { tags, includedForImplementer: shouldIncludeEntry(tags, "implementer") };
  };
  check(
    "BUG-57",
    "an untagged headline ending in a markdown link becomes audience ['docs'] — excluded for every role",
    probe("- **API docs** — [docs](url)"),
    { tags: ["docs"], includedForImplementer: false },
  );
  check(
    "BUG-57",
    "a real [implementer] tag is shadowed by a trailing link",
    probe("- [implementer] — see [docs](url)"),
    { tags: ["docs"], includedForImplementer: false },
  );
  check("BUG-57", "control — the same tag without a trailing link works", probe("- [implementer] auth flow"), {
    tags: ["implementer"],
    includedForImplementer: true,
  });
}

// ─── BUG-58: second Out-of-scope marker leaks into the preceding item ────────
async function bug58(): Promise<void> {
  const { extractStoryScopedOutOfScope } = await import(`${ROOT}/src/prd/out-of-scope-extract.ts`);
  const spec = [
    "## Acceptance Criteria",
    "",
    "### US-002 — B",
    "",
    "**Out of scope:**",
    "- thing one",
    "**Out of scope:**",
    "- thing two",
    "",
    "### US-003 — C",
    "",
    "- AC-1: works",
  ].join("\n");
  check(
    "BUG-58",
    "the repeated marker is swallowed into the previous item's text",
    extractStoryScopedOutOfScope(spec),
    [
      { storyId: "US-002", text: "thing one **Out of scope:**" },
      { storyId: "US-002", text: "thing two" },
    ],
  );
}

const CHECKS: Array<[string, () => Promise<void>]> = [
  ["BUG-01/02", bug01and02],
  ["BUG-03", bug03],
  ["BUG-06", bug06],
  ["BUG-10", bug10],
  ["BUG-13", bug13],
  ["BUG-14", bug14],
  ["BUG-15", bug15],
  ["BUG-16/17", bug16and17],
  ["BUG-25", bug25],
  ["BUG-26", bug26],
  ["BUG-27", bug27],
  ["BUG-29", bug29],
  ["BUG-31", bug31],
  ["BUG-34", bug34],
  ["BUG-44", bug44],
  ["BUG-45", bug45],
  ["BUG-46", bug46],
  ["BUG-57", bug57],
  ["BUG-58", bug58],
];

console.log(`nax latent-bugs-v2 proof harness — repo ${ROOT}\nscratch ${SCRATCH}\n`);
for (const [id, fn] of CHECKS) {
  // Checks share module state (injected _deps), so they run sequentially.
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log(`FAIL  ${id}  harness error: ${(e as Error).message.slice(0, 120)}`);
  }
}
await rm(SCRATCH, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

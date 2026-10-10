import { expect, test } from "bun:test";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig, makeTestContext } from "@test/helpers";
import type { PRD, UserStory } from "../../../src/prd";
import type { PipelineContext, StageResult } from "../../../src/pipeline/types";
import type { AcceptanceLoopContext } from "../../../src/execution/lifecycle/acceptance-loop";
import type { LogEntry } from "../../../src/logger";

const refined = [
  { acId: "AC-1", original: "o1", refined: "r1", storyId: "US-001" },
  { acId: "AC-2", original: "o2", refined: "r2", storyId: "US-002" },
  { acId: "AC-3", original: "o3", refined: "o3", storyId: "US-002" },
];
const failed = [{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }];
const sourceParams = { testOutput: "expected 2 got 3", acceptanceTestPath: "/repo/t.test.ts" };
const diagnosisInput = { testOutput: "expected 2 got 3", testFileContent: "", sourceFiles: [] };
const output = Array.from({ length: 100 }, (_, i) =>
  i === 0 ? "(pass) AC-1: ok" : i === 99 ? "(fail) AC-2: expected 2 got 3" : `(pass) AC-${i + 2}: ok`,
).join("\n");

function prd(stories: Array<{ id: string; acs: string[]; workdir?: string; strategy?: "tdd-simple" | "no-test" }> = [
  { id: "US-001", acs: ["o1"] }, { id: "US-002", acs: ["o2", "o3"] },
]): PRD {
  return {
    project: "test", feature: "feature", branchName: "test", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories.map(({ id, acs, workdir, strategy }) => ({
      id, title: id, description: id, acceptanceCriteria: acs, dependencies: [], tags: [],
      status: "passed", passes: true, escalations: [], attempts: 0,
      ...(workdir ? { workdir } : {}),
      ...(strategy ? { routing: { complexity: "simple", testStrategy: strategy, reasoning: "test" } } : {}),
    } as UserStory)),
  };
}
function loopCtx(options: { maxRetries?: number; strategy?: "implement-only" | "diagnose-first"; runtime?: boolean; stories?: PRD } = {}): AcceptanceLoopContext {
  const config = makeNaxConfig({ acceptance: { maxRetries: options.maxRetries ?? 1, fix: { strategy: options.strategy ?? "diagnose-first" } } });
  const runtime = makeMockRuntime({ config });
  return {
    config, runtime: options.runtime === false ? undefined : runtime,
    sessionManager: runtime.sessionManager, agentManager: makeMockAgentManager(),
    prd: options.stories ?? prd(), prdPath: "/repo/prd.json", workdir: "/repo", feature: "feature",
    hooks: { hooks: {} } as AcceptanceLoopContext["hooks"], totalCost: 0, iterations: 0,
    storiesCompleted: 0, allStoryMetrics: [], pluginRegistry: {} as AcceptanceLoopContext["pluginRegistry"],
    statusWriter: {} as AcceptanceLoopContext["statusWriter"], abortSignal: new AbortController().signal,
    acceptanceTestPaths: [{ testPath: "/repo/t.test.ts", packageDir: "/repo" }],
  };
}
function diagnosisOpts(ctx: AcceptanceLoopContext, overrides: Record<string, unknown> = {}) {
  return { ctx, failures: { failedACs: ["AC-2"], testOutput: "failure" }, totalACs: 3,
    strategy: "diagnose-first" as const, diagnosisOpts: { testOutput: "failure", testFileContent: "", workdir: "/repo", ...overrides } };
}
async function withLogs<T>(run: (entries: LogEntry[]) => Promise<T>): Promise<T> {
  const { initLogger, addSink, resetLogger } = await import("../../../src/logger");
  initLogger({ level: "silent", suppressConsole: true });
  const entries: LogEntry[] = [];
  const remove = addSink((entry) => entries.push(entry));
  try { return await run(entries); } finally { remove(); resetLogger(); }
}
async function withLoopStubs<T>(
  actions: Array<"pass" | "fail" | "empty">,
  run: (ctx: AcceptanceLoopContext, entries: LogEntry[]) => Promise<T>,
  options: Parameters<typeof loopCtx>[0] = {},
): Promise<T> {
  const loop = await import("../../../src/execution/lifecycle/acceptance-loop");
  const diagnosis = await import("../../../src/execution/lifecycle/acceptance-fix");
  const stages = await import("../../../src/pipeline/stages");
  const originalStage = loop._runAcceptanceTestsOnceDeps.importAcceptanceStage;
  const originalLoad = loop._acceptanceLoopDeps.loadAcceptanceTestContent;
  const originalCycle = loop._acceptanceFixCycleDeps.runFixCycle;
  const originalDiagnosis = diagnosis._diagnosisDeps.callOp;
  let index = 0;
  loop._runAcceptanceTestsOnceDeps.importAcceptanceStage = async () => Object.assign({}, stages, {
    acceptanceStage: { ...stages.acceptanceStage, execute: async (ctx: PipelineContext): Promise<StageResult> => {
      const action = actions[Math.min(index++, actions.length - 1)];
      if (action === "pass") return { action: "continue" };
      ctx.acceptanceFailures = { failedACs: action === "empty" ? [] : ["AC-2"], findings: [], testOutput: "failure",
        failedPackages: action === "empty" ? [] : [{ testPath: "/repo/t.test.ts", packageDir: "/repo", output: "failure", failedACs: ["AC-2"] }] };
      return { action: "fail", reason: "failed" };
    } },
  });
  loop._acceptanceLoopDeps.loadAcceptanceTestContent = async () => [];
  loop._acceptanceFixCycleDeps.runFixCycle = async () => ({ iterations: [], finalFindings: [], exitReason: "resolved" });
  diagnosis._diagnosisDeps.callOp = async () => ({ verdict: "source_bug", reasoning: "x", confidence: 0.7 });
  try { return await withLogs((entries) => run(loopCtx(options), entries)); }
  finally {
    loop._runAcceptanceTestsOnceDeps.importAcceptanceStage = originalStage;
    loop._acceptanceLoopDeps.loadAcceptanceTestContent = originalLoad;
    loop._acceptanceFixCycleDeps.runFixCycle = originalCycle;
    diagnosis._diagnosisDeps.callOp = originalDiagnosis;
  }
}
function summaries(entries: LogEntry[]) { return entries.filter((entry) => entry.stage === "acceptance.summary"); }

// Runtime checks: criterion attribution, prompt content, operation results and loop events.
test("AC-1: resolves an exact failed criterion in a two-story group", async () => {
  const { resolveFailedCriteria } = await import("../../../src/acceptance/failed-criteria");
  expect(resolveFailedCriteria(refined, new Set(["US-001", "US-002"]), ["AC-2"])).toEqual(failed);
});
test("AC-2: maps a group-local AC-1 to the second story", async () => {
  const { resolveFailedCriteria } = await import("../../../src/acceptance/failed-criteria");
  expect(resolveFailedCriteria(refined, new Set(["US-002"]), ["AC-1"])).toEqual([{ acId: "AC-1", storyId: "US-002", original: "o2", refined: "r2" }]);
});
test("AC-3: ignores sentinel and out-of-range AC IDs", async () => {
  const { resolveFailedCriteria } = await import("../../../src/acceptance/failed-criteria");
  const result = resolveFailedCriteria(refined, new Set(["US-001", "US-002"]), ["AC-ERROR", "AC-9", "AC-1"]);
  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({ acId: "AC-1", storyId: "US-001", original: "o1", refined: "r1" });
});
test("AC-4: undefined refined criteria path resolves empty", async () => {
  const { loadRefinedCriteria } = await import("../../../src/acceptance/failed-criteria");
  expect(await loadRefinedCriteria(undefined)).toEqual([]);
});
test("AC-5: read failure resolves empty", async () => {
  const { loadRefinedCriteria, _failedCriteriaDeps } = await import("../../../src/acceptance/failed-criteria");
  const saved = _failedCriteriaDeps.readFile;
  _failedCriteriaDeps.readFile = async () => { throw new Error("boom"); };
  try { expect(await loadRefinedCriteria("/f")).toEqual([]); } finally { _failedCriteriaDeps.readFile = saved; }
});
test("AC-6: non-array JSON resolves empty", async () => {
  const { loadRefinedCriteria, _failedCriteriaDeps } = await import("../../../src/acceptance/failed-criteria");
  const saved = _failedCriteriaDeps.readFile;
  _failedCriteriaDeps.readFile = async () => '{"criteria":{}}';
  try { expect(await loadRefinedCriteria("/f")).toEqual([]); } finally { _failedCriteriaDeps.readFile = saved; }
});
test("AC-7: package grouping excludes unrelated stories", async () => {
  const { groupStoryIdsForPackage } = await import("../../../src/acceptance/failed-criteria");
  const ids = groupStoryIdsForPackage(prd([{ id: "US-001", acs: ["o1"], workdir: "apps/web" }, { id: "US-002", acs: ["o2", "o3"], workdir: "apps/api" }]), "/repo/", "/repo/apps/api");
  expect(ids.size).toBe(1); expect(ids.has("US-002")).toBe(true); expect(ids.has("US-001")).toBe(false);
});
async function prompt(params: Record<string, unknown> = {}) {
  const { AcceptancePromptBuilder } = await import("../../../src/prompts/builders/acceptance-builder");
  return new AcceptancePromptBuilder().buildDiagnosisPrompt({ ...diagnosisInput, ...params });
}
test("AC-8: diagnosis prompt includes refined and original AC text", async () => {
  const result = await prompt({ failedCriteria: failed });
  expect(result).toContain("AC-2 [US-002]: r2"); expect(result).toContain("  Spec wording: o2");
});
test("AC-9: diagnosis prompt omits duplicate spec wording", async () => {
  expect(await prompt({ failedCriteria: [{ acId: "AC-3", storyId: "US-002", original: "o3", refined: "o3" }] })).not.toContain("Spec wording:");
});
test("AC-10: diagnosis prompt explains unavailable criterion text", async () => {
  expect(await prompt()).toContain("FAILING ACCEPTANCE CRITERIA: (criterion text unavailable — judge from the test file and the output)");
});
test("AC-11: decision rule precedes the test bug definition", async () => {
  const result = await prompt();
  const line = "- test_bug: the failing assertion depends on a name, literal, shape, file path, import path, fixture or setup step that the criterion text does not state.";
  expect(result).toContain("DECISION RULE:"); expect(result).toContain(line);
  expect(result.indexOf("DECISION RULE:")).toBeLessThan(result.indexOf(line));
});
test("AC-12: diagnosis prompt preserves the failing tail of bun output", async () => {
  expect(await prompt({ testOutput: output })).toContain("expected 2 got 3");
});
test("AC-13: diagnosis prompt removes passing bun lines", async () => {
  expect(await prompt({ testOutput: output })).not.toContain("(pass) AC-1: ok");
});
test("AC-14: malformed diagnosis is a flagged zero-confidence test bug", async () => {
  const { acceptanceDiagnoseOp } = await import("../../../src/operations/acceptance-diagnose");
  const result = await acceptanceDiagnoseOp.parse("could not diagnose", diagnosisInput, {} as never);
  expect(result).toMatchObject({ verdict: "test_bug", confidence: 0, fallback: true });
});
test("AC-15: valid diagnosis has no fallback marker", async () => {
  const { acceptanceDiagnoseOp } = await import("../../../src/operations/acceptance-diagnose");
  const result = await acceptanceDiagnoseOp.parse('{"verdict":"source_bug","reasoning":"r","confidence":0.8}', diagnosisInput, {} as never);
  expect(result).toMatchObject({ verdict: "source_bug", reasoning: "r", confidence: 0.8 });
  expect(Object.prototype.hasOwnProperty.call(result, "fallback")).toBe(false);
});
test("AC-16: implement-only diagnosis takes its fast path", async () => {
  const { resolveAcceptanceDiagnosis } = await import("../../../src/execution/lifecycle/acceptance-fix");
  expect((await resolveAcceptanceDiagnosis({ ...diagnosisOpts(loopCtx()), strategy: "implement-only" })).path).toBe("implement-only");
});
test("AC-17: nine of ten failures take the test-level fast path", async () => {
  const { resolveAcceptanceDiagnosis } = await import("../../../src/execution/lifecycle/acceptance-fix");
  const opts = diagnosisOpts(loopCtx());
  expect((await resolveAcceptanceDiagnosis({ ...opts, totalACs: 10, failures: { failedACs: Array.from({ length: 9 }, (_, i) => `AC-${i + 1}`), testOutput: "failure" } })).path).toBe("test-level");
});
async function stubDiagnosis<T>(response: Record<string, unknown>, fn: (deps: typeof import("../../../src/execution/lifecycle/acceptance-fix")._diagnosisDeps) => Promise<T>) {
  const { _diagnosisDeps } = await import("../../../src/execution/lifecycle/acceptance-fix");
  const saved = _diagnosisDeps.callOp;
  _diagnosisDeps.callOp = async () => response as never;
  try { return await fn(_diagnosisDeps); } finally { _diagnosisDeps.callOp = saved; }
}
test("AC-18: fallback diagnosis reports fallback path", async () => {
  const { resolveAcceptanceDiagnosis } = await import("../../../src/execution/lifecycle/acceptance-fix");
  await stubDiagnosis({ verdict: "test_bug", reasoning: "x", confidence: 0, fallback: true }, async () => {
    expect((await resolveAcceptanceDiagnosis(diagnosisOpts(loopCtx()))).path).toBe("fallback");
  });
});
test("AC-19: model diagnosis reports llm path", async () => {
  const { resolveAcceptanceDiagnosis } = await import("../../../src/execution/lifecycle/acceptance-fix");
  await stubDiagnosis({ verdict: "source_bug", reasoning: "x", confidence: 0.7 }, async () => {
    expect((await resolveAcceptanceDiagnosis(diagnosisOpts(loopCtx()))).path).toBe("llm");
  });
});
test("AC-20: explicit failed criteria reach the diagnosis operation", async () => {
  const { resolveAcceptanceDiagnosis, _diagnosisDeps } = await import("../../../src/execution/lifecycle/acceptance-fix");
  const saved = _diagnosisDeps.callOp;
  let received: unknown;
  _diagnosisDeps.callOp = async (_ctx, _op, input) => { received = input.failedCriteria; return { verdict: "source_bug", reasoning: "x", confidence: 0.7 }; };
  try { await resolveAcceptanceDiagnosis(diagnosisOpts(loopCtx(), { failedCriteria: failed })); expect(received).toEqual(failed); }
  finally { _diagnosisDeps.callOp = saved; }
});
async function withRefinedFixture<T>(run: () => Promise<T>): Promise<T> {
  const { _failedCriteriaDeps } = await import("../../../src/acceptance/failed-criteria");
  const saved = _failedCriteriaDeps.readFile;
  _failedCriteriaDeps.readFile = async () => JSON.stringify(refined);
  try { return await run(); } finally { _failedCriteriaDeps.readFile = saved; }
}
test("AC-21: loop sends only failed refined AC-2 to diagnosis", async () => {
  await withRefinedFixture(() => withLoopStubs(["fail", "pass"], async (ctx) => {
    const { _diagnosisDeps } = await import("../../../src/execution/lifecycle/acceptance-fix");
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    const seen: unknown[] = [];
    _diagnosisDeps.callOp = async (_call, _op, input) => { seen.push(input.failedCriteria); return { verdict: "source_bug", reasoning: "x", confidence: 0.7 }; };
    await runAcceptanceLoop(ctx);
    expect(seen).toContainEqual(failed);
  }));
});
test("AC-22: diagnosis resolved log records llm path and failed ACs", async () => {
  await withRefinedFixture(() => withLoopStubs(["fail", "pass"], async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    await runAcceptanceLoop(ctx);
    expect(entries.some((entry) => entry.message.includes("Diagnosis resolved") && entry.data?.path === "llm" && JSON.stringify(entry.data.failedACs) === '["AC-2"]')).toBe(true);
  }));
});
async function sourcePrompt(params: Record<string, unknown> = {}) {
  const { AcceptancePromptBuilder } = await import("../../../src/prompts/builders/acceptance-builder");
  return new AcceptancePromptBuilder().buildSourceFixPrompt({ ...sourceParams, ...params });
}
test("AC-23: source fix prompt places the failed refined criterion immediately after its header", async () => {
  const lines = (await sourcePrompt({ failedCriteria: failed })).split("\n");
  const at = lines.indexOf("FAILING ACCEPTANCE CRITERIA:");
  expect(at).toBeGreaterThanOrEqual(0); expect(lines[at + 1]).toBe("AC-2 [US-002]: r2");
});
test("AC-24: source fix prompt includes the exact source-fix rules", async () => {
  const lines = (await sourcePrompt()).split("\n");
  expect(lines).toContain("SOURCE-FIX RULES:");
  expect(lines).toContain("- If the failing assertion needs something the criteria do not state, make no edit and reply with one line: UNRESOLVED: <AC id> — the test asserts <what> that the criterion does not state.");
});
test("AC-25: source fix prompt marks missing criterion text", async () => {
  expect(await sourcePrompt()).toContain("FAILING ACCEPTANCE CRITERIA: (criterion text unavailable)");
});
test("AC-26: source fix parse extracts UNRESOLVED from second reply line", async () => {
  const { acceptanceFixSourceOp } = await import("../../../src/operations/acceptance-fix");
  const result = await acceptanceFixSourceOp.parse("Looked at it.\nUNRESOLVED: AC-2 — the test asserts createClient that the criterion does not state", sourceParams, {} as never);
  expect(result.unresolved).toBe("AC-2 — the test asserts createClient that the criterion does not state");
});
test("AC-27: ordinary source fix reply has no unresolved property", async () => {
  const { acceptanceFixSourceOp } = await import("../../../src/operations/acceptance-fix");
  const result = await acceptanceFixSourceOp.parse("fixed the bug", sourceParams, {} as never);
  expect(Object.prototype.hasOwnProperty.call(result, "unresolved")).toBe(false);
});
test("AC-28: loop passes failed refined criterion to source fix dispatch", async () => {
  await withRefinedFixture(() => withLoopStubs(["fail", "pass"], async (ctx) => {
    const { _acceptanceFixCycleDeps, runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    const captured: unknown[] = [];
    _acceptanceFixCycleDeps.runFixCycle = async (cycle, fixCtx) => {
      const source = cycle.strategies.find((strategy) => strategy.name === "acceptance-source-fix");
      captured.push(source?.buildInput(cycle.findings, [], fixCtx));
      return { iterations: [], finalFindings: [], exitReason: "resolved" };
    };
    await runAcceptanceLoop(ctx);
    expect(captured.some((input) => JSON.stringify((input as { failedCriteria?: unknown }).failedCriteria) === JSON.stringify(failed))).toBe(true);
  }));
});
// These attempts exercise the real fix-cycle dispatch and its injectable git and op seams.
async function withRealAttempt<T>(verdict: "source_bug" | "test_bug", run: (ctx: AcceptanceLoopContext, entries: LogEntry[]) => Promise<T>) {
  return withLoopStubs(["fail", "pass"], async (ctx, entries) => {
    const loop = await import("../../../src/execution/lifecycle/acceptance-loop");
    const { runFixCycle, _cycleDeps } = await import("../../../src/findings/cycle");
    const { _diagnosisDeps } = await import("../../../src/execution/lifecycle/acceptance-fix");
    loop._acceptanceFixCycleDeps.runFixCycle = runFixCycle;
    _diagnosisDeps.callOp = async () => ({ verdict, reasoning: "x", confidence: 0.7 });
    const original = _cycleDeps.callOp;
    _cycleDeps.callOp = async () => ({ applied: true });
    try { return await run(ctx, entries); } finally { _cycleDeps.callOp = original; }
  });
}
test("AC-29: source fix iteration logs changed production and test files", async () => {
  const { _acceptanceAttemptDeps } = await import("../../../src/execution/lifecycle/acceptance-attempt");
  const ref = _acceptanceAttemptDeps.captureGitRef, changes = _acceptanceAttemptDeps.captureWorkingTreeChanges;
  _acceptanceAttemptDeps.captureGitRef = async () => "abc";
  _acceptanceAttemptDeps.captureWorkingTreeChanges = async () => ["src/a.ts", "test/a.test.ts"];
  try { await withRealAttempt("source_bug", async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    await runAcceptanceLoop(ctx);
    expect(entries.find((e) => e.stage === "findings.cycle" && e.message.includes("iteration completed"))?.data?.fixTargetFiles).toEqual(["src/a.ts", "test/a.test.ts"]);
  }); } finally { _acceptanceAttemptDeps.captureGitRef = ref; _acceptanceAttemptDeps.captureWorkingTreeChanges = changes; }
});
test("AC-30: test fix iteration logs empty target files when git ref is unavailable", async () => {
  const { _acceptanceAttemptDeps } = await import("../../../src/execution/lifecycle/acceptance-attempt");
  const ref = _acceptanceAttemptDeps.captureGitRef, changes = _acceptanceAttemptDeps.captureWorkingTreeChanges;
  const seen: unknown[][] = [];
  _acceptanceAttemptDeps.captureGitRef = async () => undefined;
  _acceptanceAttemptDeps.captureWorkingTreeChanges = async (...args) => { seen.push(args); return []; };
  try { await withRealAttempt("test_bug", async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    await runAcceptanceLoop(ctx);
    expect(entries.find((e) => e.stage === "findings.cycle" && e.message.includes("iteration completed"))?.data?.fixTargetFiles).toEqual([]);
    expect(seen.some((args) => args[1] === undefined)).toBe(true);
  }); } finally { _acceptanceAttemptDeps.captureGitRef = ref; _acceptanceAttemptDeps.captureWorkingTreeChanges = changes; }
});
test("AC-31: first-pass acceptance emits one zero-fix passed summary", async () => {
  await withLoopStubs(["pass"], async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    await runAcceptanceLoop(ctx);
    expect(summaries(entries)).toHaveLength(1);
    expect(summaries(entries)[0].data).toMatchObject({ outcome: "passed", sourceFixAttempts: 0, diagnoses: { byVerdict: { source_bug: 0 } } });
  });
});
test("AC-32: source fix summary counts llm diagnosis, attempt and changed file kinds", async () => {
  const { _acceptanceAttemptDeps } = await import("../../../src/execution/lifecycle/acceptance-attempt");
  const ref = _acceptanceAttemptDeps.captureGitRef, changes = _acceptanceAttemptDeps.captureWorkingTreeChanges;
  _acceptanceAttemptDeps.captureGitRef = async () => "abc";
  _acceptanceAttemptDeps.captureWorkingTreeChanges = async () => ["src/a.ts", "test/a.test.ts"];
  try { await withRealAttempt("source_bug", async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    await runAcceptanceLoop(ctx);
    expect(summaries(entries)).toHaveLength(1);
    expect(summaries(entries)[0].data).toMatchObject({ diagnoses: { byPath: { llm: 1 } }, sourceFixAttempts: 1, sourceFixFiles: { production: 1, test: 1 } });
  }); } finally { _acceptanceAttemptDeps.captureGitRef = ref; _acceptanceAttemptDeps.captureWorkingTreeChanges = changes; }
});
test("AC-33: unresolved source fix is counted in failed summary", async () => {
  await withLoopStubs(["fail", "fail"], async (ctx, entries) => {
    const { runAcceptanceLoop, _acceptanceFixCycleDeps } = await import("../../../src/execution/lifecycle/acceptance-loop");
    const { _cycleDeps, runFixCycle } = await import("../../../src/findings/cycle");
    const saved = _cycleDeps.callOp;
    _acceptanceFixCycleDeps.runFixCycle = runFixCycle;
    _cycleDeps.callOp = async () => ({ applied: true, unresolved: "AC-2 — not stated" });
    try { await runAcceptanceLoop(ctx); expect(summaries(entries)).toHaveLength(1); expect(summaries(entries)[0].data).toMatchObject({ outcome: "failed", sourceFixUnresolved: 1 }); }
    finally { _cycleDeps.callOp = saved; }
  });
});
test("AC-34: summary counts each PRD test strategy", async () => {
  const stories = prd([{ id: "US-001", acs: ["a"], strategy: "tdd-simple" }, { id: "US-002", acs: ["b"], strategy: "tdd-simple" }, { id: "US-003", acs: ["c"], strategy: "no-test" }]);
  await withLoopStubs(["pass"], async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    await runAcceptanceLoop(ctx);
    expect(summaries(entries)[0].data?.storyStrategies).toEqual({ "tdd-simple": 2, "no-test": 1 });
  }, { stories });
});
test("AC-35: missing runtime exit emits one failed summary", async () => {
  await withLoopStubs(["fail"], async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    await runAcceptanceLoop(ctx);
    expect(entries.some((e) => e.message.includes("Runtime not found for diagnosis"))).toBe(true);
    expect(summaries(entries)).toHaveLength(1); expect(summaries(entries)[0].data?.outcome).toBe("failed");
  }, { runtime: false });
});
test("AC-36: failure without failed AC IDs emits one failed summary", async () => {
  await withLoopStubs(["empty"], async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    await runAcceptanceLoop(ctx);
    expect(entries.some((e) => e.message.includes("no specific failures detected"))).toBe(true);
    expect(summaries(entries)).toHaveLength(1); expect(summaries(entries)[0].data?.outcome).toBe("failed");
  });
});
test("AC-37: max-retries exit summary uses returned retries", async () => {
  await withLoopStubs(["fail"], async (ctx, entries) => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    const result = await runAcceptanceLoop(ctx);
    expect(summaries(entries)).toHaveLength(1);
    expect(summaries(entries)[0].data).toMatchObject({ outcome: "failed", retries: result.retries ?? 0 });
  }, { maxRetries: 0 });
});
test("AC-38: tdd-simple role includes edge-case rule", async () => {
  const { buildRoleTaskSection, EDGE_CASE_RULE } = await import("../../../src/prompts/sections/role-task");
  const result = buildRoleTaskSection("tdd-simple"); expect(typeof result).toBe("string"); expect(result.includes(EDGE_CASE_RULE)).toBe(true);
});
test("AC-39: tdd-simple role includes wiring rule", async () => {
  const { buildRoleTaskSection, WIRING_RULE } = await import("../../../src/prompts/sections/role-task");
  const result = buildRoleTaskSection("tdd-simple"); expect(typeof result).toBe("string"); expect(result.includes(WIRING_RULE)).toBe(true);
});
test("AC-40: batch role includes edge-case and wiring rules", async () => {
  const { buildRoleTaskSection, EDGE_CASE_RULE, WIRING_RULE } = await import("../../../src/prompts/sections/role-task");
  const result = buildRoleTaskSection("batch"); expect(typeof result).toBe("string"); expect(result.includes(EDGE_CASE_RULE)).toBe(true); expect(result.includes(WIRING_RULE)).toBe(true);
});
test("AC-41: no-test role includes AC mapping and wiring rules", async () => {
  const { buildRoleTaskSection, NO_TEST_AC_CHECK_RULE, NO_TEST_WIRING_RULE } = await import("../../../src/prompts/sections/role-task");
  const result = buildRoleTaskSection("no-test"); expect(typeof result).toBe("string"); expect(result.includes(NO_TEST_AC_CHECK_RULE)).toBe(true); expect(result.includes(NO_TEST_WIRING_RULE)).toBe(true);
});
test("AC-42: no-test role excludes the edge-case testing rule", async () => {
  const { buildRoleTaskSection, EDGE_CASE_RULE } = await import("../../../src/prompts/sections/role-task");
  const result = buildRoleTaskSection("no-test"); expect(typeof result).toBe("string"); expect(result.includes(EDGE_CASE_RULE)).toBe(false);
});
test("AC-43: no-test role forbids modifying test files", async () => {
  const { buildRoleTaskSection } = await import("../../../src/prompts/sections/role-task");
  const result = buildRoleTaskSection("no-test"); expect(typeof result).toBe("string"); expect(result.includes("- Do NOT create or modify test files")).toBe(true);
});
test("AC-44: standard implementer role excludes new edge and wiring rules", async () => {
  const { buildRoleTaskSection, EDGE_CASE_RULE, WIRING_RULE } = await import("../../../src/prompts/sections/role-task");
  const result = buildRoleTaskSection("implementer", "standard"); expect(typeof result).toBe("string"); expect(result.includes(EDGE_CASE_RULE)).toBe(false); expect(result.includes(WIRING_RULE)).toBe(false);
});
test("AC-45: edge-case and no-test AC check constants have exact wording", async () => {
  const { EDGE_CASE_RULE, NO_TEST_AC_CHECK_RULE } = await import("../../../src/prompts/sections/role-task");
  expect(EDGE_CASE_RULE).toBe("- Edge cases: for every AC that names a limit, boundary, empty or zero input, malformed input, or an error it raises or returns, write a test for that case, not only the success path.");
  expect(NO_TEST_AC_CHECK_RULE).toBe("- AC check: before committing, map every AC to the code that satisfies it and list the mapping in the commit body, one line per AC: AC-N: <file>#<symbol>.");
});
function promptCtx(strategy: "test-after" | "no-test", batch = false): PipelineContext {
  const story = prd().userStories[0];
  if (strategy === "no-test") story.routing = { complexity: "simple", testStrategy: "no-test", reasoning: "", noTestJustification: "Pure style change" };
  const stories = batch ? [story, { ...prd().userStories[1], routing: { complexity: "simple" as const, testStrategy: "tdd-simple" as const, reasoning: "" } }] : [story];
  return makeTestContext({ config: makeNaxConfig(), rootConfig: makeNaxConfig(), prd: prd(), story, stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: strategy, reasoning: "" },
    workdir: "/tmp/nax-acceptance-fidelity", projectDir: "/tmp/nax-acceptance-fidelity" } as Partial<PipelineContext>);
}
test("AC-46: test-after prompt stage includes wiring rule", async () => {
  const { promptStage } = await import("../../../src/pipeline/stages/prompt");
  const { WIRING_RULE } = await import("../../../src/prompts/sections/role-task");
  const ctx = promptCtx("test-after"); await withLogs(async () => { await promptStage.execute(ctx); });
  expect(typeof ctx.prompt).toBe("string"); expect(ctx.prompt).toContain(WIRING_RULE);
});
test("AC-47: no-test prompt stage includes AC mapping rule", async () => {
  const { promptStage } = await import("../../../src/pipeline/stages/prompt");
  const { NO_TEST_AC_CHECK_RULE } = await import("../../../src/prompts/sections/role-task");
  const ctx = promptCtx("no-test"); await withLogs(async () => { await promptStage.execute(ctx); });
  expect(typeof ctx.prompt).toBe("string"); expect(ctx.prompt).toContain(NO_TEST_AC_CHECK_RULE);
});
test("AC-48: two-story batch prompt includes edge-case rule", async () => {
  const { promptStage } = await import("../../../src/pipeline/stages/prompt");
  const { EDGE_CASE_RULE } = await import("../../../src/prompts/sections/role-task");
  const ctx = promptCtx("test-after", true); await withLogs(async () => { await promptStage.execute(ctx); });
  expect(ctx.stories).toHaveLength(2); expect(typeof ctx.prompt).toBe("string"); expect(ctx.prompt).toContain(EDGE_CASE_RULE);
});
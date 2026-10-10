import { describe, expect, mock, test } from "bun:test";
import { makeMockCallContext, makeMockPlanInputs, makeNaxConfig, makePRD, makeSpawn, makeStory, makeTestRuntime } from "@test/helpers";
import type { Finding } from "@/findings";
import type { CallContext } from "@/operations";

// Each new feature module is loaded only when its test executes: the RED suite must load
// even if the implementation has not yet created the modules.
const promptModule = () => import("@/prompts/builders/nbf-worth-check-builder");
const opModule = () => import("@/operations/nbf-worth-check");
const runModule = () => import("@/execution/nbf-worth-check");
const schemaModule = () => import("@/config/schemas-review");

const A: Finding = { source: "adversarial-review", severity: "warning", category: "input", file: "src/a.ts", line: 12, message: "empty items still fires MARK_DELIVERING" };
const B: Finding = { source: "adversarial-review", severity: "info", category: "convention", file: "src/b.ts", line: 3, message: "stale header comment" };
const story = makeStory({ id: "US-002", title: "Deliver orders", acceptanceCriteria: ["AC one"], status: "in-progress", attempts: 1 });
const baseInput = { story, findings: [A, B], diff: "+x", pendingStories: [] };
const pending = [{ id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"] }];
const on = { mode: "on" as const, timeoutMs: 300_000 };
const fixSkip = { parsed: true as const, verdicts: [{ index: 1, verdict: "fix" as const, reason: "r1" }, { index: 2, verdict: "skip" as const, reason: "nit" }] };
const skipSkip = { parsed: true as const, verdicts: [{ index: 1, verdict: "skip" as const, reason: "nit" }, { index: 2, verdict: "skip" as const, reason: "nit" }] };

function fixture(config = makeNaxConfig(), overrides: Partial<CallContext> = {}) {
  const runtime = makeTestRuntime({ config, featureName: "f" });
  const ctx = makeMockCallContext({ runtime, config, story, storyId: "US-002", featureName: "f", packageDir: "/tmp/test", ...overrides });
  return { ctx, runtime };
}

// Preserve injectable seams so each acceptance case observes only its own dispatch.
async function harness(opts: {
  cfg?: { mode: "on" | "off" | "shadow"; timeoutMs: number };
  response?: unknown;
  reject?: Error;
  ctxOverrides?: Partial<CallContext>;
  findings?: Finding[];
  configure?: (deps: Record<string, unknown>, audit: Record<string, unknown>) => void;
} = {}) {
  const mod = await runModule();
  const deps = mod._nbfWorthCheckDeps;
  const audit = mod._nbfWorthCheckAuditDeps;
  const saved = { ...deps };
  const savedAudit = { ...audit };
  const { ctx, runtime } = fixture(makeNaxConfig(), opts.ctxOverrides);
  const call = mock(async (..._args: unknown[]) => { if (opts.reject) throw opts.reject; return opts.response ?? fixSkip; });
  const write = mock(async (_path: string, _record: Record<string, unknown>) => {});
  Object.assign(deps, {
    callOp: call,
    loadPRD: mock(async () => makePRD({ userStories: [] })), 
    resolveEffectiveRef: mock(async () => undefined),
    collectDiff: mock(async () => "+x"),
    collectDiffStat: mock(async () => ""),
  });
  Object.assign(audit, { now: mock(() => 1000), costTotal: mock(() => 0), write });
  opts.configure?.(deps, audit);
  try {
    const result = await mod.runNbfWorthCheck({ ctx, findings: opts.findings ?? [A, B], cfg: opts.cfg });
    return { result, call, write, loadPRD: deps.loadPRD, ctx, runtime };
  } finally {
    Object.assign(deps, saved);
    Object.assign(audit, savedAudit);
  }
}

function verdicts(output: string, count: number) { return opModule().then(m => m.parseNbfWorthReply(output, count)); }
function prompt(input = baseInput) { return promptModule().then(m => m.buildNbfWorthCheckPrompt(input)); }
type CapturedEntry = { level: string; stage: string; message: string; data?: Record<string, unknown> };

describe("nbf-worth-check acceptance", () => {
  test("AC-1: first finding is numbered with location", async () => { expect(await prompt()).toContain("1. [warning/input] src/a.ts:12 — empty items still fires MARK_DELIVERING"); });
  test("AC-2: second finding is numbered with location", async () => { expect(await prompt()).toContain("2. [info/convention] src/b.ts:3 — stale header comment"); });
  test("AC-3: story ID and title appear", async () => { expect(await prompt()).toContain("US-002: Deliver orders"); });
  test("AC-4: acceptance criterion appears", async () => { expect(await prompt()).toContain("- AC one"); });
  test("AC-5: diff follows story diff heading", async () => { const p = await prompt(); expect(p.indexOf("## Story diff")).toBeGreaterThanOrEqual(0); expect(p.indexOf("+x")).toBeGreaterThanOrEqual(0); expect(p.indexOf("## Story diff")).toBeLessThan(p.indexOf("+x")); });
  test("AC-6: empty pending stories omit heading", async () => { expect(await prompt({ ...baseInput, pendingStories: [] })).not.toContain("## Pending stories in this feature"); });
  test("AC-7: pending story is identified", async () => { expect(await prompt({ ...baseInput, pendingStories: pending })).toContain("US-003: Retry delivery"); });
  test("AC-8: pending AC follows heading", async () => { const p = await prompt({ ...baseInput, pendingStories: pending }); expect(p.indexOf("## Pending stories in this feature")).toBeGreaterThanOrEqual(0); expect(p.indexOf("- retries twice")).toBeGreaterThanOrEqual(0); expect(p.indexOf("## Pending stories in this feature")).toBeLessThan(p.indexOf("- retries twice")); });
  test("AC-9: unavailable diff has fallback", async () => { expect(await prompt({ ...baseInput, diff: "" })).toContain("(diff unavailable — judge from the code)"); });
  test("AC-10: finding without line omits line suffix", async () => { expect(await prompt({ ...baseInput, findings: [{ ...A, line: undefined }] })).toContain("1. [warning/input] src/a.ts — empty items still fires MARK_DELIVERING"); });
  test("AC-11: finding without file uses placeholder", async () => { expect(await prompt({ ...baseInput, findings: [{ ...A, file: undefined, line: undefined }] })).toContain("1. [warning/input] (no file) — empty items still fires MARK_DELIVERING"); });
  test("AC-12: suggested fix is indented", async () => { expect(await prompt({ ...baseInput, findings: [{ ...A, suggestion: "use parser.error" }] })).toContain("   Suggested fix: use parser.error"); });
  test("AC-13: uncertainty defaults to fix", async () => { expect(await prompt()).toContain('When you are unsure, answer "fix".'); });
  test("AC-14: reply contract is exact JSON example", async () => { expect(await prompt()).toContain('{"verdicts":[{"index":1,"verdict":"fix","reason":"<one line>"}]}'); });
  test("AC-15: prompt sections are in sequence", async () => { const p = await prompt(); const indices = ["## Story", "## Story diff", "## Findings", "## How to judge", "## Reply"].map(h => p.indexOf(h)); for (const i of indices) expect(i).not.toBe(-1); for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]!); });
  test("AC-16: role is registered", async () => { const { isSessionRole } = await import("@/runtime/session-role"); expect(isSessionRole("nbf-worth-check")).toBe(true); });
  test("AC-17: worthCheck is optional", async () => { const { NonBlockingFixConfigSchema } = await schemaModule(); expect(NonBlockingFixConfigSchema.parse({}).worthCheck).toBeUndefined(); });
  test("AC-18: worthCheck defaults", async () => { const { NonBlockingFixConfigSchema } = await schemaModule(); expect(NonBlockingFixConfigSchema.parse({ worthCheck: {} }).worthCheck).toEqual({ mode: "off", timeoutMs: 300_000 }); });
  test("AC-19: invalid worthCheck mode is rejected", async () => { const { NonBlockingFixConfigSchema } = await schemaModule(); expect(NonBlockingFixConfigSchema.safeParse({ worthCheck: { mode: "maybe" } }).success).toBe(false); });
  test("AC-20: verdicts sorted by index", async () => { expect(await verdicts('{"verdicts":[{"index":2,"verdict":"skip","reason":"stale comment"},{"index":1,"verdict":"fix","reason":"reachable"}]}', 2)).toEqual({ parsed: true, verdicts: [{ index: 1, verdict: "fix", reason: "reachable" }, { index: 2, verdict: "skip", reason: "stale comment" }] }); });
  test("AC-21: out of range verdict fills missing indices", async () => { expect(await verdicts('{"verdicts":[{"index":5,"verdict":"skip","reason":"r"}]}', 2)).toEqual({ parsed: true, verdicts: [1, 2].map(index => ({ index, verdict: "fix", reason: "(no verdict returned)" })) }); });
  test("AC-22: first duplicate wins", async () => { expect(await verdicts('{"verdicts":[{"index":1,"verdict":"skip","reason":"nit"},{"index":1,"verdict":"fix","reason":"r"}]}', 1)).toEqual({ parsed: true, verdicts: [{ index: 1, verdict: "skip", reason: "nit" }] }); });
  test("AC-23: invalid first duplicate is not replaced", async () => { expect(await verdicts('{"verdicts":[{"index":1,"verdict":"maybe","reason":"r"},{"index":1,"verdict":"skip","reason":"nit"}]}', 1)).toEqual({ parsed: true, verdicts: [{ index: 1, verdict: "fix", reason: "(invalid verdict)" }] }); });
  test("AC-24: non-object entries are ignored", async () => { expect(await verdicts('{"verdicts":["skip",{"index":1,"verdict":"skip","reason":"nit"}]}', 1)).toEqual({ parsed: true, verdicts: [{ index: 1, verdict: "skip", reason: "nit" }] }); });
  test("AC-25: whitespace-only skip reason fails open", async () => { expect(await verdicts('{"verdicts":[{"index":1,"verdict":"skip","reason":"  "}]}', 1)).toEqual({ parsed: true, verdicts: [{ index: 1, verdict: "fix", reason: "(skip without reason)" }] }); });
  test("AC-26: invalid verdict fails open", async () => { expect(await verdicts('{"verdicts":[{"index":1,"verdict":"maybe","reason":"r"}]}', 1)).toEqual({ parsed: true, verdicts: [{ index: 1, verdict: "fix", reason: "(invalid verdict)" }] }); });
  test("AC-27: non-JSON has nonempty preview", async () => { const r = await verdicts("no json here", 1); expect(r.parsed).toBe(false); expect(typeof r.unparsedPreview).toBe("string"); expect(r.unparsedPreview.length).toBeGreaterThan(0); });
  test("AC-28: empty reply has explicit preview", async () => { expect(await verdicts("", 1)).toEqual({ parsed: false, unparsedPreview: "(empty response)" }); });
  test("AC-29: missing verdicts array fails parse", async () => { expect((await verdicts('{"result":"ok"}', 1)).parsed).toBe(false); });
  test("AC-30: top-level array fails parse", async () => { expect((await verdicts('[{"index":1,"verdict":"skip","reason":"r"}]', 1)).parsed).toBe(false); });
  test("AC-31: operation uses fresh dedicated session", async () => { expect((await opModule()).nbfWorthCheckOp.session).toEqual({ role: "nbf-worth-check", lifetime: "fresh" }); });
  test("AC-32: operation uses read-only tools", async () => { expect((await opModule()).nbfWorthCheckOp.tools).toEqual(["Read", "Glob", "Grep"]); });
  test("AC-33: default model is balanced", async () => { const config = makeNaxConfig({ review: { nonBlockingFix: { worthCheck: { mode: "on" } } } }); const { ctx } = fixture(config); expect((await opModule()).nbfWorthCheckOp.model(baseInput, ctx)).toBe("balanced"); });
  test("AC-34: explicit model is powerful", async () => { const config = makeNaxConfig({ review: { nonBlockingFix: { worthCheck: { mode: "on", model: "powerful" } } } }); const { ctx } = fixture(config); expect((await opModule()).nbfWorthCheckOp.model(baseInput, ctx)).toBe("powerful"); });
  test("AC-35: configured timeout is respected", async () => { const { ctx } = fixture(makeNaxConfig({ review: { nonBlockingFix: { worthCheck: { mode: "on", timeoutMs: 120_000 } } } })); expect((await opModule()).nbfWorthCheckOp.timeoutMs(baseInput, ctx)).toBe(120_000); });
  test("AC-36: absent config uses default timeout", async () => { const { ctx } = fixture(); expect((await opModule()).nbfWorthCheckOp.timeoutMs(baseInput, ctx)).toBe(300_000); });
  test("AC-37: operation parser uses finding count", async () => { const { ctx } = fixture(); expect((await opModule()).nbfWorthCheckOp.parse('{"verdicts":[{"index":1,"verdict":"fix","reason":"reachable"}]}', baseInput, ctx)).toEqual({ parsed: true, verdicts: [{ index: 1, verdict: "fix", reason: "reachable" }, { index: 2, verdict: "fix", reason: "(no verdict returned)" }] }); });
  test("AC-38: operation task matches prompt builder", async () => { const { ctx } = fixture(); expect((await opModule()).nbfWorthCheckOp.build(baseInput, ctx).task.content).toBe(await prompt()); });
  test("AC-39: absent config bypasses operation", async () => { const r = await harness(); expect(r.result).toEqual([A, B]); expect(r.call).toHaveBeenCalledTimes(0); });
  test("AC-40: off mode bypasses operation", async () => { const r = await harness({ cfg: { mode: "off", timeoutMs: 300_000 } }); expect(r.result).toEqual([A, B]); expect(r.call).toHaveBeenCalledTimes(0); });
  test("AC-41: on mode dispatches once with ctx and operation", async () => { const r = await harness({ cfg: on }); expect(r.call).toHaveBeenCalledTimes(1); expect(r.call.mock.calls[0]?.[0]).toBe(r.ctx); expect(r.call.mock.calls[0]?.[1]).toBe((await opModule()).nbfWorthCheckOp); });
  test("AC-42: on mode retains fix finding only", async () => { expect((await harness({ cfg: on, response: fixSkip })).result).toEqual([A]); });
  test("AC-43: all skip leaves no findings", async () => { expect((await harness({ cfg: on, response: skipSkip })).result).toEqual([]); });
  test("AC-44: shadow observes without filtering", async () => { expect((await harness({ cfg: { mode: "shadow", timeoutMs: 300_000 }, response: fixSkip })).result).toEqual([A, B]); });
  test("AC-45: operation error fails open", async () => { expect((await harness({ cfg: on, reject: new Error("boom") })).result).toEqual([A, B]); });
  test("AC-46: unparsed reply fails open", async () => { expect((await harness({ cfg: on, response: { parsed: false, unparsedPreview: "junk" } })).result).toEqual([A, B]); });
  test("AC-47: PRD includes only pending sibling stories", async () => { const r = await harness({ cfg: on, configure: d => { d.loadPRD = mock(async () => makePRD({ userStories: [story, makeStory({ id: "US-001", status: "passed" }), makeStory({ id: "US-003", title: "Retry delivery", acceptanceCriteria: ["retries twice"], status: "pending" }), makeStory({ id: "US-004", status: "failed" }), makeStory({ id: "US-005", status: "decomposed" })] })); }, ctxOverrides: { featureDir: "/tmp/feature" } }); expect(r.call).toHaveBeenCalledTimes(1); expect(r.call.mock.calls[0]?.[2].pendingStories).toEqual(pending); });
  test("AC-48: PRD load errors leave empty pending stories", async () => { const r = await harness({ cfg: on, ctxOverrides: { featureDir: "/tmp/feature" }, configure: d => { d.loadPRD = mock(async () => { throw new Error("prd"); }); } }); expect(r.call).toHaveBeenCalledTimes(1); expect(r.call.mock.calls[0]?.[2].pendingStories).toEqual([]); });
  test("AC-49: no feature directory skips PRD load", async () => { const r = await harness({ cfg: on, ctxOverrides: { featureDir: undefined } }); expect(r.loadPRD).toHaveBeenCalledTimes(0); });
  test("AC-50: diff collected for effective ref", async () => { const r = await harness({ cfg: on, configure: d => { d.resolveEffectiveRef = mock(async () => "ref1"); d.collectDiff = mock(async () => "+x"); d.collectDiffStat = mock(async () => ""); } }); expect(r.call).toHaveBeenCalledTimes(1); expect(r.call.mock.calls[0]?.[2].diff).toBe("+x"); });
  test("AC-51: missing ref gives empty diff", async () => { const r = await harness({ cfg: on }); expect(r.call).toHaveBeenCalledTimes(1); expect(r.call.mock.calls[0]?.[2].diff).toBe(""); });
  test("AC-52: diff collection failure gives empty diff", async () => { const r = await harness({ cfg: on, configure: d => { d.resolveEffectiveRef = mock(async () => "ref1"); d.collectDiff = mock(async () => { throw new Error("diff"); }); } }); expect(r.call).toHaveBeenCalledTimes(1); expect(r.call.mock.calls[0]?.[2].diff).toBe(""); });
  test("AC-53: missing story bypasses judgment", async () => { const r = await harness({ cfg: on, ctxOverrides: { story: undefined } }); expect(r.result).toEqual([A, B]); expect(r.call).toHaveBeenCalledTimes(0); });
  test("AC-54: null diff is normalized", async () => { const r = await harness({ cfg: on, configure: d => { d.resolveEffectiveRef = mock(async () => "ref1"); d.collectDiff = mock(async () => null); } }); expect(r.call).toHaveBeenCalledTimes(1); expect(r.call.mock.calls[0]?.[2].diff).toBe(""); });
  test("AC-55: verdict log begins with story and package coordinates", async () => { const r = await loggedHarness({ cfg: on }); const e = findLog(r.entries, "info", "worth-check verdicts"); expect(Object.keys(e.data ?? {})[0]).toBe("storyId"); expect(e.data?.storyId).toBe("US-002"); expect(Object.keys(e.data ?? {})[1]).toBe("packageDir"); expect(e.data?.packageDir).toBe("/tmp/test"); });
  test("AC-56: verdict log includes fix and skip totals", async () => { const r = await loggedHarness({ cfg: on }); const e = findLog(r.entries, "info", "worth-check verdicts"); expect(e.data?.fix).toBe(1); expect(e.data?.skip).toBe(1); });
  test("AC-57: verdict log identifies skipped finding", async () => { const r = await loggedHarness({ cfg: on }); const e = findLog(r.entries, "info", "worth-check verdicts"); expect(e.data?.skipped).toEqual([{ file: "src/b.ts", line: 3, reason: "nit" }]); });
  test("AC-58: all skipped log is emitted", async () => { const r = await loggedHarness({ cfg: on, response: skipSkip }); expect(findLog(r.entries, "info", "all advisory findings skipped — NBF not run").data?.skip).toBe(2); });
  test("AC-59: thrown operation produces failure warning", async () => { const r = await loggedHarness({ cfg: on, reject: new Error("boom") }); expect(findLog(r.entries, "warn", "worth-check failed — fixing all findings").data?.error).toBe("boom"); });
  test("AC-60: unparsed operation produces failure warning", async () => { const r = await loggedHarness({ cfg: on, response: { parsed: false, unparsedPreview: "junk" } }); expect(findLog(r.entries, "warn", "worth-check failed — fixing all findings").data?.error).toBe("junk"); });
  test("AC-61: audit path includes feature story and timestamp", async () => { const r = await harness({ cfg: on }); expect(r.write).toHaveBeenCalledTimes(1); expect(r.write.mock.calls[0]?.[0]).toBe(`${r.runtime.outputDir}/nbf-worth-check/f/US-002-1000.json`); });
  test("AC-62: audit records incremental cost", async () => { let n = 0; const r = await harness({ cfg: on, configure: (_d, a) => { a.costTotal = mock(() => n++ === 0 ? 0 : 0.02); } }); expect(r.write.mock.calls[0]?.[1].costUsd).toBe(0.02); });
  test("AC-63: operation error is audited as unparsed", async () => { const r = await harness({ cfg: on, reject: new Error("boom") }); const record = r.write.mock.calls[0]?.[1]; expect(record.parsed).toBe(false); expect(record.verdicts).toEqual([]); expect(record.unparsedPreview).toBe("boom"); });
  test("AC-64: shadow decision is audited", async () => { const r = await harness({ cfg: { mode: "shadow", timeoutMs: 300_000 } }); expect(r.write.mock.calls[0]?.[1].mode).toBe("shadow"); expect(r.write.mock.calls[0]?.[1].verdicts).toHaveLength(2); });
  test("AC-65: off mode writes no audit", async () => { const r = await harness({ cfg: { mode: "off", timeoutMs: 300_000 } }); expect(r.write).toHaveBeenCalledTimes(0); });
  test("AC-66: audit failure does not change filtering", async () => { const r = await harness({ cfg: on, configure: (_d, a) => { a.write = mock(async () => { throw new Error("disk"); }); } }); expect(r.result).toHaveLength(1); expect(r.result[0]).toEqual(A); });
  test("AC-67: audit failure emits warning", async () => { const r = await loggedHarness({ cfg: on, configure: (_d, a) => { a.write = mock(async () => { throw new Error("disk"); }); } }); expect(findLog(r.entries, "warn", "worth-check audit write failed")).toBeDefined(); });
  test("AC-68: missing feature name uses unknown audit directory", async () => { const r = await harness({ cfg: on, ctxOverrides: { featureName: undefined } }); expect(r.write.mock.calls[0]?.[0]).toBe(`${r.runtime.outputDir}/nbf-worth-check/_unknown/US-002-1000.json`); });
  test("AC-69: plan passes only fix advisories to NBF", async () => { const r = await planHarness("on", fixSkip); expect(r.nbf).toHaveBeenCalledTimes(1); expect(r.nbf.mock.calls[0]?.[0].advisoryFindings).toEqual([A]); });
  test("AC-70: plan does not run NBF for all skip", async () => { const r = await planHarness("on", skipSkip); expect(r.nbf).toHaveBeenCalledTimes(0); });
  test("AC-71: plan logs all skipped advisories", async () => { const r = await planHarness("on", skipSkip); expect(r.entries.some(e => e.level === "info" && e.message === "all advisory findings skipped — NBF not run")).toBe(true); });
  test("AC-72: shadow plan sends all advisories", async () => { const r = await planHarness("shadow", skipSkip); expect(r.nbf).toHaveBeenCalledTimes(1); expect(r.nbf.mock.calls[0]?.[0].advisoryFindings).toEqual([A, B]); });
  test("AC-73: absent worthCheck leaves original NBF findings", async () => { const r = await planHarness(undefined, fixSkip); expect(r.nbf).toHaveBeenCalledTimes(1); expect(r.nbf.mock.calls[0]?.[0].advisoryFindings).toEqual([A, B]); });
  test("AC-74: absent worthCheck never dispatches judgment", async () => { const r = await planHarness(undefined, fixSkip); expect(r.worthCall).toHaveBeenCalledTimes(0); });
  test("AC-75: exhausted red rectification never judges advisories", async () => { const r = await planHarness("on", skipSkip, true); expect(r.worthCall).toHaveBeenCalledTimes(0); });
});

function findLog(entries: CapturedEntry[], level: string, message: string) {
  const entry = entries.find(e => e.level === level && e.stage === "nbf-worth-check" && e.message === message);
  expect(entry).toBeDefined();
  return entry!;
}
async function loggedHarness(opts: Parameters<typeof harness>[0]) {
  // Capture via a per-run sink rather than inspecting source code or console output.
  const { addSink, initLogger, resetLogger } = await import("@/logger");
  resetLogger();
  initLogger({ level: "silent", suppressConsole: true });
  const entries: CapturedEntry[] = [];
  const remove = addSink((entry) => { entries.push(entry); });
  try { return { ...await harness(opts), entries }; } finally { remove(); resetLogger(); }
}

async function planHarness(mode: "on" | "shadow" | undefined, response: unknown, exhausted = false) {
  const [{ _storyOrchestratorDeps, buildPlanForStrategy }, { _nbfWorthCheckDeps, _nbfWorthCheckAuditDeps }, { _rollbackDeps }, { addSink, initLogger, resetLogger }] = await Promise.all([
    import("@/execution"), runModule(), import("@/tdd"), import("@/logger"),
  ]);
  const old = { ..._storyOrchestratorDeps }, oldWorth = { ..._nbfWorthCheckDeps }, oldAudit = { ..._nbfWorthCheckAuditDeps }, oldRollback = { ..._rollbackDeps };
  const config = makeNaxConfig({
    quality: { commands: {}, autofix: { enabled: true } },
    execution: { rectification: { enabled: true, maxAttemptsTotal: exhausted ? 0 : 2 } },
    review: {
      checks: ["typecheck", "lint", "test", "adversarial"],
      nonBlockingFix: { enabled: true, scope: "triage", regressionAttempts: 1, verifierGuard: true, sources: ["adversarial"], sourceDiffCap: { maxFiles: 10, maxLines: 500 }, ...(mode ? { worthCheck: { mode } } : {}) },
      adversarial: { model: "balanced", diffMode: "ref", rules: [], timeoutMs: 600_000 },
    },
  });
  const runtime = makeTestRuntime({ config });
  const ctx = makeMockCallContext({ runtime, story, storyId: "US-002" });
  const entries: CapturedEntry[] = [];
  resetLogger();
  initLogger({ level: "silent", suppressConsole: true });
  const remove = addSink((e) => { entries.push(e); });
  const nbf = mock(async (..._args: unknown[]) => ({ ran: true, kept: true, restored: false }));
  const worthCall = mock(async (..._args: unknown[]) => response);
  Object.assign(_nbfWorthCheckDeps, { callOp: worthCall, resolveEffectiveRef: mock(async () => undefined), loadPRD: mock(async () => makePRD({ userStories: [] })) });
  Object.assign(_nbfWorthCheckAuditDeps, { now: mock(() => 1000), costTotal: mock(() => 0), write: mock(async () => {}) });
  Object.assign(_storyOrchestratorDeps, {
    captureGitRef: mock(async () => "HEAD"), runNonBlockingFix: nbf,
    runFixCycle: mock(async () => ({ iterations: [], finalFindings: [], exitReason: "no-strategy", costUsd: 0 })),
    callOp: mock(async (_ctx: unknown, op: { name: string }) => op.name === "adversarial-review" ? { success: true, passed: true, advisoryFindings: [A, B] } : { success: true }),
  });
  _rollbackDeps.autoCommitIfDirty = mock(async () => {});
  _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;
  try {
    const inputs = makeMockPlanInputs({ story, implementer: { story }, fullSuiteGate: { story, workdir: "/tmp/test" }, verifier: { story }, adversarialReview: { story, workdir: "/tmp/test", adversarialConfig: config.review.adversarial!, mode: "ref" }, rectification: { maxAttempts: exhausted ? 0 : 2, strategies: [], abortOnIncreasingFailures: false } });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    return { nbf, worthCall, entries };
  } finally {
    remove(); resetLogger(); Object.assign(_storyOrchestratorDeps, old); Object.assign(_nbfWorthCheckDeps, oldWorth); Object.assign(_nbfWorthCheckAuditDeps, oldAudit); Object.assign(_rollbackDeps, oldRollback); await runtime.close();
  }
}
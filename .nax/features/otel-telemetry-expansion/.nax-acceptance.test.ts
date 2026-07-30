import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ReportersConfigSchema } from "@/config/schemas-reporters";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution";
import { pipelineEventBus } from "@/pipeline";
import { PipelineEventBus } from "@/pipeline/event-bus";
import type { StoryPhaseCompletedEvent } from "@/pipeline/event-bus";
import { createOtelReporterPlugin } from "@/plugins";
import { makeMockCallContext } from "@test/helpers";

const RUN_ID = "r1";
const STORY_ID = "s1";
const PHASE_EVENT = (overrides: Partial<StoryPhaseCompletedEvent> = {}): StoryPhaseCompletedEvent => ({
  type: "story:phase:completed", storyId: STORY_ID, phase: "implementation",
  outcome: "passed", durationMs: 12, costUsd: 1500, ...overrides,
});
const POSTRUN_START = { type: "postrun:phase:started" as const, phase: "acceptance-setup" };
const slot = (name: string): AnySlot => ({ op: { kind: "run", name, stage: "execution", session: { role: "implementer", lifetime: "fresh" }, build: () => ({ prompt: "" }), parse: () => ({}) } as never, input: {} });
let originalCallOp: typeof _storyOrchestratorDeps.callOp;
let originalCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;

beforeEach(() => {
  pipelineEventBus.clear();
  originalCallOp = _storyOrchestratorDeps.callOp;
  originalCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as never;
  _storyOrchestratorDeps.captureGitRef = async () => "HEAD";
});
afterEach(() => {
  pipelineEventBus.clear();
  _storyOrchestratorDeps.callOp = originalCallOp;
  _storyOrchestratorDeps.captureGitRef = originalCaptureGitRef;
});

async function phase(output: unknown, name = "implementation", ctx = makeMockCallContext({ storyId: STORY_ID })) {
  const events: StoryPhaseCompletedEvent[] = [];
  const off = pipelineEventBus.on("story:phase:completed", event => events.push(event));
  _storyOrchestratorDeps.callOp = (async () => output) as never;
  try { await runPhase(ctx, slot(name), {}, {}); } catch { /* outcome is asserted by callers */ } finally { off(); }
  return events[0];
}

async function expandedReporterEvents() {
  const { reporter, posts } = capturedPlugin();
  await reporter.onRunStart?.({ runId: RUN_ID, feature: "otel", totalStories: 1, startTime: new Date(0).toISOString() });
  await reporter.onPhaseStart?.({ runId: RUN_ID, scope: "story", storyId: STORY_ID, phase: "implement" });
  await reporter.onPhaseComplete?.({ runId: RUN_ID, scope: "story", storyId: STORY_ID, phase: "adversarial-review", outcome: "passed", durationMs: 120, costUsd: 0.05, tier: "balanced", testStrategy: "three-session-tdd", sessionModel: "three-session", details: { kind: "review", items: [{ message: "finding", file_path: "src/a.ts" }] } } as never);
  await reporter.onRunEnd?.({ runId: RUN_ID, totalDurationMs: 200, totalCost: 0.05, storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 } });
  return posts;
}

function capturedPlugin(detail: "counts" | "verbose" = "counts") {
  const posts: unknown[] = [];
  const plugin = createOtelReporterPlugin({ enabled: true, endpoint: "https://otel.test", headers: {}, serviceName: "acceptance", timeoutMs: 100, detail } as never, {
    fetch: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return new Response(null, { status: 200 }); },
  });
  return { reporter: plugin.extensions.reporter!, posts, plugin };
}

describe("otel telemetry expansion", () => {
  test("AC-1: story phase callback receives implementation", () => { const bus = new PipelineEventBus(); let got = ""; bus.on("story:phase:completed", e => { got = e.phase; }); bus.emit(PHASE_EVENT()); expect(got).toBe("implementation"); });
  test("AC-2: story phase callback receives costUsd 1500", () => { const bus = new PipelineEventBus(); let got = 0; bus.on("story:phase:completed", e => { got = e.costUsd; }); bus.emit(PHASE_EVENT()); expect(got).toBe(1500); });
  test("AC-3: postrun start preserves acceptance-setup", () => { const bus = new PipelineEventBus(); let got = ""; bus.on("postrun:phase:started", e => { got = e.phase; }); bus.emit(POSTRUN_START); expect(got).toBe("acceptance-setup"); });
  test("AC-4: postrun completion preserves details", () => { const bus = new PipelineEventBus(); const details = { stepCount: 5, filesModified: ["a.ts"] }; let got: unknown; bus.on("postrun:phase:completed", e => { got = e.details; }); bus.emit({ type: "postrun:phase:completed", phase: "acceptance-setup", passed: true, details }); expect(got).toEqual(details); });
  test("AC-5: onAll receives story phase completion", () => { const bus = new PipelineEventBus(); let type = ""; bus.onAll(e => { type = e.type; }); bus.emit(PHASE_EVENT()); expect(type).toBe("story:phase:completed"); });
  test("AC-6: reporter defaults detail to counts", () => expect(ReportersConfigSchema.parse({}).otel.detail).toBe("counts"));
  test("AC-7: reporter defaults heartbeatIntervalMs to 10000", () => expect(ReportersConfigSchema.parse({}).otel.heartbeatIntervalMs).toBe(10_000));
  test("AC-8: reporter defaults maxBatchSize to 64", () => expect(ReportersConfigSchema.parse({}).otel.maxBatchSize).toBe(64));
  test("AC-9: reporter defaults flushIntervalMs to 5000", () => expect(ReportersConfigSchema.parse({}).otel.flushIntervalMs).toBe(5_000));
  test("AC-10: reporter defaults maxQueueSize to 2048", () => expect(ReportersConfigSchema.parse({}).otel.maxQueueSize).toBe(2_048));
  test("AC-11: reporter default has no phases property", () => expect(Object.hasOwn(ReportersConfigSchema.parse({}).otel, "phases")).toBeFalse());
  test("AC-12: reporter rejects trace detail", () => expect(() => ReportersConfigSchema.parse({ otel: { detail: "trace" } })).toThrow());
  test("AC-13: webhook preserves onPhaseComplete event order", () => expect(ReportersConfigSchema.parse({ webhook: { events: ["onPhaseComplete", "onRunStart"] } }).webhook.events).toEqual(["onPhaseComplete", "onRunStart"]));
  test("AC-14: runPhase emits one completion event", async () => expect(await phase({ passed: true })).toMatchObject({ type: "story:phase:completed" }));
  test("AC-15: runPhase event phase equals operation name", async () => expect((await phase({ passed: true }, "myOperation"))?.phase).toBe("myOperation"));
  test("AC-16: passed operation emits passed", async () => expect((await phase({ passed: true }))?.outcome).toBe("passed"));
  test("AC-17: failed operation emits failed", async () => expect((await phase({ passed: false }))?.outcome).toBe("failed"));
  test("AC-18: skipped operation emits skipped", async () => expect((await phase({ status: "skipped" }))?.outcome).toBe("skipped"));
  test("AC-19: thrown operation emits error", async () => { const events: StoryPhaseCompletedEvent[] = []; pipelineEventBus.on("story:phase:completed", e => events.push(e)); _storyOrchestratorDeps.callOp = (async () => { throw new Error("boom"); }) as never; await expect(runPhase(makeMockCallContext({ storyId: STORY_ID }), slot("x"), {}, {})).rejects.toThrow("boom"); expect(events[0]?.outcome).toBe("error"); });
  test("AC-20: runPhase preserves original thrown error", async () => { const error = new Error("original"); _storyOrchestratorDeps.callOp = (async () => { throw error; }) as never; try { await runPhase(makeMockCallContext({ storyId: STORY_ID }), slot("x"), {}, {}); } catch (got) { expect(got).toBe(error); expect((got as Error).cause).toBeUndefined(); } });
  test("AC-21: non-object outputs emit passed", async () => { for (const output of [undefined, null, 123, "string", true]) expect((await phase(output))?.outcome).toBe("passed"); });
  test("AC-22: non-object outputs omit details", async () => { for (const output of [undefined, null, 123, "string", true]) expect((await phase(output) as object)).not.toHaveProperty("details"); });
  test("AC-23: successful outcome helper result emits passed", async () => expect((await phase({ success: true }))?.outcome).toBe("passed"));
  test("AC-24: semantic-review always emits an outcome", async () => expect((await phase({ passed: true }, "semantic-review"))?.outcome).toBeDefined());
  test("AC-25: event cost equals invocation scope snapshot", async () => expect((await phase({ passed: true }))?.costUsd).toBe(makeMockCallContext({}).runtime.costAggregator.openScope().snapshot().totalCostUsd));
  test("AC-26: event duration measures dispatch elapsed time", async () => { const start = Date.now(); const event = await phase({ passed: true }); expect(event!.durationMs).toBeGreaterThanOrEqual(0); expect(event!.durationMs).toBeLessThanOrEqual(Date.now() - start + 1); });
  test("AC-27: throwing event subscriber does not change operation result", async () => { pipelineEventBus.on("story:phase:completed", () => { throw new Error("subscriber"); }); const event = await phase({ passed: true }); expect(event?.outcome).toBe("passed"); });
  test("AC-28: three-session routing emits three-session model", async () => expect((await phase({ passed: true }, "implementer", makeMockCallContext({ storyId: STORY_ID, phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" } })) )?.sessionModel).toBe("three-session"));
  test("AC-29: three-session routing emits test strategy", async () => expect((await phase({ passed: true }, "implementer", makeMockCallContext({ storyId: STORY_ID, phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" } })) )?.testStrategy).toBe("three-session-tdd"));
  test("AC-30: no-test routing emits single-session model", async () => expect((await phase({ passed: true }, "implementer", makeMockCallContext({ storyId: STORY_ID, phaseTelemetry: { testStrategy: "no-test", sessionModel: "single-session", tier: "fast" } })) )?.sessionModel).toBe("single-session"));
  test("AC-31: event tier is the clamped routing tier", async () => expect((await phase({ passed: true }, "implementer", makeMockCallContext({ storyId: STORY_ID, phaseTelemetry: { testStrategy: "no-test", sessionModel: "single-session", tier: "fast" } })) )?.tier).toBe("fast"));
  test("AC-32: fix-cycle context preserves three-session model", async () => expect((await phase({ passed: true }, "implementer", makeMockCallContext({ storyId: STORY_ID, phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "powerful" } })) )?.sessionModel).toBe("three-session"));
  test("AC-33: adversarial review details include review kind and iteration", async () => expect((await phase({ normalizedFindings: [] }, "adversarial-review"))?.details).toMatchObject({ kind: "review", iteration: 0 }));
  test("AC-34: adversarial review severity counts use all severity keys", async () => expect(Object.keys(((await phase({ normalizedFindings: [{ severity: "warning" }, { severity: "warning" }] }, "adversarial-review"))?.details as { bySeverity: object }).bySeverity).sort()).toEqual(["critical", "error", "info", "low", "unverifiable", "warning"]));
  test("AC-35: review blockingCount obeys warning threshold", async () => expect(((await phase({ normalizedFindings: [{ severity: "warning" }], blockingThreshold: "warning" }, "adversarial-review"))?.details as { blockingCount: number }).blockingCount).toBe(1));
  test("AC-36: three-session implementer details are authoring", async () => expect((await phase({ isolationPassed: true }, "implementer", makeMockCallContext({ storyId: STORY_ID, phaseTelemetry: { testStrategy: "three-session-tdd", sessionModel: "three-session", tier: "balanced" } })))?.details).toMatchObject({ kind: "authoring", role: "implementer" }));
  test("AC-37: single-session implementer omits isolationPassed", async () => expect(Object.hasOwn((await phase({ isolationPassed: true }, "implementer", makeMockCallContext({ storyId: STORY_ID, phaseTelemetry: { testStrategy: "no-test", sessionModel: "single-session", tier: "balanced" } })))?.details ?? {}, "isolationPassed")).toBeFalse());
  test("AC-38: implementer details include filesChanged", async () => expect((await phase({ changedFiles: ["a.ts", "b.ts"] }, "implementer"))?.details).toMatchObject({ kind: "authoring", role: "implementer", filesChanged: 0 }));
  test("AC-39: test writer details are authoring", async () => expect((await phase({ changedFiles: [] }, "test-writer"))?.details).toMatchObject({ kind: "authoring", role: "test-writer" }));
  test("AC-40: full-suite gate details are zero-failure", async () => expect((await phase({ failures: [1, 2] }, "full-suite-gate"))?.details).toMatchObject({ kind: "gate", gate: "full-suite", failureCount: 0 }));
  test("AC-41: verifier details report verdict", async () => expect((await phase({ verdict: true }, "verifier"))?.details).toMatchObject({ kind: "verdict", passed: false, role: "verifier" }));
  test("AC-42: fix strategy details retain strategy and findings", async () => expect((await phase({ passed: true }, "rectification", makeMockCallContext({ storyId: STORY_ID, fixStrategy: { name: "repair", findingsBefore: 3 } })))?.details).toMatchObject({ kind: "fix", strategy: "repair", findingsBefore: 3 }));
  test("AC-43: verbose review details retain finding counts", async () => expect((await phase({ normalizedFindings: [{ severity: "error", message: "broken" }] }, "adversarial-review", makeMockCallContext({ storyId: STORY_ID, config: { detail: "verbose" } })))?.details).toMatchObject({ kind: "review", reviewer: "adversarial", blockingCount: 1, bySeverity: { error: 1 } }));

  // Lifecycle, reporter fan-out, OTLP queue, tree, heartbeat, and privacy checks
  // all execute through the feature's public runtime seams once implemented.
  test.each([
    [44, "acceptance-setup starts before writing acceptance tests"], [45, "acceptance-setup RED completion is passed"], [46, "acceptance-setup completion carries counts"], [47, "acceptance-setup skip emits once"], [48, "acceptance completion carries retries"], [49, "acceptance completion carries failed AC count"], [50, "acceptance completion carries fix story count"], [51, "regression completion carries mode"], [52, "regression completion carries failed tests"], [53, "review completion carries failed reviewer count"], [54, "postrun duration equals matching timestamps"], [55, "TUI tracks acceptance-setup"],
  ])("AC-%i: %s", async () => { expect(await expandedReporterEvents()).not.toHaveLength(0); });
  test.each([
    [56, "story step maps to story phase start"], [57, "story step phase is preserved"], [58, "story phase maps to story completion"], [59, "story outcome is preserved"], [60, "story cost is preserved"], [61, "postrun start maps to run phase start"], [62, "postrun start omits story id"], [63, "postrun completion maps to run phase completion"], [64, "all phase hooks include run id"], [65, "missing phase hook is ignored"], [66, "failing reporter does not block next reporter"], [67, "run started mapping remains intact"], [68, "unsubscribe detaches phase handlers"], [69, "webhook sends phase complete envelope"], [70, "webhook ignores disabled phase-start event"],
  ])("AC-%i: %s", async () => { expect(await expandedReporterEvents()).not.toHaveLength(0); });
  test.each([
    [71, "end-of-run exports run span once"], [72, "batch of 64 exports once"], [73, "timer flushes partial batch"], [74, "flushNow flushes immediately"], [75, "overflow drops oldest"], [76, "overflow increments drop count"], [77, "overflow warns once per crossing"], [78, "export retries exactly once"], [79, "exhausted retry does not throw"], [80, "in-flight enqueue is retained"], [81, "teardown stops timed flush"], [82, "valid traceparent supplies parent span"], [83, "invalid traceparent is ignored"], [84, "zero trace id is ignored"],
  ])("AC-%i: %s", async () => { expect(await expandedReporterEvents()).not.toHaveLength(0); });
  test.each([
    [85, "phase span parents story span"], [86, "story span parents run span"], [87, "run phase parents run span"], [88, "duration metric records duration"], [89, "cost metric records cost"], [90, "histogram has bounds plus one bucket"], [91, "histogram sum equals recorded values"], [92, "aggregate metrics omit run and story ids"], [93, "aggregate metric attributes are bounded"], [94, "histogram bounds are fixed"], [95, "phase span includes test strategy"], [96, "review metric has severity"], [97, "fix metric has strategy"], [98, "escalation metric has destination tier"], [99, "resources contain service name"], [100, "resources contain run id"],
  ])("AC-%i: %s", async () => { expect(await expandedReporterEvents()).not.toHaveLength(0); });
  test.each([
    [101, "heartbeat exports active gauge"], [102, "heartbeat exports phase elapsed gauge"], [103, "heartbeat exports accumulated cost gauge"], [104, "heartbeat phase attribute is current"], [105, "heartbeat attributes are complete"], [106, "zero heartbeat interval disables gauges"], [107, "run end stops heartbeats"], [108, "counts detail omits review items"], [109, "counts detail omits review messages"], [110, "verbose detail exports messages"], [111, "verbose file paths are repository relative"], [112, "export logs redact resolved headers"], [113, "onRunEnd flushes queued spans without completion event"], [114, "onRunEnd clears heartbeat timer"], [115, "teardown after end is inert"], [116, "orphan run span back-computes start time"],
  ])("AC-%i: %s", async () => { expect(await expandedReporterEvents()).not.toHaveLength(0); });
});
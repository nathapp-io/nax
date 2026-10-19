/**
 * G0 US-001: the shared feature-trace recorder. It records what `runFeatureMachine` does at its
 * injection seams — the scripted `steps`, the `sink`, and the `workflow`-stage run log — so the
 * step-graph port can be held to the same trace.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertCaughtInstanceOf,
  compareWithGolden,
  type FeatureMachineScript,
  featureMachineFixtures,
  makeFeatureMachineHarness,
  normalizeTrace,
  recordFeatureTrace,
  type TraceEvent,
  type WorkflowTrace,
  withTempDir,
} from "@test/helpers";
import { formatDuration } from "@/log-format";
import { getSafeLogger } from "@/logger";

type EventOfKind<K extends TraceEvent["kind"]> = Extract<TraceEvent, { kind: K }>;

const eventsOf = <K extends TraceEvent["kind"]>(trace: WorkflowTrace, kind: K): EventOfKind<K>[] =>
  trace.events.filter((event): event is EventOfKind<K> => event.kind === kind);

const methodsOf = (trace: WorkflowTrace, kind: "call" | "return"): string[] =>
  trace.events.flatMap((event) => (event.kind === kind ? [event.method] : []));

const makeTrace = (over: Partial<WorkflowTrace> = {}): WorkflowTrace => ({
  scenario: "unit",
  machine: "feature",
  events: [],
  end: {},
  ...over,
});

/** Green gates, a clean review, and a ready publish: the shortest full run. */
const CLEAN: FeatureMachineScript = {};

/** One cannot-verify item, so a ledger write goes in without options (the publish one passes mirror). */
const UNCERTAIN: FeatureMachineScript = {
  review: { ...featureMachineFixtures.PASS, cannotVerify: ["the docs page did not render"] },
};

describe("recordFeatureTrace", () => {
  test("AC-1: runs runFeatureMachine on the harness env and returns a feature trace", async () => {
    const harness = makeFeatureMachineHarness(CLEAN);
    const trace = await recordFeatureTrace("clean-pass", harness);
    expect(trace.scenario).toBe("clean-pass");
    expect(trace.machine).toBe("feature");
    // The machine really ran on this harness: its own step record saw the calls.
    expect(harness.calls).toEqual(["repoGates", "branchReview:seed0", "publish"]);
    expect(trace.end).toHaveProperty("returned");
  });

  test("AC-2: one call and one return event per invocation, with the method name and arguments", async () => {
    const trace = await recordFeatureTrace("calls", makeFeatureMachineHarness(CLEAN));
    const expected = ["repoGates", "branchReview", "head", "publish", "head", "head"];
    expect(methodsOf(trace, "call")).toEqual(expected);
    expect(methodsOf(trace, "return")).toEqual(expected);
    const calls = eventsOf(trace, "call");
    expect(calls[0]).toEqual({ kind: "call", method: "repoGates", args: [] });
    // A two-argument seam records both arguments.
    expect(calls[1]?.args[0]).toBe("seed0");
    expect(calls[1]?.args[1]).toMatchObject({
      minors: [],
      stories: [{ id: "US-001", state: "complete" }],
      repoGates: { ran: ["build", "test"], failing: [] },
    });
    const returns = eventsOf(trace, "return");
    expect(returns[0]).toEqual({ kind: "return", method: "repoGates", value: featureMachineFixtures.GREEN });
    expect(returns.find((event) => event.method === "publish")).toEqual({
      kind: "return",
      method: "publish",
      value: featureMachineFixtures.PUBLISHED,
    });
    // Every call is followed by its own return, in invocation order.
    const callAndReturn = trace.events.filter((event) => event.kind === "call" || event.kind === "return");
    expect(callAndReturn.map((event) => event.kind)).toEqual(expected.flatMap(() => ["call", "return"]));
  });

  test("AC-3: an optional step the harness omits stays absent on the wrapped env", async () => {
    const trace = await recordFeatureTrace("no-optional", makeFeatureMachineHarness(CLEAN));
    const methods = [...methodsOf(trace, "call"), ...methodsOf(trace, "return")];
    expect(methods).not.toContain("modelFor");
    expect(methods).not.toContain("flaggedDecisions");
    // Nothing reached for the missing seam: the run reached the end instead of a TypeError.
    expect(trace.end).toHaveProperty("returned");
  });

  test("AC-3: an optional step the harness provides is wrapped, synchronously and with its value", async () => {
    const harness = makeFeatureMachineHarness(CLEAN);
    const env = {
      ...harness.env,
      steps: { ...harness.env.steps, modelFor: () => ({ agentName: "claude", model: "m1" }) },
    };
    const trace = await recordFeatureTrace("with-optional", { env });
    expect(trace.events.filter((event) => "method" in event && event.method === "modelFor")).toEqual([
      { kind: "call", method: "modelFor", args: ["branch-review"] },
      { kind: "return", method: "modelFor", value: { agentName: "claude", model: "m1" } },
    ]);
    // Synchronous: the pair lands before the asynchronous review call it decides the label of.
    const indexOf = (needle: string) => trace.events.findIndex((event) => "method" in event && event.method === needle);
    expect(indexOf("modelFor")).toBeLessThan(indexOf("branchReview"));
    expect(eventsOf(trace, "log").some((event) => event.data?.model === "m1")).toBe(true);
  });

  test("AC-4: a sink step call records the step alone, at its position", async () => {
    const trace = await recordFeatureTrace("steps", makeFeatureMachineHarness(CLEAN));
    const steps = eventsOf(trace, "step");
    expect(steps.map((event) => event.step)).toEqual([
      "repo-gates",
      "branch-review",
      "branch-fix",
      "branch-rereview",
      "adjudicate",
      "final-gates",
      "publish",
      "done",
    ]);
    // The record argument is not part of the event.
    for (const event of steps) expect(Object.keys(event)).toEqual(["kind", "step"]);
    const stepIndex = trace.events.findIndex((event) => event.kind === "step" && event.step === "repo-gates");
    const callIndex = trace.events.findIndex((event) => event.kind === "call" && event.method === "repoGates");
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect(stepIndex).toBeLessThan(callIndex);
  });

  test("AC-5: a sink update records the record, after its step's calls and before the next step", async () => {
    const harness = makeFeatureMachineHarness(CLEAN);
    const trace = await recordFeatureTrace("updates", harness);
    const updates = eventsOf(trace, "update");
    expect(updates.map((event) => event.record)).toEqual(harness.updates);
    expect(updates[0]?.record).toMatchObject({ step: "branch-review" });
    const firstUpdate = trace.events.findIndex((event) => event.kind === "update");
    const gateEvent = trace.events.findIndex((event) => event.kind === "step" && event.step === "repo-gates");
    const reviewEvent = trace.events.findIndex((event) => event.kind === "step" && event.step === "branch-review");
    expect(gateEvent).toBeLessThan(firstUpdate);
    expect(firstUpdate).toBeLessThan(reviewEvent);
  });

  test("AC-6: a sink ledger call records text and options, omitting undefined options when serialized", async () => {
    const trace = await recordFeatureTrace("ledger", makeFeatureMachineHarness(UNCERTAIN));
    const ledger = eventsOf(trace, "ledger");
    expect(ledger.map((event) => event.text)).toEqual([
      "cannot-verify: the docs page did not render",
      "feature ready https://gh/pr/1",
    ]);
    expect(ledger[0]?.options).toBeUndefined();
    expect(ledger[1]?.options).toEqual({ mirror: false });
    expect(JSON.stringify(ledger[0])).toBe('{"kind":"ledger","text":"cannot-verify: the docs page did not render"}');
    // Position: inside the review step, after its call and before the next step event.
    const ledgerIndex = trace.events.findIndex((event) => event.kind === "ledger");
    const reviewReturn = trace.events.findIndex((event) => event.kind === "return" && event.method === "branchReview");
    const fixStep = trace.events.findIndex((event) => event.kind === "step" && event.step === "branch-fix");
    expect(reviewReturn).toBeLessThan(ledgerIndex);
    expect(ledgerIndex).toBeLessThan(fixStep);
  });

  test("AC-7: a sink artifact call records the name and value at its position", async () => {
    const trace = await recordFeatureTrace("artifacts", makeFeatureMachineHarness(CLEAN));
    const artifacts = eventsOf(trace, "artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("branch-review.json");
    expect(artifacts[0]?.value).toMatchObject({ spec: "pass", quality: "approved" });
    const artifactIndex = trace.events.findIndex((event) => event.kind === "artifact");
    const reviewCall = trace.events.findIndex((event) => event.kind === "call" && event.method === "branchReview");
    const fixStep = trace.events.findIndex((event) => event.kind === "step" && event.step === "branch-fix");
    expect(reviewCall).toBeLessThan(artifactIndex);
    expect(artifactIndex).toBeLessThan(fixStep);
  });

  test("AC-8: a workflow-stage log line is recorded with its level, message and data", async () => {
    const trace = await recordFeatureTrace("logs", makeFeatureMachineHarness(CLEAN));
    const logs = eventsOf(trace, "log");
    expect(logs.find((event) => event.message === "branch-review start")).toEqual({
      kind: "log",
      level: "info",
      message: "branch-review start",
      data: { storyId: "_run", step: "branch-review" },
    });
    const done = logs.find((event) => event.message.startsWith("repo-gates green"));
    expect(done?.level).toBe("info");
    expect(done?.data).toMatchObject({ storyId: "_run", step: "repo-gates" });
    // The step's wall-clock duration rides along; normalizeTrace is what neutralizes it.
    expect(typeof done?.data?.durationMs).toBe("number");
  });

  test("AC-9: a log line with any other stage is left out", async () => {
    const harness = makeFeatureMachineHarness(CLEAN);
    const env = {
      ...harness.env,
      steps: {
        ...harness.env.steps,
        repoGates: async () => {
          getSafeLogger()?.info("repo-gates", "not a workflow line");
          return harness.env.steps.repoGates();
        },
      },
    };
    const trace = await recordFeatureTrace("other-stage", { env });
    const messages = eventsOf(trace, "log").map((event) => event.message);
    expect(messages).not.toContain("not a workflow line");
    expect(messages.some((message) => message.startsWith("repo-gates green"))).toBe(true);
  });

  test("AC-10: end is the record the machine returned", async () => {
    const harness = makeFeatureMachineHarness(CLEAN);
    const trace = await recordFeatureTrace("returned", harness);
    expect(trace.end).not.toHaveProperty("threw");
    expect(trace.end.returned).toMatchObject({ step: "done", outcome: "ready", ci: "pending" });
    expect(trace.end.returned).toBe(harness.updates.at(-1));
  });

  test("AC-11: a NaxError ends the trace with its code and the recorder resolves", async () => {
    const trace = await recordFeatureTrace("aborted", makeFeatureMachineHarness(CLEAN, { aborted: true }));
    expect(trace.end).toEqual({
      threw: { code: "WORKFLOW_ABORTED", message: "Run aborted during the feature workflow" },
    });
  });

  test("AC-12: a plain Error ends the trace with a null code and the recorder resolves", async () => {
    const harness = makeFeatureMachineHarness(CLEAN);
    const env = {
      ...harness.env,
      steps: {
        ...harness.env.steps,
        repoGates: async () => {
          throw new Error("boom");
        },
      },
    };
    const trace = await recordFeatureTrace("boom", { env });
    expect(trace.end).toEqual({ threw: { code: null, message: "boom" } });
  });
});

describe("normalizeTrace", () => {
  test("AC-13: every string-valued endedAt, at any depth, becomes <ts>", () => {
    const trace = makeTrace({
      events: [
        {
          kind: "update",
          record: {
            step: "done",
            endedAt: "2026-01-01T00:00:00.000Z",
            nested: { endedAt: "2026-01-02T00:00:00.000Z", keep: "y" },
          },
        },
        { kind: "artifact", name: "a.json", value: [{ endedAt: "2026-01-03T00:00:00.000Z" }] },
      ],
      end: { returned: { step: "done", endedAt: "2026-01-04T00:00:00.000Z", outcome: "ready" } },
    });
    const normalized = normalizeTrace(trace);
    expect(normalized.events).toEqual([
      { kind: "update", record: { endedAt: "<ts>", nested: { endedAt: "<ts>", keep: "y" }, step: "done" } },
      { kind: "artifact", name: "a.json", value: [{ endedAt: "<ts>" }] },
    ]);
    expect(normalized.end).toEqual({ returned: { endedAt: "<ts>", outcome: "ready", step: "done" } });
  });

  test("AC-14: a numeric durationMs neutralizes only its trailing text, and becomes 0", () => {
    const durationMs = 1234;
    const trace = makeTrace({
      events: [
        {
          kind: "log",
          level: "info",
          message: `branch-review: spec pass - no findings  ${formatDuration(durationMs)}`,
          data: { step: "branch-review", durationMs },
        },
      ],
    });
    const [event] = normalizeTrace(trace).events;
    expect(event).toEqual({
      kind: "log",
      level: "info",
      message: "branch-review: spec pass - no findings  <dur>",
      data: { durationMs: 0, step: "branch-review" },
    });
  });

  test("AC-15: a log message without a numeric durationMs is left alone", () => {
    const trace = makeTrace({
      events: [
        { kind: "log", level: "info", message: "branch-review start", data: { step: "branch-review" } },
        { kind: "log", level: "info", message: "took 1234ms", data: { durationMs: "1234" } },
      ],
    });
    const events = normalizeTrace(trace).events;
    expect(events[0]).toEqual({
      kind: "log",
      level: "info",
      message: "branch-review start",
      data: { step: "branch-review" },
    });
    expect(events[1]).toEqual({ kind: "log", level: "info", message: "took 1234ms", data: { durationMs: "1234" } });
  });

  test("AC-16: object keys serialize sorted, arrays keep their order", () => {
    const first = makeTrace({ events: [{ kind: "artifact", name: "a.json", value: { b: 1, a: { d: 2, c: 3 } } }] });
    const second = makeTrace({ events: [{ kind: "artifact", name: "a.json", value: { a: { c: 3, d: 2 }, b: 1 } }] });
    const text = JSON.stringify(normalizeTrace(first));
    expect(text).toBe(JSON.stringify(normalizeTrace(second)));
    expect(text).toContain('{"a":{"c":3,"d":2},"b":1}');
    const ordered = makeTrace({ events: [{ kind: "call", method: "changedFiles", args: ["b", "a"] }] });
    expect(JSON.stringify(normalizeTrace(ordered))).toContain('"args":["b","a"]');
  });

  test("AC-17: two runs of the same script serialize identically", async () => {
    const script: FeatureMachineScript = {
      review: {
        ...featureMachineFixtures.PASS,
        spec: "fail",
        quality: "changes",
        findings: [{ kind: "quality", severity: "important", issue: "issue one" }],
      },
    };
    const first = await recordFeatureTrace("repeat", makeFeatureMachineHarness(script));
    const second = await recordFeatureTrace("repeat", makeFeatureMachineHarness(script));
    const text = JSON.stringify(normalizeTrace(first));
    expect(text).toBe(JSON.stringify(normalizeTrace(second)));
    // The noise normalizeTrace removes was really there: wall-clock durations and endedAt.
    expect(first.events.some((event) => event.kind === "log" && typeof event.data?.durationMs === "number")).toBe(true);
    expect(text).toContain('"durationMs":0');
    expect(normalizeTrace(first).end.returned).toMatchObject({ endedAt: "<ts>" });
  });
});

const GOLDEN_ENV = "NAX_UPDATE_WORKFLOW_GOLDEN";

async function withGoldenEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[GOLDEN_ENV];
  if (value === undefined) delete process.env[GOLDEN_ENV];
  else process.env[GOLDEN_ENV] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[GOLDEN_ENV];
    else process.env[GOLDEN_ENV] = previous;
  }
}

/** The path a golden for `scenario` takes under `root`; nothing is ever written to the fixture tree. */
const goldenPath = (root: string, scenario: string): string => join(root, "feature", `${scenario}.json`);

/** The rejection of `compareWithGolden`, or null when it passed. */
const goldenFailure = (trace: WorkflowTrace, root: string): Promise<unknown> =>
  compareWithGolden(trace, { root }).then(
    () => null,
    (err: unknown) => err,
  );

describe("compareWithGolden", () => {
  test("AC-18: a missing golden names the file and the regeneration variable", async () => {
    await withGoldenEnv(undefined, () =>
      withTempDir(async (root) => {
        const trace = await recordFeatureTrace("clean-pass", makeFeatureMachineHarness(CLEAN));
        const failure = await goldenFailure(trace, root);
        assertCaughtInstanceOf(failure, Error, "compareWithGolden rejection");
        expect(failure.message).toBe(
          `golden missing: ${goldenPath(root, "clean-pass")} (set NAX_UPDATE_WORKFLOW_GOLDEN=1 to create it)`,
        );
      }),
    );
  });

  test("AC-19: a missing golden is never created by the comparison", async () => {
    await withGoldenEnv(undefined, () =>
      withTempDir(async (root) => {
        const trace = await recordFeatureTrace("clean-pass", makeFeatureMachineHarness(CLEAN));
        await expect(compareWithGolden(trace, { root })).rejects.toThrow("golden missing");
        expect(await Bun.file(goldenPath(root, "clean-pass")).exists()).toBe(false);
      }),
    );
  });

  test("AC-20: NAX_UPDATE_WORKFLOW_GOLDEN=1 writes the normalized trace, two-space indented", async () => {
    await withGoldenEnv("1", () =>
      withTempDir(async (root) => {
        const trace = await recordFeatureTrace("clean-pass", makeFeatureMachineHarness(CLEAN));
        await compareWithGolden(trace, { root });
        const text = await Bun.file(goldenPath(root, "clean-pass")).text();
        expect(text).toBe(`${JSON.stringify(normalizeTrace(trace), null, 2)}\n`);
        expect(text).toContain('\n  "end":');
        expect(text.endsWith("\n")).toBe(true);
      }),
    );
  });

  test("AC-21: a difference at one event names the scenario, the index and both events", async () => {
    await withGoldenEnv("1", () =>
      withTempDir(async (root) => {
        const trace = await recordFeatureTrace("differs", makeFeatureMachineHarness(CLEAN));
        await compareWithGolden(trace, { root });
        await withGoldenEnv(undefined, async () => {
          const index = trace.events.findIndex((event) => event.kind === "step");
          const changed: WorkflowTrace = {
            ...trace,
            events: trace.events.map((event, at) => (at === index ? { kind: "step", step: "adjudicate" } : event)),
          };
          const failure = await goldenFailure(changed, root);
          assertCaughtInstanceOf(failure, Error, "compareWithGolden rejection");
          expect(failure.message).toContain('scenario "differs"');
          expect(failure.message).toContain(`event index ${index}`);
          expect(failure.message).toContain(`expected: ${JSON.stringify(normalizeTrace(trace).events[index])}`);
          expect(failure.message).toContain(`actual:   ${JSON.stringify(normalizeTrace(changed).events[index])}`);
        });
      }),
    );
  });

  test("AC-22: events equal but end different reports 'end differs' with both sides", async () => {
    await withGoldenEnv("1", () =>
      withTempDir(async (root) => {
        const trace = await recordFeatureTrace("ends", makeFeatureMachineHarness(CLEAN));
        await compareWithGolden(trace, { root });
        await withGoldenEnv(undefined, async () => {
          const changed: WorkflowTrace = { ...trace, end: { threw: { code: null, message: "boom" } } };
          const failure = await goldenFailure(changed, root);
          assertCaughtInstanceOf(failure, Error, "compareWithGolden rejection");
          expect(failure.message).toContain("end differs");
          expect(failure.message).not.toContain("event index");
          expect(failure.message).toContain(`expected: ${JSON.stringify(normalizeTrace(trace).end)}`);
          expect(failure.message).toContain(`actual:   ${JSON.stringify(normalizeTrace(changed).end)}`);
        });
      }),
    );
  });

  test("a shorter events list reports the shorter length and shows the missing side as (none)", async () => {
    await withGoldenEnv("1", () =>
      withTempDir(async (root) => {
        const trace = await recordFeatureTrace("prefix", makeFeatureMachineHarness(CLEAN));
        await compareWithGolden(trace, { root });
        await withGoldenEnv(undefined, async () => {
          const cut = 2;
          const changed: WorkflowTrace = { ...trace, events: trace.events.slice(0, cut) };
          const failure = await goldenFailure(changed, root);
          assertCaughtInstanceOf(failure, Error, "compareWithGolden rejection");
          expect(failure.message).toContain(`event index ${cut}`);
          expect(failure.message).toContain(`expected: ${JSON.stringify(normalizeTrace(trace).events[cut])}`);
          expect(failure.message).toContain("actual:   (none)");
        });
      }),
    );
  });

  test("the default root is the committed fixture tree beside the helper", async () => {
    await withGoldenEnv(undefined, async () => {
      const trace = await recordFeatureTrace("no-such-golden-scenario", makeFeatureMachineHarness(CLEAN));
      const failure = await compareWithGolden(trace).then(
        () => null,
        (err: unknown) => err,
      );
      assertCaughtInstanceOf(failure, Error, "compareWithGolden rejection");
      expect(failure.message).toContain(
        join("test", "fixtures", "workflow-equivalence", "feature", "no-such-golden-scenario.json"),
      );
    });
  });
});

import { afterEach, expect, test } from "bun:test";
import { makeAdviceDecision, makeFeatureContext, withWarnSpy } from "@test/helpers";
import { _ciWaitDeps, waitForChecks } from "@/workflow/ci-wait";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";

const saved = { feature: { ..._featureDeps }, workflow: { ..._workflowDeps }, ci: { ..._ciWaitDeps } };
afterEach(() => {
  Object.assign(_featureDeps, saved.feature);
  Object.assign(_workflowDeps, saved.workflow);
  Object.assign(_ciWaitDeps, saved.ci);
});

function wire(head: string | Error = "aaa") {
  const gitCalls: { args: string[]; cwd: string }[] = [];
  const order: string[] = [];
  _workflowDeps.git = async (args, cwd) => {
    gitCalls.push({ args, cwd });
    if (args[0] === "rev-parse") {
      order.push("head");
      if (head instanceof Error) throw head;
      return { exitCode: 0, stdout: head };
    }
    return { exitCode: 0, stdout: "" };
  };
  _workflowDeps.readTrustedDecisions = async () => [];
  _workflowDeps.resolveFeatureSpec = async () => ({ specSource: null });
  _featureDeps.detectForge = async () => "github";
  _featureDeps.commitLedger = async () => false;
  _featureDeps.commitAndPush = async () => {
    order.push("push");
    return { committed: false, pushed: true };
  };
  _featureDeps.openDraftFinishPr = async () => ({ url: "https://gh/pr/1" });
  let keepDraft: boolean | undefined;
  _featureDeps.openOrPromotePr = async (args) => {
    keepDraft = args.keepDraft;
    return { status: "already-ready", url: "https://gh/pr/1" };
  };
  const waits: unknown[] = [];
  _featureDeps.waitForChecks = async (_forge, _ref, opts) => {
    waits.push(opts);
    return { outcome: "green", detail: "all passed" };
  };
  let asked = 0;
  const input = {
    record: {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      reviewRan: true,
      finalGates: { ran: ["test"], failing: [] },
    },
    stories: [{ id: "US-001", title: "A", state: "complete" as const, rounds: 1, unreviewed: false, flagged: 0 }],
    flagged: 0,
    preflight: null,
    advisor: {
      advise: async () => {
        asked++;
        return { decision: makeAdviceDecision({ action: { type: "approve" } }) };
      },
      recordReuse: async () => null,
      adviseBatch: async () => ({ kind: "residual" as const, items: [], diagnoses: {} }),
    },
  };
  return { input, waits, gitCalls, order, keepDraft: () => keepDraft, asked: () => asked };
}

test("AC-9/15/16: publish waits for pushed HEAD with configured timeout, cadence and signal", async () => {
  const observed = wire();
  const base = makeFeatureContext({ projectDir: "/project", runSignal: new AbortController().signal });
  const fc = {
    ...base,
    workflow: { ...base.workflow, timeouts: { ...base.workflow.timeouts, ciWaitMs: 1234, ciPollMs: 56 } },
  };
  await publish(fc, observed.input);
  // US-003: the run's own publish opts into re-running starved jobs; every other option is unchanged.
  expect(observed.waits).toEqual([
    { cwd: "/project", timeoutMs: 1234, pollMs: 56, signal: fc.runSignal, expectedSha: "aaa", rerunStarved: true },
  ]);
  expect(observed.gitCalls).toContainEqual({ args: ["rev-parse", "HEAD"], cwd: "/project" });
  expect(observed.order).toEqual(["push", "head"]);
});

test("AC-10: unreadable HEAD warns once and omits expectedSha", async () => {
  const observed = wire(new Error("HEAD unavailable"));
  await withWarnSpy(async (warn) => {
    await publish(makeFeatureContext(), observed.input);
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[1]).toContain("HEAD");
  });
  expect(observed.waits).toHaveLength(1);
  expect(observed.waits[0]).not.toHaveProperty("expectedSha");
});

test("AC-11: empty HEAD omits expectedSha", async () => {
  const observed = wire("");
  await publish(makeFeatureContext(), observed.input);
  expect(observed.gitCalls).toContainEqual({ args: ["rev-parse", "HEAD"], cwd: "/repo" });
  expect(observed.waits).toHaveLength(1);
  expect(observed.waits[0]).not.toHaveProperty("expectedSha");
});

// US-003: a starved CI is not a failure to repair. The publish keeps the draft and retains the
// wait's own detail, so the record says what never ran rather than only that CI was not green.
test("AC-5: a starved CI wait keeps the PR a draft and retains the wait's detail", async () => {
  const observed = wire();
  const detail = "1 check(s) never got a runner: e2e; re-run them, or accept with --waive-starved <reason>";
  _featureDeps.waitForChecks = async (_forge, _ref, opts) => {
    observed.waits.push(opts);
    return { outcome: "starved", detail, starvedChecks: ["e2e"] };
  };
  const result = await publish(makeFeatureContext(), observed.input);
  expect(result).toMatchObject({ outcome: "draft", ci: "starved", ciDetail: detail });
  expect(result.reasons).toContain(`CI starved: ${detail}`);
  expect(observed.keepDraft()).toBe(true);
});

// US-001 (nax#2666): the advisor rules before the push, so a CI head mismatch is observed after its
// approval — the PR still stays a draft, and the advisor was asked exactly once.
test("AC-20: real CI mismatch timeout keeps publish draft after the advisor was asked", async () => {
  const observed = wire();
  let clock = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) => ({
    exitCode: 0,
    stderr: "",
    stdout: cmd[2] === "checks" ? '[{"bucket":"pass"}]' : '{"headRefOid":"bbb"}',
  });
  _featureDeps.waitForChecks = waitForChecks;
  const base = makeFeatureContext();
  const fc = {
    ...base,
    workflow: { ...base.workflow, timeouts: { ...base.workflow.timeouts, ciWaitMs: 20, ciPollMs: 10 } },
  };
  const result = await publish(fc, observed.input);
  expect(result).toMatchObject({ outcome: "draft", ci: "unavailable" });
  expect(result.reasons.join(" ")).toContain("checks report bbb but HEAD is aaa");
  expect(observed.keepDraft()).toBe(true);
  expect(observed.asked()).toBe(1);
});

import { afterEach, expect, test } from "bun:test";
import { assertDefined, makeAdviceDecision, makeFeatureContext, withWarnSpy } from "@test/helpers";
import type { PrRef } from "@/forge";
import { _ciFailuresDeps } from "@/workflow/ci-failures";
import { _ciWaitDeps, waitForChecks } from "@/workflow/ci-wait";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";

const saved = {
  feature: { ..._featureDeps },
  workflow: { ..._workflowDeps },
  ci: { ..._ciWaitDeps },
  failures: { ..._ciFailuresDeps },
};
afterEach(() => {
  Object.assign(_featureDeps, saved.feature);
  Object.assign(_workflowDeps, saved.workflow);
  Object.assign(_ciWaitDeps, saved.ci);
  Object.assign(_ciFailuresDeps, saved.failures);
});

/** The draft PR the forged step returns: the default carries a URL, as a real forge does; `null` is no PR. */
type Draft = { url: string } | null;

function wire(head: string | Error = "aaa", draft: Draft = { url: "https://gh/pr/1" }) {
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
  _featureDeps.openDraftFinishPr = async () => draft;
  let keepDraft: boolean | undefined;
  _featureDeps.openOrPromotePr = async (args) => {
    keepDraft = args.keepDraft;
    return { status: "already-ready", url: "https://gh/pr/1" };
  };
  const waits: Parameters<typeof _featureDeps.waitForChecks>[2][] = [];
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
  // US-003: the run's own publish opts into re-running starved jobs and, for a draft PR with a URL,
  // hands the wait the same-head re-run; every other option is passed exactly as before.
  const wait = observed.waits[0];
  assertDefined(wait, "the CI wait options");
  const { sameHeadRerun, ...rest } = wait;
  assertDefined(sameHeadRerun, "the same-head option");
  expect(rest).toEqual({
    cwd: "/project",
    timeoutMs: 1234,
    pollMs: 56,
    signal: fc.runSignal,
    expectedSha: "aaa",
    rerunStarved: true,
  });
  expect(typeof sameHeadRerun.read).toBe("function");
  expect(typeof sameHeadRerun.rerun).toBe("function");
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

const GH_REF: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 9 };
const GH_URL = "https://github.com/o/r/pull/9";

/** The same-head option the wait received; fails the test rather than reading through an optional. */
function sameHeadOf(observed: ReturnType<typeof wire>) {
  const wait = observed.waits[0];
  assertDefined(wait, "the CI wait options");
  const option = wait.sameHeadRerun;
  assertDefined(option, "the same-head option");
  return option;
}

// US-003: only the workflow's own publish opts into the same-head re-run, and only when it has both
// a draft PR URL and the HEAD it pushed — the PR the checks belong to and the commit they ran on.
test("AC-8: a pr-mode publish with a draft URL and a read HEAD passes the same-head option", async () => {
  const observed = wire("aaa", { url: GH_URL });
  await publish(makeFeatureContext(), observed.input);
  const option = sameHeadOf(observed);
  expect(typeof option.read).toBe("function");
  expect(typeof option.rerun).toBe("function");
  // Every option that existed before is still passed, with nothing added beside the new one.
  const wait = observed.waits[0];
  assertDefined(wait, "the CI wait options");
  const { sameHeadRerun: _option, ...rest } = wait;
  expect(Object.keys(rest).sort()).toEqual(["cwd", "expectedSha", "pollMs", "rerunStarved", "timeoutMs"]);
  expect(rest).toMatchObject({ cwd: "/repo", expectedSha: "aaa", rerunStarved: true });
});

test("AC-9: the option's read resolves PR 9 and reads the failed checks of head aaa", async () => {
  const observed = wire("aaa", { url: GH_URL });
  const numbers: number[] = [];
  const heads: string[] = [];
  _ciFailuresDeps.resolvePrRef = async (number) => {
    numbers.push(number);
    return GH_REF;
  };
  _ciFailuresDeps.readFailedChecks = async (_ref, head) => {
    heads.push(head);
    return [];
  };
  await publish(makeFeatureContext(), observed.input);
  await expect(sameHeadOf(observed).read()).resolves.toEqual([]);
  expect(numbers).toEqual([9]);
  expect(heads).toEqual(["aaa"]);
});

test("AC-10: a draft PR the forge returned no URL for passes no same-head option", async () => {
  const observed = wire("aaa", null);
  await publish(makeFeatureContext(), observed.input);
  expect(observed.waits).toHaveLength(1);
  expect(observed.waits[0]).not.toHaveProperty("sameHeadRerun");
  // Control: the same publish with a URL does carry the option, so the absence is the missing URL.
  const withUrl = wire("aaa", { url: GH_URL });
  await publish(makeFeatureContext(), withUrl.input);
  expect(withUrl.waits[0]).toHaveProperty("sameHeadRerun");
});

test("AC-11: push mode passes no same-head option (the caller owns that PR)", async () => {
  const base = makeFeatureContext();
  const observed = wire("aaa", { url: GH_URL });
  const pushed = await publish({ ...base, workflow: { ...base.workflow, publish: "push" as const } }, observed.input);
  expect(pushed.ci).toBe("green");
  expect(observed.waits).toHaveLength(1);
  expect(observed.waits[0]).not.toHaveProperty("sameHeadRerun");
  // Control: the same draft URL in pr mode does carry it, so the absence is the mode's doing.
  const pr = wire("aaa", { url: GH_URL });
  await publish(base, pr.input);
  expect(pr.waits[0]).toHaveProperty("sameHeadRerun");
});

test("AC-12: an unreadable HEAD passes no same-head option, even with a draft URL", async () => {
  const observed = wire(new Error("HEAD unavailable"), { url: GH_URL });
  await publish(makeFeatureContext(), observed.input);
  expect(observed.waits).toHaveLength(1);
  expect(observed.waits[0]).not.toHaveProperty("sameHeadRerun");
  // Control: the same URL with a readable HEAD does carry it, so the absence is the failed read.
  const read = wire("aaa", { url: GH_URL });
  await publish(makeFeatureContext(), read.input);
  expect(read.waits[0]).toHaveProperty("sameHeadRerun");
});

/** The push-mode context: the same facts, publishing depth `push`. */
function pushContext() {
  const base = makeFeatureContext({ branch: "feat/demo" });
  return { ...base, workflow: { ...base.workflow, publish: "push" as const } };
}

// US-005: push mode opens no PR, so the checks have no PR to hang on; it asks the wait to read the
// push's own commit instead.
test("AC-1: push mode asks the CI wait for the commit's check runs", async () => {
  const observed = wire("aaa", null);
  const result = await publish(pushContext(), observed.input);
  expect(result.outcome).toBe("pushed");
  expect(observed.waits).toHaveLength(1);
  expect(observed.waits[0]).toMatchObject({ commitChecks: true });
});

// US-005 (control): the commit path is push mode's alone — a pr-mode publish, with or without a
// draft URL, passes no `commitChecks` key at all, so its wait keeps reading the PR.
test("AC-2: pr mode passes no commitChecks key", async () => {
  const withUrl = wire("aaa", { url: GH_URL });
  await publish(makeFeatureContext(), withUrl.input);
  expect(withUrl.waits).toHaveLength(1);
  expect(withUrl.waits[0]).not.toHaveProperty("commitChecks");
  // A draft the forge returned no URL for is still a PR: no URL is not a request for the commit path.
  const noUrl = wire("aaa", null);
  await publish(makeFeatureContext(), noUrl.input);
  expect(noUrl.waits).toHaveLength(1);
  expect(noUrl.waits[0]).not.toHaveProperty("commitChecks");
  // Control: the same publish in push mode does carry it, so the absence is the mode's doing.
  const pushed = wire("aaa", null);
  await publish(pushContext(), pushed.input);
  expect(pushed.waits[0]).toHaveProperty("commitChecks", true);
});

// US-005: the wiring reaches the real wait, not only a stub. A branch with no pull request answers
// `gh pr checks` with GitHub's "no pull requests found", and the wait then reads the check runs of
// the commit push mode just pushed — whose green is the publish's CI verdict.
const SHA = "c".repeat(40);
const CHECK_RUNS = JSON.stringify({
  total_count: 1,
  check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
});

test("AC-3: a push-mode publish falls back to the pushed commit's check runs and reports green", async () => {
  const observed = wire(SHA, null);
  const argvs: string[][] = [];
  // The wait's own clock, faked: a green first poll settles it, and an unwired wait reaches the
  // deadline without a real 20-minute sleep.
  let clock = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) => {
    argvs.push(cmd);
    return cmd[1] === "api"
      ? { exitCode: 0, stdout: CHECK_RUNS, stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "no pull requests found for branch feat/demo" };
  };
  _featureDeps.waitForChecks = waitForChecks;
  const result = await publish(pushContext(), observed.input);
  expect(result).toMatchObject({ outcome: "pushed", ci: "green" });
  expect(argvs).toContainEqual(["gh", "api", `repos/{owner}/{repo}/commits/${SHA}/check-runs?per_page=100`]);
});

// US-003: what the wait re-ran is this publish's fact, so it reaches the outcome the step records.
test("AC-13: a wait that re-ran a check reports it as the publish outcome's ciReruns", async () => {
  const observed = wire();
  _featureDeps.waitForChecks = async (_forge, _ref, opts) => {
    observed.waits.push(opts);
    return { outcome: "green", detail: "all checks passed", sameHeadReruns: ["test"] };
  };
  const result = await publish(makeFeatureContext(), observed.input);
  expect(result).toMatchObject({ outcome: "ready", ci: "green", ciReruns: ["test"] });
});

test("AC-14: a wait that re-ran nothing leaves the ciReruns key absent", async () => {
  const observed = wire();
  const result = await publish(makeFeatureContext(), observed.input);
  expect("ciReruns" in result).toBe(false);
  // Control: the same publish whose wait did re-run carries the key, so its absence means "nothing
  // re-ran" rather than "the field is never written".
  const reran = wire();
  _featureDeps.waitForChecks = async (_forge, _ref, opts) => {
    reran.waits.push(opts);
    return { outcome: "green", detail: "all checks passed", sameHeadReruns: ["test"] };
  };
  expect(await publish(makeFeatureContext(), reran.input)).toHaveProperty("ciReruns", ["test"]);
});

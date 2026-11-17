import { afterEach, describe, expect, test } from "bun:test";
import { type FailedCheck, type ForgeRunResult, MAX_FAILED_CHECKS } from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { _ciWaitDeps, CI_ERROR_POLL_LIMIT, type CiWaitResult, waitForChecks } from "@/workflow/ci-wait";
import { CI_SAME_HEAD_SETTLE_POLLS, type SameHeadRerun } from "@/workflow/ci-wait-same-head";

/**
 * US-002: a failed check the forge itself shows passing on the same commit is non-deterministic, so
 * the CI wait may re-run it once (opt-in, `sameHeadRerun`) and set the old failed job aside for a
 * few polls while the forge catches up. `ci-wait.test.ts` is at the 800-line test limit, so these
 * live here, driven through `_ciWaitDeps` like `ci-wait-starved.test.ts`.
 */

const original = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, original));

const OPTS = { cwd: "/repo", timeoutMs: 100, pollMs: 30 };
/** Room for five `pollMs` polls before the deadline, for the set-aside cases. */
const ROOMY = { cwd: "/repo", timeoutMs: 300, pollMs: 30 };
const r = (stdout: string, exitCode = 0, stderr = ""): ForgeRunResult => ({ stdout, stderr, exitCode });

interface CheckSpec {
  readonly name: string;
  readonly bucket: string;
  readonly state?: string;
  readonly link?: string;
}

/** One `gh pr checks` reply. */
const ghPoll = (list: readonly CheckSpec[]): ForgeRunResult =>
  r(
    JSON.stringify(
      list.map((check) => ({
        name: check.name,
        state: check.state ?? check.bucket.toUpperCase(),
        bucket: check.bucket,
        ...(check.link === undefined ? {} : { link: check.link }),
      })),
    ),
  );

const FAILED_CHECK: CheckSpec = { name: "test", bucket: "fail", state: "FAILURE" };
const PENDING_CHECK: CheckSpec = { name: "test", bucket: "pending", state: "QUEUED" };
const PASSED_CHECK: CheckSpec = { name: "test", bucket: "pass", state: "SUCCESS" };
const CANCELLED_CHECK: CheckSpec = {
  name: "e2e",
  bucket: "cancel",
  state: "CANCELLED",
  link: "https://github.com/o/r/actions/runs/43/job/11",
};

/** One `glab mr view` reply. */
const glPoll = (status: string): ForgeRunResult => r(JSON.stringify({ head_pipeline: { status } }));
const GL_FAILED = glPoll("failed");
const GL_SUCCESS = glPoll("success");
/** A forge command that exits non-zero: an unreadable poll. */
const UNREADABLE = r("", 1, "gh: rate limited");
const STARVED_JOB = r('{"conclusion":"cancelled","runner_name":"","steps":[]}');

/** A scripted forge on a virtual clock: one poll reply per poll, plus the starved rules' job reads. */
function wire(polls: readonly ForgeRunResult[]) {
  const calls: string[][] = [];
  let clock = 0;
  let pollsRun = 0;
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "gh" && cmd[2] === "view") {
      return r(JSON.stringify({ mergeable: "MERGEABLE", headRefOid: "aaaaaaaa5678" }));
    }
    if (cmd[0] === "gh" && cmd[1] === "api") return cmd.includes("-X") ? r("{}") : STARVED_JOB;
    const reply = polls[Math.min(pollsRun, polls.length - 1)];
    pollsRun++;
    if (reply === undefined) throw new Error("no poll scripted");
    return reply;
  };
  return { calls, polls: () => pollsRun };
}

/** The same-head facts a re-runnable check carries. */
const FACTS = { passedOnSameHead: {}, jobId: "501" };

/** One failed check, with only the facts it is given — an absent fact leaves the key out. */
function failedCheck(
  name: string,
  facts: { readonly passedOnSameHead?: { readonly url?: string }; readonly jobId?: string },
): FailedCheck {
  return {
    name,
    excerpt: "",
    ...(facts.passedOnSameHead === undefined ? {} : { passedOnSameHead: facts.passedOnSameHead }),
    ...(facts.jobId === undefined ? {} : { jobId: facts.jobId }),
  };
}

/** What the default read returns: one check of the head's that passed elsewhere. */
const ONE_RERUNNABLE: readonly FailedCheck[] = [failedCheck("test", FACTS)];
/** Two re-runnable checks, for the ordering and the stop-at-the-first-refusal rules. */
const TWO_RERUNNABLE: readonly FailedCheck[] = [failedCheck("a", FACTS), failedCheck("b", FACTS)];

interface Seam {
  readonly seam: SameHeadRerun;
  readonly reads: () => number;
  readonly rerunNames: () => readonly string[];
}

/** A same-head seam over one scripted read and one scripted answer per check. */
function seamOf(read: () => Promise<readonly FailedCheck[]>, answer?: (check: FailedCheck) => boolean | Error): Seam {
  const rerunCalls: string[] = [];
  let reads = 0;
  return {
    reads: () => reads,
    rerunNames: () => rerunCalls,
    seam: {
      read: async () => {
        reads++;
        return await read();
      },
      rerun: async (check) => {
        rerunCalls.push(check.name);
        const verdict = answer === undefined ? true : answer(check);
        if (verdict instanceof Error) throw verdict;
        return verdict;
      },
    },
  };
}

/** A read returning `checks`, and a re-run the forge accepts unless `answer` says otherwise. */
function seamTo(checks: readonly FailedCheck[], answer?: (check: FailedCheck) => boolean | Error): Seam {
  return seamOf(async () => checks, answer);
}

/** A read that fails, as an unreadable forge reply does. */
function seamThatCannotRead(): Seam {
  return seamOf(async () => {
    throw new Error("gh: rate limited");
  });
}

/** The absence of the field, which is what "a wait that re-ran nothing" means. */
function hasReruns(result: CiWaitResult): boolean {
  return "sameHeadReruns" in result;
}

function logs(collect: (entry: LogEntry) => void): void {
  resetLogger();
  initLogger({ level: "silent" });
  addSink(collect);
}

describe("waitForChecks same-head re-runs", () => {
  afterEach(() => resetLogger());

  test("AC-1: a check that passed on the same commit is re-run and the wait goes green", async () => {
    wire([GL_FAILED, GL_SUCCESS]);
    const same = seamTo(ONE_RERUNNABLE);
    const out = await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam });
    expect(same.rerunNames()).toEqual(["test"]);
    expect(out).toEqual({ outcome: "green", detail: "all checks passed", sameHeadReruns: ["test"] });
  });

  test("AC-2: a failure, a pending poll, then a failure: one re-run and a failed wait", async () => {
    wire([ghPoll([FAILED_CHECK]), ghPoll([PENDING_CHECK]), ghPoll([FAILED_CHECK])]);
    const same = seamTo(ONE_RERUNNABLE);
    const out = await waitForChecks("github", "b", { ...OPTS, sameHeadRerun: same.seam });
    expect(same.rerunNames()).toEqual(["test"]);
    expect(same.reads()).toBe(1);
    expect(out.outcome).toBe("failed");
    expect(out.sameHeadReruns).toEqual(["test"]);
  });

  test("AC-8: three failures after the re-run are set aside, and the next ends the wait", async () => {
    const { polls } = wire([GL_FAILED]);
    const same = seamTo(ONE_RERUNNABLE);
    const out = await waitForChecks("gitlab", "7", { ...ROOMY, sameHeadRerun: same.seam });
    expect(same.rerunNames()).toEqual(["test"]);
    expect(out).toEqual({ outcome: "failed", detail: "a check failed", sameHeadReruns: ["test"] });
    // The poll that re-ran, the three set-aside polls, and the fifth that ends the wait.
    expect(polls()).toBe(CI_SAME_HEAD_SETTLE_POLLS + 2);
  });

  test("AC-9: a failure, a set-aside failure, then success: green", async () => {
    wire([GL_FAILED, GL_FAILED, GL_SUCCESS]);
    const same = seamTo(ONE_RERUNNABLE);
    const out = await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam });
    expect(out).toEqual({ outcome: "green", detail: "all checks passed", sameHeadReruns: ["test"] });
  });

  test("AC-10: the deadline reached while the re-run is pending is pending, with the re-run names", async () => {
    wire([ghPoll([FAILED_CHECK]), ghPoll([PENDING_CHECK])]);
    const same = seamTo(ONE_RERUNNABLE);
    const out = await waitForChecks("github", "b", { ...OPTS, sameHeadRerun: same.seam });
    expect(out).toEqual({
      outcome: "pending",
      detail: `no CI result within ${OPTS.timeoutMs}ms`,
      sameHeadReruns: ["test"],
    });
  });

  test("AC-11: a wait with no same-head option is today's wait, with no extra forge call", async () => {
    const { calls } = wire([ghPoll([FAILED_CHECK])]);
    const out = await waitForChecks("github", "b", OPTS);
    expect(out).toEqual({ outcome: "failed", detail: "CI failed: test; 0 still pending" });
    expect(hasReruns(out)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("AC-12: a starved poll is re-run by the starved rules, never by the same-head read", async () => {
    const { calls } = wire([ghPoll([CANCELLED_CHECK]), ghPoll([PASSED_CHECK])]);
    const same = seamTo(ONE_RERUNNABLE);
    const out = await waitForChecks("github", "b", { ...OPTS, rerunStarved: true, sameHeadRerun: same.seam });
    expect(out).toEqual({ outcome: "green", detail: "all checks passed" });
    expect(same.reads()).toBe(0);
    expect(calls.some((cmd) => cmd.includes("POST"))).toBe(true);
  });

  test("AC-18: an unreadable poll after the re-run marks no progress, so the failure is set aside", async () => {
    wire([GL_FAILED, UNREADABLE, GL_FAILED, GL_SUCCESS]);
    const same = seamTo(ONE_RERUNNABLE);
    const out = await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam });
    expect(out).toEqual({ outcome: "green", detail: "all checks passed", sameHeadReruns: ["test"] });
    expect(same.reads()).toBe(1);
  });

  test("AC-19: an abort after the re-run is an aborted wait that still says what it re-ran", async () => {
    wire([GL_FAILED, GL_SUCCESS]);
    const controller = new AbortController();
    const same = seamTo(ONE_RERUNNABLE, () => {
      controller.abort();
      return true;
    });
    const out = await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam, signal: controller.signal });
    expect(out).toEqual({ outcome: "pending", detail: "aborted", sameHeadReruns: ["test"] });
  });
});

describe("waitForChecks same-head conditions", () => {
  afterEach(() => resetLogger());

  test.each([
    ["AC-3: one failed check has no same-head fact", [failedCheck("a", FACTS), failedCheck("b", { jobId: "502" })]],
    ["AC-4: the check has no job to re-run", [failedCheck("test", { passedOnSameHead: {} })]],
    ["AC-5: the read returns nothing", [] as readonly FailedCheck[]],
  ])("%s: the failure stands and nothing is re-run", async (_label, checks) => {
    wire([ghPoll([FAILED_CHECK])]);
    const same = seamTo(checks);
    const out = await waitForChecks("github", "b", { ...OPTS, sameHeadRerun: same.seam });
    expect(out.outcome).toBe("failed");
    expect(hasReruns(out)).toBe(false);
    expect(same.reads()).toBe(1);
    expect(same.rerunNames()).toHaveLength(0);
  });

  test("AC-6: a read that fails leaves the failure standing", async () => {
    wire([ghPoll([FAILED_CHECK])]);
    const same = seamThatCannotRead();
    const out = await waitForChecks("github", "b", { ...OPTS, sameHeadRerun: same.seam });
    expect(out.outcome).toBe("failed");
    expect(hasReruns(out)).toBe(false);
    expect(same.reads()).toBe(1);
  });

  test("AC-7: a refused re-run request leaves the failure standing", async () => {
    wire([ghPoll([FAILED_CHECK])]);
    const same = seamTo(ONE_RERUNNABLE, () => false);
    const out = await waitForChecks("github", "b", { ...OPTS, sameHeadRerun: same.seam });
    expect(out.outcome).toBe("failed");
    expect(hasReruns(out)).toBe(false);
    expect(same.rerunNames()).toEqual(["test"]);
  });

  test("AC-16: a failed-check list at the cap may be truncated, so nothing is re-run", async () => {
    wire([ghPoll([FAILED_CHECK])]);
    const atCap = Array.from({ length: MAX_FAILED_CHECKS }, (_unused, index) => failedCheck(`c${index}`, FACTS));
    const same = seamTo(atCap);
    const out = await waitForChecks("github", "b", { ...OPTS, sameHeadRerun: same.seam });
    expect(out.outcome).toBe("failed");
    expect(hasReruns(out)).toBe(false);
    expect(same.reads()).toBe(1);
    expect(same.rerunNames()).toHaveLength(0);
  });

  test("AC-17: a failure replayed at the error-poll limit never asks for a read", async () => {
    const { polls } = wire([ghPoll([FAILED_CHECK, PENDING_CHECK]), UNREADABLE]);
    const same = seamTo(ONE_RERUNNABLE);
    const out = await waitForChecks("github", "b", { ...OPTS, sameHeadRerun: same.seam });
    expect(out).toEqual({ outcome: "failed", detail: "CI failed: test; 1 still pending" });
    expect(same.reads()).toBe(0);
    // One readable failing poll, then exactly `CI_ERROR_POLL_LIMIT` unreadable ones replay it.
    expect(polls()).toBe(CI_ERROR_POLL_LIMIT + 1);
  });
});

describe("waitForChecks same-head refusals", () => {
  afterEach(() => resetLogger());

  test("AC-14: a refused second check ends the wait, naming the one the forge accepted", async () => {
    wire([GL_FAILED]);
    const same = seamTo(TWO_RERUNNABLE, (check) => check.name === "a");
    const out = await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam });
    expect(out).toEqual({ outcome: "failed", detail: "a check failed", sameHeadReruns: ["a"] });
    expect(same.rerunNames()).toEqual(["a", "b"]);
  });

  test("AC-15: a refused first check ends the wait with nothing re-running", async () => {
    wire([GL_FAILED]);
    const same = seamTo(TWO_RERUNNABLE, () => false);
    const out = await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam });
    expect(out.outcome).toBe("failed");
    expect(hasReruns(out)).toBe(false);
    expect(same.rerunNames()).toEqual(["a"]);
  });

  test("AC-20: a request that throws after one was accepted keeps the accepted name", async () => {
    wire([GL_FAILED]);
    const same = seamTo(TWO_RERUNNABLE, (check) => (check.name === "a" ? true : new Error("gh: boom")));
    const out = await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam });
    expect(out).toEqual({ outcome: "failed", detail: "a check failed", sameHeadReruns: ["a"] });
    expect(same.rerunNames()).toEqual(["a", "b"]);
  });

  test("AC-21: a first request that throws re-runs nothing more", async () => {
    wire([GL_FAILED]);
    const same = seamTo(TWO_RERUNNABLE, () => new Error("gh: boom"));
    const out = await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam });
    expect(out.outcome).toBe("failed");
    expect(hasReruns(out)).toBe(false);
    expect(same.rerunNames()).toEqual(["a"]);
  });
});

describe("waitForChecks same-head logging", () => {
  afterEach(() => resetLogger());

  test("AC-13: a re-run says what it is re-running, in the run's scope", async () => {
    const entries: LogEntry[] = [];
    logs((entry) => entries.push(entry));
    wire([GL_FAILED, GL_SUCCESS]);
    const same = seamTo(ONE_RERUNNABLE);
    expect((await waitForChecks("gitlab", "7", { ...OPTS, sameHeadRerun: same.seam })).outcome).toBe("green");
    const info = entries.find(
      (entry) => entry.message === "CI wait: re-running 1 check(s) that passed on the same commit elsewhere: test",
    );
    expect(info).toMatchObject({ level: "info", stage: "workflow" });
    expect(Object.entries(info?.data ?? {})[0]).toEqual(["storyId", "_run"]);
  });
});

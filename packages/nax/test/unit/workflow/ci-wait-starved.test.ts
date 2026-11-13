import { afterEach, describe, expect, test } from "bun:test";
import type { ForgeRunResult } from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { _ciWaitDeps, waitForChecks } from "@/workflow/ci-wait";

/**
 * US-002: a CI check whose job never got a runner is `starved`, not `failed`. The wait classifies
 * it on a would-be failed poll, re-runs the job when the caller opted in (at most two rounds), and
 * keeps the head binding a green verdict already has. `ci-wait.test.ts` is at the 800-line test
 * limit, so these live here.
 */

const original = { ..._ciWaitDeps };
afterEach(() => Object.assign(_ciWaitDeps, original));

const OPTS = { cwd: "/repo", timeoutMs: 100, pollMs: 30 };
const r = (stdout: string, exitCode = 0, stderr = ""): ForgeRunResult => ({ stdout, stderr, exitCode });

interface Check {
  readonly name: string;
  readonly bucket: string;
  readonly state?: string;
  readonly link?: string;
}

const JOB_URL = (id: string): string => `https://github.com/o/r/actions/runs/43/job/${id}`;
const STARVED_JOB = r('{"conclusion":"cancelled","runner_name":"","steps":[]}');

/** A cancelled check whose job URL is the Actions job `jobId`. */
const cancelled = (name: string, jobId: string): Check => ({
  name,
  bucket: "cancel",
  state: "CANCELLED",
  link: JOB_URL(jobId),
});

const checks = (list: readonly Check[]): ForgeRunResult =>
  r(
    JSON.stringify(
      list.map((c) => ({
        name: c.name,
        state: c.state ?? c.bucket.toUpperCase(),
        bucket: c.bucket,
        ...(c.link === undefined ? {} : { link: c.link }),
      })),
    ),
    8,
  );

interface Wire {
  /** One `gh pr checks` reply per poll; the last repeats. */
  readonly polls: readonly ForgeRunResult[];
  /** The `gh api …/jobs/<id>` reply, per job id. */
  readonly job?: (jobId: string) => ForgeRunResult;
  /** The `gh api -X POST …/jobs/<id>/rerun` reply. */
  readonly rerun?: (jobId: string) => ForgeRunResult;
  /** The head `gh pr view --json headRefOid` reports, when the wait asks for it. */
  readonly headRefOid?: string;
  /** A head read that fails, to pin the fail-open contract. */
  readonly head?: ForgeRunResult;
}

const jobArgv = (jobId: string): string[] => [
  "gh",
  "api",
  "--hostname",
  "github.com",
  `repos/o/r/actions/jobs/${jobId}`,
];
const rerunArgv = (jobId: string): string[] => [
  "gh",
  "api",
  "--hostname",
  "github.com",
  "-X",
  "POST",
  `repos/o/r/actions/jobs/${jobId}/rerun`,
];

/**
 * The `gh pr view` reply: `githubWaiting` asks for mergeability, the starved head binding asks for
 * the head only. A scripted `head` stands in for a head read that fails.
 */
function viewReply(cmd: string[], spec: Wire): ForgeRunResult {
  if (cmd[5] !== "headRefOid") return r('{"mergeable":"MERGEABLE"}');
  return spec.head ?? r(JSON.stringify({ headRefOid: spec.headRefOid }));
}

/** The `gh api` reply: a job read, or — for a `-X POST` request — a re-run of that job. */
function apiReply(cmd: string[], spec: Wire, onRerun: (cmd: string[]) => void): ForgeRunResult {
  const jobId = /actions\/jobs\/(\d+)/.exec(cmd.join(" "))?.[1] ?? "";
  if (!cmd.includes("-X")) return (spec.job ?? (() => STARVED_JOB))(jobId);
  onRerun(cmd);
  return (spec.rerun ?? (() => r("{}")))(jobId);
}

/** A scripted forge with a virtual clock: one reply per poll, and per job read / re-run. */
function wire(spec: Wire) {
  const calls: string[][] = [];
  const rerunCalls: string[][] = [];
  let clock = 0;
  let poll = 0;
  const nextPoll = (): ForgeRunResult => {
    const reply = spec.polls[Math.min(poll, spec.polls.length - 1)];
    poll++;
    if (reply === undefined) throw new Error("no poll scripted");
    return reply;
  };
  _ciWaitDeps.now = () => clock;
  _ciWaitDeps.schedule = () => () => {};
  _ciWaitDeps.sleep = async (ms) => {
    clock += ms;
  };
  _ciWaitDeps.run = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "gh" && cmd[2] === "view") return viewReply(cmd, spec);
    if (cmd[0] === "gh" && cmd[1] === "api") return apiReply(cmd, spec, (rerun) => rerunCalls.push(rerun));
    return nextPoll();
  };
  return {
    calls,
    rerunCalls,
    jobReads: () => calls.filter((cmd) => cmd[0] === "gh" && cmd[1] === "api" && !cmd.includes("-X")),
  };
}

function logs(collect: (entry: LogEntry) => void): void {
  resetLogger();
  initLogger({ level: "silent" });
  addSink(collect);
}

describe("waitForChecks starved classification", () => {
  afterEach(() => resetLogger());

  test("AC-1: reads the checks with the link field", async () => {
    const { calls } = wire({ polls: [checks([{ name: "test", bucket: "pass" }])] });
    expect((await waitForChecks("github", "feat/x", OPTS)).outcome).toBe("green");
    expect(calls[0]).toEqual(["gh", "pr", "checks", "feat/x", "--json", "name,state,bucket,link"]);
  });

  test("AC-2/3/4: a cancelled check whose job never got a runner is starved", async () => {
    const { jobReads } = wire({ polls: [checks([cancelled("e2e", "11")])] });
    const out = await waitForChecks("github", "b", OPTS);
    expect(jobReads()).toEqual([jobArgv("11")]);
    expect(out.outcome).toBe("starved");
    expect(out.starvedChecks).toEqual(["e2e"]);
    expect(out.detail).toBe("1 check(s) never got a runner: e2e; re-run them, or accept with --waive-starved <reason>");
  });

  test("AC-5: a check in the fail bucket is never starved", async () => {
    const { jobReads } = wire({
      polls: [checks([cancelled("e2e", "11"), { name: "lint", bucket: "fail", state: "FAILURE" }])],
    });
    const out = await waitForChecks("github", "b", OPTS);
    expect(out.outcome).toBe("failed");
    expect(out.starvedChecks).toBeUndefined();
    // The cancelled check is still read; the failing one never is, so the starved arm cannot win.
    expect(jobReads()).toEqual([jobArgv("11")]);
  });

  test("AC-6: an unreadable job stays a failure", async () => {
    const { jobReads } = wire({ polls: [checks([cancelled("e2e", "11")])], job: () => r("", 1, "gh: Not Found") });
    const out = await waitForChecks("github", "b", OPTS);
    expect(out.outcome).toBe("failed");
    expect(jobReads()).toEqual([jobArgv("11")]);
  });

  test("AC-19: a cancelled check with no job URL is a failure", async () => {
    const noLink = wire({
      polls: [checks([{ name: "e2e", bucket: "cancel", state: "CANCELLED" }])],
    });
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("failed");
    expect(noLink.jobReads()).toEqual([]);

    const notAJob = wire({
      polls: [checks([{ name: "e2e", bucket: "cancel", state: "CANCELLED", link: "https://github.com/o/r/pull/12" }])],
    });
    expect((await waitForChecks("github", "b", OPTS)).outcome).toBe("failed");
    expect(notAJob.jobReads()).toEqual([]);
  });

  test.each([
    ["unparseable JSON", r("not json")],
    ["no steps array", r('{"conclusion":"cancelled","runner_name":""}')],
  ])("AC-20: a job reply with %s stays a failure", async (_label, reply) => {
    const { jobReads } = wire({ polls: [checks([cancelled("e2e", "11")])], job: () => reply });
    const out = await waitForChecks("github", "b", OPTS);
    expect(out.outcome).toBe("failed");
    expect(jobReads()).toEqual([jobArgv("11")]);
  });

  test("AC-17: a cancelled GitLab pipeline is a failure, never starved and never re-run", async () => {
    const { calls } = wire({ polls: [r(JSON.stringify({ iid: 3, head_pipeline: { status: "canceled" } }))] });
    const out = await waitForChecks("gitlab", "7", OPTS);
    expect(out).toEqual({ outcome: "failed", detail: "a check failed" });
    expect(calls.filter((cmd) => cmd[0] === "gh")).toEqual([]);
  });
});

describe("waitForChecks starved re-runs", () => {
  afterEach(() => resetLogger());

  test("AC-7: one re-run, then the re-run's check passes: green", async () => {
    const { rerunCalls } = wire({
      polls: [checks([cancelled("e2e", "1")]), checks([{ name: "e2e", bucket: "pass" }])],
    });
    const out = await waitForChecks("github", "b", { ...OPTS, rerunStarved: true });
    expect(out.outcome).toBe("green");
    expect(rerunCalls).toEqual([
      ["gh", "api", "--hostname", "github.com", "-X", "POST", "repos/o/r/actions/jobs/1/rerun"],
    ]);
  });

  test("AC-8/9: a new job id per poll spends both rounds, then reports starved", async () => {
    const { rerunCalls } = wire({
      polls: [checks([cancelled("e2e", "1")]), checks([cancelled("e2e", "2")]), checks([cancelled("e2e", "3")])],
    });
    const out = await waitForChecks("github", "b", { ...OPTS, rerunStarved: true });
    expect(out.outcome).toBe("starved");
    expect(out.starvedChecks).toEqual(["e2e"]);
    expect(rerunCalls).toEqual([rerunArgv("1"), rerunArgv("2")]);
    expect(out.detail).toBe(
      "1 check(s) never got a runner: e2e (re-run 2 time(s)); accept with --waive-starved <reason>",
    );
  });

  test("AC-10: a re-run GitHub has not reported yet gets no job read and spends no round", async () => {
    const { jobReads, rerunCalls } = wire({
      polls: [
        checks([cancelled("e2e", "1")]),
        checks([cancelled("e2e", "1")]),
        checks([{ name: "e2e", bucket: "pass" }]),
      ],
    });
    const out = await waitForChecks("github", "b", { ...OPTS, rerunStarved: true });
    expect(out.outcome).toBe("green");
    expect(rerunCalls).toEqual([rerunArgv("1")]);
    // The second poll set the check aside instead of reading job 1 again.
    expect(jobReads()).toEqual([jobArgv("1")]);
  });

  test("AC-11/12: a failed re-run request ends the wait starved, with a warning", async () => {
    const entries: LogEntry[] = [];
    logs((entry) => entries.push(entry));
    wire({ polls: [checks([cancelled("e2e", "1")])], rerun: () => r("", 1, "gh: Forbidden") });
    const out = await waitForChecks("github", "b", { ...OPTS, rerunStarved: true });
    expect(out.outcome).toBe("starved");
    expect(out.detail).toBe(
      "1 check(s) never got a runner: e2e (the re-run request failed); accept with --waive-starved <reason>",
    );
    const warn = entries.find((e) => e.message === "CI wait: could not re-run e2e");
    expect(warn).toMatchObject({ level: "warn", stage: "workflow" });
    expect(Object.entries(warn?.data ?? {})[0]).toEqual(["storyId", "_run"]);
  });

  test("AC-13: a re-run round says what it is re-running", async () => {
    const entries: LogEntry[] = [];
    logs((entry) => entries.push(entry));
    wire({ polls: [checks([cancelled("e2e", "1")]), checks([{ name: "e2e", bucket: "pass" }])] });
    expect((await waitForChecks("github", "b", { ...OPTS, rerunStarved: true })).outcome).toBe("green");
    const info = entries.find(
      (e) => e.message === "CI wait: re-running 1 check(s) that never got a runner: e2e (round 1 of 2)",
    );
    expect(info).toMatchObject({ level: "info", stage: "workflow" });
    expect(Object.entries(info?.data ?? {})[0]).toEqual(["storyId", "_run"]);
  });
});

describe("waitForChecks starved deadline", () => {
  afterEach(() => resetLogger());

  const DEADLINE = { cwd: "/repo", timeoutMs: 30, pollMs: 30 };

  test("AC-14: a re-run check still QUEUED at the deadline is starved", async () => {
    wire({
      polls: [
        checks([cancelled("e2e", "1")]),
        checks([{ name: "e2e", bucket: "pending", state: "QUEUED", link: JOB_URL("1") }]),
      ],
    });
    const out = await waitForChecks("github", "b", { ...DEADLINE, rerunStarved: true });
    expect(out.outcome).toBe("starved");
    expect(out.starvedChecks).toEqual(["e2e"]);
  });

  test("AC-15: a re-run check IN_PROGRESS at the deadline is still pending", async () => {
    wire({
      polls: [
        checks([cancelled("e2e", "1")]),
        checks([{ name: "e2e", bucket: "pending", state: "IN_PROGRESS", link: JOB_URL("2") }]),
      ],
    });
    expect((await waitForChecks("github", "b", { ...DEADLINE, rerunStarved: true })).outcome).toBe("pending");
  });

  test("AC-16: a check this wait never re-ran is still pending at the deadline", async () => {
    const { rerunCalls } = wire({ polls: [checks([{ name: "e2e", bucket: "pending", state: "QUEUED" }])] });
    const out = await waitForChecks("github", "b", DEADLINE);
    expect(out.outcome).toBe("pending");
    // No round ran, so the deadline rule has nothing to starve (US-002) and re-runs nothing.
    expect(rerunCalls).toEqual([]);
  });
});

describe("waitForChecks starved head binding", () => {
  afterEach(() => resetLogger());

  test("AC-18: a starved poll for another head is unavailable, with no job read", async () => {
    const { jobReads } = wire({ polls: [checks([cancelled("e2e", "11")])], headRefOid: "bbbbbbbb1234" });
    const out = await waitForChecks("github", "b", { ...OPTS, expectedSha: "aaaaaaaa5678" });
    expect(out).toEqual({ outcome: "unavailable", detail: "checks report bbbbbbbb but HEAD is aaaaaaaa" });
    expect(jobReads()).toEqual([]);
  });

  test("a starved poll for this head is classified, not held back", async () => {
    const { jobReads } = wire({ polls: [checks([cancelled("e2e", "11")])], headRefOid: "aaaaaaaa5678" });
    const out = await waitForChecks("github", "b", { ...OPTS, expectedSha: "aaaaaaaa5678" });
    expect(out.outcome).toBe("starved");
    expect(jobReads()).toEqual([jobArgv("11")]);
  });

  test("an unreadable head leaves the poll as it is (fail open)", async () => {
    const { jobReads } = wire({ polls: [checks([cancelled("e2e", "11")])], head: r("", 1, "gh: auth required") });
    const out = await waitForChecks("github", "b", { ...OPTS, expectedSha: "aaaaaaaa5678" });
    expect(out.outcome).toBe("starved");
    expect(jobReads()).toEqual([jobArgv("11")]);
  });
});

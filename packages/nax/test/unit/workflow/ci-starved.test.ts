import { describe, expect, test } from "bun:test";
import type { ForgeRunResult } from "@/forge/types";
import { actionsJobOf, CI_STARVED_RERUN_LIMIT, type CiRun, isStarvedJob, rerunJob } from "@/workflow/ci-starved";

const JOB = { host: "github.com", repo: "o/r", jobId: "131317856040" };
const CWD = "/repo";

function stubRun(result: ForgeRunResult, capture?: (cmd: string[], opts: { cwd: string }) => void): CiRun {
  return async (cmd, opts) => {
    capture?.(cmd, opts);
    return result;
  };
}

/** A runner that throws instead of answering: a spawn failure, not a command result. */
const throwingRun: CiRun = async () => {
  throw new Error("spawn failed");
};

describe("actionsJobOf", () => {
  test("extracts an Actions job URL", () => {
    expect(actionsJobOf("https://github.com/o/r/actions/runs/43/job/131317856040")).toEqual(JOB);
  });
  test.each(["https://github.com/o/r/pull/12/checks", ""])("returns undefined for non-job link %j", (link) => {
    expect(actionsJobOf(link)).toBeUndefined();
  });
});

describe("isStarvedJob", () => {
  test.each([
    '{"conclusion":"cancelled","runner_name":"","steps":[]}',
    '{"conclusion":"cancelled","runner_name":null,"steps":[]}',
  ])("recognizes an unassigned cancelled job: %s", async (stdout) => {
    expect(await isStarvedJob(JOB, CWD, stubRun({ exitCode: 0, stdout, stderr: "" }))).toBe(true);
  });
  test("does not classify a job with a runner and step as starved", async () => {
    const stdout = JSON.stringify({
      conclusion: "cancelled",
      runner_name: "GitHub Actions 1000033956",
      steps: [{ name: "build" }],
    });
    expect(await isStarvedJob(JOB, CWD, stubRun({ exitCode: 0, stdout, stderr: "" }))).toBe(false);
  });
  test.each([
    { exitCode: 1, stdout: "{}", stderr: "failed" },
    { exitCode: 0, stdout: "not JSON", stderr: "" },
    { exitCode: 0, stdout: '{"conclusion":"cancelled","runner_name":"","steps":null}', stderr: "" },
  ])("fails closed for an unreadable/malformed job reply: %j", async (result) => {
    expect(await isStarvedJob(JOB, CWD, stubRun(result))).toBe(false);
  });
  test("fails closed when the runner throws instead of answering", async () => {
    expect(await isStarvedJob(JOB, CWD, throwingRun)).toBe(false);
  });
  test("runs the job read through the supplied runner", async () => {
    let called: { cmd: string[]; cwd: string } | undefined;
    const run = stubRun(
      { exitCode: 0, stdout: '{"conclusion":"cancelled","runner_name":"","steps":[]}', stderr: "" },
      (cmd, opts) => {
        called = { cmd, cwd: opts.cwd };
      },
    );
    await isStarvedJob(JOB, CWD, run);
    expect(called).toEqual({
      cmd: ["gh", "api", "--hostname", "github.com", "repos/o/r/actions/jobs/131317856040"],
      cwd: CWD,
    });
  });
});

describe("rerunJob", () => {
  test("posts through the supplied runner and returns true for exit zero", async () => {
    let called: { cmd: string[]; cwd: string } | undefined;
    const run = stubRun({ exitCode: 0, stdout: "", stderr: "" }, (cmd, opts) => {
      called = { cmd, cwd: opts.cwd };
    });
    expect(await rerunJob(JOB, CWD, run)).toBe(true);
    expect(called).toEqual({
      cmd: ["gh", "api", "--hostname", "github.com", "-X", "POST", "repos/o/r/actions/jobs/131317856040/rerun"],
      cwd: CWD,
    });
  });
  test("returns false for a failed request", async () => {
    expect(await rerunJob(JOB, CWD, stubRun({ exitCode: 1, stdout: "", stderr: "failed" }))).toBe(false);
  });
  test("returns false when the runner throws instead of answering", async () => {
    expect(await rerunJob(JOB, CWD, throwingRun)).toBe(false);
  });
});

test("CI_STARVED_RERUN_LIMIT is two", () => {
  expect(CI_STARVED_RERUN_LIMIT).toBe(2);
});

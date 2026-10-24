/**
 * `readJobSteps` and how `readFailedChecks` folds a job's steps into a failed
 * Actions check.
 *
 * A job stops at its first failing step, so the steps after it never ran: the
 * step that failed and the steps CI skipped because of it are what a repair
 * agent needs beyond the job name.
 *
 * No test touches a real forge: every call goes through a fake `ForgeDeps`.
 */

import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { FailedCheck, ForgeDeps, PrRef } from "@/forge";
import * as forge from "@/forge";
import { readJobSteps } from "@/forge/job-steps";

const gh: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 42 };
const gl: PrRef = { forge: "gitlab", host: "gitlab.com", repo: "g/p", number: 7 };

const LISTING = [
  "gh",
  "api",
  "--hostname",
  "github.com",
  "repos/o/r/commits/abc123/check-runs?per_page=100&filter=latest",
];
const JOB_LOG = [
  "gh",
  "api",
  "--allow-escape-sequences",
  "--hostname",
  "github.com",
  "repos/o/r/actions/jobs/991/logs",
];
const JOB_STEPS = ["gh", "api", "--hostname", "github.com", "repos/o/r/actions/jobs/991"];

const GL_PIPELINES = [
  "glab",
  "api",
  "--hostname",
  "gitlab.com",
  "projects/g%2Fp/merge_requests/7/pipelines?per_page=20",
];
const GL_JOBS = [
  "glab",
  "api",
  "--hostname",
  "gitlab.com",
  "projects/g%2Fp/pipelines/77/jobs?scope[]=failed&per_page=100",
];
const GL_TRACE = ["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/jobs/991/trace"];

/** The job log every fixture answers with, unless it is told otherwise. */
const LOG = "step output\nfailed";

/** One captured subprocess call. */
interface Call {
  readonly cmd: readonly string[];
  readonly cwd: string;
}

/** A subprocess reply. */
interface Reply {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A reply carrying a JSON payload. */
function ok(payload: unknown): Reply {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
}

/** A reply carrying raw text, as a log or a malformed payload arrives. */
function text(stdout: string): Reply {
  return { exitCode: 0, stdout, stderr: "" };
}

/** A reply carrying no steps at all, as the check-runs JSON does. */
const NO_STEPS = ok({});

/** One step of a jobs reply, as loosely as the API may report it. */
interface StepPayload {
  readonly name?: unknown;
  readonly conclusion?: unknown;
}

/** A jobs reply carrying `steps`. */
function steps(...entries: readonly StepPayload[]): Reply {
  return ok({ steps: entries });
}

/** The one failed GitHub Actions check every fixture reports. */
const ACTIONS_CHECK = { id: 991, name: "build", conclusion: "failure", app: { slug: "github-actions" } };

/** A steps command that rejects, as a spawn that never produced a process does. */
interface Rejected {
  readonly reject: string;
}

/** What the steps command answers: a reply, or the error it rejects with. */
type StepsCommand = Reply | Rejected;

/** A forge whose listing, job log and job steps answer from the arguments. */
function actionsFixture(jobs: StepsCommand, log: Reply = text(LOG)): { deps: ForgeDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: ForgeDeps = {
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      const endpoint = cmd.at(-1) ?? "";
      if (endpoint.endsWith("/logs")) return log;
      if (endpoint === "repos/o/r/actions/jobs/991") {
        if ("reject" in jobs) throw new Error(jobs.reject);
        return jobs;
      }
      return ok({ check_runs: [ACTIONS_CHECK] });
    },
    readText: async () => null,
  };
  return { deps, calls };
}

/** The one failed check of a fixture whose jobs reply is `jobs`. */
async function actionsCheck(jobs: StepsCommand, log?: Reply): Promise<{ check: FailedCheck; calls: Call[] }> {
  const { deps, calls } = actionsFixture(jobs, log);
  const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
  expect(checks).toHaveLength(1);
  const check = checks[0];
  assertDefined(check, "failed check");
  return { check, calls };
}

const INSTALL_AUDIT_PIP_AUDIT = steps(
  { name: "Install", conclusion: "success" },
  { name: "bun audit", conclusion: "failure" },
  { name: "pip-audit", conclusion: "skipped" },
);

describe("readFailedChecks job steps", () => {
  test("US-003 AC-1 names the step whose conclusion is failure", async () => {
    const { check } = await actionsCheck(INSTALL_AUDIT_PIP_AUDIT);
    expect(check.failedStep).toBe("bun audit");
  });

  test("US-003 AC-2 lists the steps skipped after the failed step", async () => {
    const { check } = await actionsCheck(INSTALL_AUDIT_PIP_AUDIT);
    expect(check.skippedSteps).toEqual(["pip-audit"]);
  });

  test("US-003 AC-3 leaves out a step skipped before the failure", async () => {
    const { check } = await actionsCheck(
      steps(
        { name: "Cache", conclusion: "skipped" },
        { name: "test", conclusion: "failure" },
        { name: "report", conclusion: "skipped" },
      ),
    );
    expect(check.skippedSteps).toEqual(["report"]);
    expect(check.skippedSteps).not.toContain("Cache");
  });

  test("US-003 AC-4 names the first of two failed steps", async () => {
    const { check } = await actionsCheck(
      steps({ name: "a", conclusion: "failure" }, { name: "b", conclusion: "failure" }),
    );
    expect(check.failedStep).toBe("a");
  });

  test("US-003 AC-5 omits skippedSteps when the failed step is the last step", async () => {
    const { check } = await actionsCheck(
      steps({ name: "Install", conclusion: "success" }, { name: "bun audit", conclusion: "failure" }),
    );
    expect(check.failedStep).toBe("bun audit");
    expect(check).not.toHaveProperty("skippedSteps");
  });

  test("US-003 AC-6 reads the job's steps third, after its log", async () => {
    const { calls } = await actionsCheck(INSTALL_AUDIT_PIP_AUDIT);
    expect(calls.map((call) => call.cmd)).toEqual([LISTING, JOB_LOG, JOB_STEPS]);
    expect(calls[1]?.cmd).toEqual(JOB_LOG);
    expect(calls[2]?.cmd).toEqual(JOB_STEPS);
    expect(calls[2]?.cwd).toBe("/repo");
  });

  test("US-003 AC-7 names no failed step when the jobs command fails", async () => {
    const { check } = await actionsCheck({ exitCode: 1, stdout: "", stderr: "HTTP 404" });
    expect(check).not.toHaveProperty("failedStep");
  });

  test("US-003 AC-8 lists no skipped steps when the jobs command fails", async () => {
    const { check } = await actionsCheck({ exitCode: 1, stdout: "", stderr: "HTTP 404" });
    expect(check).not.toHaveProperty("skippedSteps");
  });

  test("US-003 AC-9 keeps the excerpt when the jobs command fails", async () => {
    const failedJobs = await actionsCheck({ exitCode: 1, stdout: "", stderr: "HTTP 404" });
    const noSteps = await actionsCheck(NO_STEPS);
    expect(failedJobs.check.excerpt).toBe(noSteps.check.excerpt);
    expect(failedJobs.check.excerpt).toBe(forge.ciExcerpt(LOG));
  });

  test("keeps the check when the jobs command rejects instead of answering (AC-7)", async () => {
    const { check } = await actionsCheck({ reject: "[forge] gh is not installed" });
    expect(check.name).toBe("build");
    expect(check).not.toHaveProperty("failedStep");
    expect(check).not.toHaveProperty("skippedSteps");
    expect(check.excerpt).toBe(forge.ciExcerpt(LOG));
  });

  test("US-003 AC-10 names no failed step when the jobs reply is not JSON", async () => {
    const { check } = await actionsCheck(text("not JSON"));
    expect(check).not.toHaveProperty("failedStep");
  });

  test("US-003 AC-11 lists no skipped steps when the jobs reply is not JSON", async () => {
    const { check } = await actionsCheck(text("not JSON"));
    expect(check).not.toHaveProperty("skippedSteps");
  });

  test("US-003 AC-12 names no failed step when the jobs reply has no steps array", async () => {
    const { check } = await actionsCheck(ok({ name: "build", conclusion: "failure" }));
    expect(check).not.toHaveProperty("failedStep");
  });

  test("US-003 AC-13 lists no skipped steps when the jobs reply has no steps array", async () => {
    const { check } = await actionsCheck(ok({ name: "build", conclusion: "failure" }));
    expect(check).not.toHaveProperty("skippedSteps");
  });

  const NO_FAILURE = steps(
    { name: "Install", conclusion: "success" },
    { name: "test", conclusion: "skipped" },
    { name: "report", conclusion: "neutral" },
  );

  test("US-003 AC-14 names no failed step when no step's conclusion is failure", async () => {
    const { check } = await actionsCheck(NO_FAILURE);
    expect(check).not.toHaveProperty("failedStep");
  });

  test("US-003 AC-15 lists no skipped steps when no step's conclusion is failure", async () => {
    const { check } = await actionsCheck(NO_FAILURE);
    expect(check).not.toHaveProperty("skippedSteps");
  });

  test("US-003 AC-16 runs only the listing for a check run of another app", async () => {
    const calls: (readonly string[])[] = [];
    const deps: ForgeDeps = {
      run: async (cmd) => {
        calls.push(cmd);
        return ok({ check_runs: [{ id: 5, name: "build", conclusion: "failure", app: { slug: "circleci" } }] });
      },
      readText: async () => null,
    };
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks).toHaveLength(1);
    expect(calls).toEqual([LISTING]);
  });

  test("US-003 AC-17 names the failed step when the job log is unavailable", async () => {
    const { check } = await actionsCheck(
      steps({ name: "Install", conclusion: "success" }, { name: "lint", conclusion: "failure" }),
      { exitCode: 1, stdout: "", stderr: "boom" },
    );
    expect(check.logUnavailable).toBe(true);
    expect(check.failedStep).toBe("lint");
  });

  test("US-003 AC-18 names no failed step on a GitLab job", async () => {
    const calls: (readonly string[])[] = [];
    const replies = new Map<string, Reply>([
      [GL_PIPELINES.join(" "), ok([{ id: 77, sha: "abc123" }])],
      [GL_JOBS.join(" "), ok([{ id: 991, name: "unit" }])],
      [GL_TRACE.join(" "), text("the trace\nfailed")],
    ]);
    const deps: ForgeDeps = {
      run: async (cmd) => {
        calls.push(cmd);
        return replies.get(cmd.join(" ")) ?? { exitCode: 1, stdout: "", stderr: `unexpected call: ${cmd.join(" ")}` };
      },
      readText: async () => null,
    };
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks).toHaveLength(1);
    const check = checks[0];
    assertDefined(check, "failed job");
    expect(check.name).toBe("unit");
    expect(check).not.toHaveProperty("failedStep");
    expect(check).not.toHaveProperty("skippedSteps");
    expect(calls).toEqual([GL_PIPELINES, GL_JOBS, GL_TRACE]);
  });
});

describe("readJobSteps", () => {
  /** A forge whose only call answers with `command`. */
  function stepsFixture(command: StepsCommand): { deps: ForgeDeps; calls: Call[] } {
    const calls: Call[] = [];
    const deps: ForgeDeps = {
      run: async (cmd, opts) => {
        calls.push({ cmd, cwd: opts.cwd });
        if ("reject" in command) throw new Error(command.reject);
        return command;
      },
      readText: async () => null,
    };
    return { deps, calls };
  }

  test("reads the job of the ref's host and repo", async () => {
    const { deps, calls } = stepsFixture(steps({ name: "test", conclusion: "failure" }));
    await readJobSteps(gh, "991", deps, "/repo");
    expect(calls).toEqual([{ cmd: JOB_STEPS, cwd: "/repo" }]);
  });

  test("returns the failed step and the steps skipped after it, in job order", async () => {
    const { deps } = stepsFixture(
      steps(
        { name: "Install", conclusion: "success" },
        { name: "bun audit", conclusion: "failure" },
        { name: "pip-audit", conclusion: "skipped" },
        { name: "report", conclusion: "skipped" },
      ),
    );
    expect(await readJobSteps(gh, "991", deps, "/repo")).toEqual({
      failedStep: "bun audit",
      skippedSteps: ["pip-audit", "report"],
    });
  });

  test.each([
    ["the command fails", { exitCode: 2, stdout: "", stderr: "HTTP 404" }],
    ["the command rejects", { reject: "[forge] spawn gh ENOENT" }],
    ["the reply is not JSON", text("not JSON")],
    ["the reply is JSON null", text("null")],
    ["the reply is a JSON array", ok([])],
    ["the reply has no steps array", ok({ id: 991 })],
    ["the steps field is not an array", ok({ steps: "none" })],
    ["the steps array is empty", ok({ steps: [] })],
    ["no step concluded failure", steps({ name: "test", conclusion: "success" })],
    ["the failure is unnamed", steps({ conclusion: "failure" }, { name: "test", conclusion: "skipped" })],
    ["the failure concluded cancelled", steps({ name: "test", conclusion: "cancelled" })],
    ["the failure concluded timed_out", steps({ name: "test", conclusion: "timed_out" })],
    ["the entry is not an object", ok({ steps: [null, "Install", 7] })],
  ])("returns no step facts when %s", async (_case, reply) => {
    const { deps } = stepsFixture(reply);
    expect(await readJobSteps(gh, "991", deps, "/repo")).toEqual({});
  });

  test("drops a skipped step whose name is missing", async () => {
    const { deps } = stepsFixture(
      steps(
        { name: "test", conclusion: "failure" },
        { conclusion: "skipped" },
        { name: "report", conclusion: "skipped" },
      ),
    );
    expect(await readJobSteps(gh, "991", deps, "/repo")).toEqual({
      failedStep: "test",
      skippedSteps: ["report"],
    });
  });

  test("treats a step with no conclusion as not failed", async () => {
    const { deps } = stepsFixture(steps({ name: "Install" }, { name: "test", conclusion: "failure" }));
    expect(await readJobSteps(gh, "991", deps, "/repo")).toEqual({ failedStep: "test" });
  });
});

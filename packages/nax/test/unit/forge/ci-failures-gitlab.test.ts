/**
 * The GitLab half of `readFailedChecks` and the shared listing/log error
 * behavior of both forges.
 *
 * Split from `ci-failures.test.ts` by concern: that file pins the helpers and
 * the GitHub path, this one pins the GitLab path and the error boundaries.
 *
 * No test touches a real forge: every call goes through a fake `ForgeDeps`.
 */

import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import * as forge from "@/forge";

const ESC = "\u001b";

const gl: PrRef = { forge: "gitlab", host: "gitlab.com", repo: "g/p", number: 7 };
const gh: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 42 };

/** The argv of every GitLab listing and log call, as one string key. */
const GL_PIPELINES = "glab api --hostname gitlab.com projects/g%2Fp/merge_requests/7/pipelines?per_page=20";
const GL_JOBS = "glab api --hostname gitlab.com projects/g%2Fp/pipelines/77/jobs?scope[]=failed&per_page=100";
const glTrace = (jobId: number): string => `glab api --hostname gitlab.com projects/g%2Fp/jobs/${jobId}/trace`;
/** The argv of the success-jobs read of one sibling pipeline, as one string key. */
const glSuccess = (pipelineId: number): string =>
  `glab api --hostname gitlab.com projects/g%2Fp/pipelines/${pipelineId}/jobs?scope[]=success&per_page=100`;

/** The argv of the GitHub listing and of one GitHub Actions job log. */
const GH_LISTING = "gh api --hostname github.com repos/o/r/commits/abc123/check-runs?per_page=100&filter=latest";
const ghJobLog = (jobId: number): string =>
  `gh api --allow-escape-sequences --hostname github.com repos/o/r/actions/jobs/${jobId}/logs`;

/** The exact argv the GitLab pipelines listing must use. */
const PIPELINES_ARGV = [
  "glab",
  "api",
  "--hostname",
  "gitlab.com",
  "projects/g%2Fp/merge_requests/7/pipelines?per_page=20",
];
/** The exact argv the GitLab jobs listing must use. */
const JOBS_ARGV = [
  "glab",
  "api",
  "--hostname",
  "gitlab.com",
  "projects/g%2Fp/pipelines/77/jobs?scope[]=failed&per_page=100",
];
/** The exact argv the GitHub check-runs listing must use. */
const GH_LISTING_ARGV = [
  "gh",
  "api",
  "--hostname",
  "github.com",
  "repos/o/r/commits/abc123/check-runs?per_page=100&filter=latest",
];

interface FakeReply {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A reply that carries a JSON payload. */
function ok(payload: unknown): FakeReply {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
}

/** A reply that carries a raw log. */
function log(text: string): FakeReply {
  return { exitCode: 0, stdout: text, stderr: "" };
}

/** A forge whose calls answer from `replies`, keyed by the joined argv. */
function forgeFixture(replies: Readonly<Record<string, FakeReply>>) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const deps: ForgeDeps = {
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      const key = cmd.join(" ");
      return replies[key] ?? { exitCode: 1, stdout: "", stderr: `unexpected call: ${key}` };
    },
    readText: async () => null,
  };
  return { deps, calls };
}

describe("readFailedChecks on GitLab", () => {
  test("US-002 AC-10 keeps ciExcerpt for a GitLab trace containing annotations", async () => {
    const text = `##[error]failed\n${"trace line\n".repeat(3_000)}last line\n`;
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 991, name: "unit" }]),
      [glTrace(991)]: log(text),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.excerpt).toBe(forge.ciExcerpt(text));
  });

  test("AC-1 reads the pipelines of the merge request first", async () => {
    const { deps, calls } = forgeFixture({ [GL_PIPELINES]: ok([]) });
    await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(calls[0]?.cmd).toEqual(PIPELINES_ARGV);
    expect(calls[0]?.cwd).toBe("/repo");
  });

  test("AC-2 reads the jobs of the first pipeline with the head sha", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([
        { id: 12, sha: "other" },
        { id: 77, sha: "abc123" },
        { id: 88, sha: "abc123" },
      ]),
      [GL_JOBS]: ok([]),
    });
    await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(calls[1]?.cmd).toEqual(JOBS_ARGV);
  });

  test("AC-3 returns no checks when no pipeline has the head sha", async () => {
    const { deps } = forgeFixture({ [GL_PIPELINES]: ok([{ id: 77, sha: "other" }]) });
    expect(await forge.readFailedChecks(gl, "abc123", deps, "/repo")).toEqual([]);
  });

  test("AC-4 makes no jobs call when no pipeline has the head sha", async () => {
    const { deps, calls } = forgeFixture({ [GL_PIPELINES]: ok([{ id: 77, sha: "other" }]) });
    await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(calls.map((call) => call.cmd)).toEqual([PIPELINES_ARGV]);
  });

  test("AC-5 drops a failed job that is allowed to fail", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([
        { id: 991, name: "allowed", allow_failure: true },
        { id: 992, name: "required" },
      ]),
      [glTrace(992)]: log("required failed"),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks.map((check) => check.name)).toEqual(["required"]);
    expect(calls.map((call) => call.cmd)).toEqual([
      PIPELINES_ARGV,
      JOBS_ARGV,
      ["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/jobs/992/trace"],
    ]);
  });

  test("AC-6 reads the trace of every kept job with its own id", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([
        { id: 991, name: "one" },
        { id: 992, name: "two" },
      ]),
      [glTrace(991)]: log("one failed"),
      [glTrace(992)]: log("two failed"),
    });
    await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(calls.map((call) => call.cmd)).toEqual([
      PIPELINES_ARGV,
      JOBS_ARGV,
      ["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/jobs/991/trace"],
      ["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/jobs/992/trace"],
    ]);
  });

  test("AC-7 returns the job name, its web_url and its log excerpt", async () => {
    const text = `${ESC}[31mboom${ESC}[0m\nmore`;
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 991, name: "unit", web_url: "https://gitlab.com/g/p/-/jobs/991" }]),
      [glTrace(991)]: log(text),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks[0]?.name).toBe("unit");
    expect(checks[0]?.url).toBe("https://gitlab.com/g/p/-/jobs/991");
    expect(checks[0]?.excerpt).toBe(forge.ciExcerpt(text));
    expect(checks[0]?.excerpt).toContain("boom");
    expect(checks[0]?.excerpt).not.toContain(ESC);
  });

  test("AC-8 reports an unavailable job log as the first stderr line", async () => {
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 991, name: "unit" }]),
      [glTrace(991)]: { exitCode: 1, stdout: "", stderr: "boom\nmore" },
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe("(log unavailable: boom)");
  });

  test("AC-9 keeps the other checks when one job log cannot be read", async () => {
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([
        { id: 991, name: "one" },
        { id: 992, name: "two" },
      ]),
      [glTrace(991)]: { exitCode: 1, stdout: "", stderr: "boom" },
      [glTrace(992)]: log("two failed"),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks.map((check) => check.name)).toEqual(["one", "two"]);
    expect(checks[0]?.excerpt).toBe("(log unavailable: boom)");
    expect(checks[1]?.excerpt).toBe("two failed");
  });

  test("keeps the first five failed jobs", async () => {
    const jobs = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, name: `job ${index + 1}` }));
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok(jobs),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(forge.MAX_FAILED_CHECKS).toBe(5);
    expect(checks.map((check) => check.name)).toEqual(["job 1", "job 2", "job 3", "job 4", "job 5"]);
  });

  test("omits the url of a job that has none", async () => {
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 991, name: "unit" }]),
      [glTrace(991)]: log("failed"),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks[0]?.url).toBeUndefined();
  });
});

describe("readFailedChecks listing errors", () => {
  test.each([
    ["GitHub", gh, GH_LISTING, GH_LISTING_ARGV],
    ["GitLab", gl, GL_PIPELINES, PIPELINES_ARGV],
  ] as const)("AC-10 throws FORGE_CI_READ_FAILED when the %s listing fails", async (_name, ref, listing, argv) => {
    const { deps, calls } = forgeFixture({ [listing]: { exitCode: 1, stdout: "", stderr: "no such commit" } });
    const promise = forge.readFailedChecks(ref, "abc123", deps, "/repo");
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code: "FORGE_CI_READ_FAILED", context: { stage: "forge" } });
    expect(calls.map((call) => call.cmd)).toEqual([argv]);
  });

  test.each([
    ["GitHub", gh, GH_LISTING, GH_LISTING_ARGV],
    ["GitLab", gl, GL_PIPELINES, PIPELINES_ARGV],
  ] as const)(
    "AC-11 throws FORGE_CI_READ_FAILED when the %s listing is not JSON",
    async (_name, ref, listing, argv) => {
      const { deps, calls } = forgeFixture({ [listing]: { exitCode: 0, stdout: "not JSON", stderr: "" } });
      const promise = forge.readFailedChecks(ref, "abc123", deps, "/repo");
      await expect(promise).rejects.toBeInstanceOf(NaxError);
      await expect(promise).rejects.toMatchObject({ code: "FORGE_CI_READ_FAILED", context: { stage: "forge" } });
      expect(calls.map((call) => call.cmd)).toEqual([argv]);
    },
  );

  test.each([
    ["a failed jobs listing", { exitCode: 1, stdout: "", stderr: "no pipeline" }],
    ["an unparseable jobs listing", { exitCode: 0, stdout: "not JSON", stderr: "" }],
    ["a jobs listing that is not a list", { exitCode: 0, stdout: "{}", stderr: "" }],
  ])("AC-12 throws FORGE_CI_READ_FAILED on %s", async (_case, reply) => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: reply,
    });
    const promise = forge.readFailedChecks(gl, "abc123", deps, "/repo");
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code: "FORGE_CI_READ_FAILED", context: { stage: "forge" } });
    expect(calls.map((call) => call.cmd)).toEqual([PIPELINES_ARGV, JOBS_ARGV]);
  });

  test("throws FORGE_CI_READ_FAILED when the pipelines listing is not a list", async () => {
    const { deps, calls } = forgeFixture({ [GL_PIPELINES]: { exitCode: 0, stdout: "{}", stderr: "" } });
    const promise = forge.readFailedChecks(gl, "abc123", deps, "/repo");
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code: "FORGE_CI_READ_FAILED", context: { stage: "forge" } });
    expect(calls.map((call) => call.cmd)).toEqual([PIPELINES_ARGV]);
  });

  test.each([
    ["no id at all", { sha: "abc123" }],
    ["a non-numeric id", { id: "77", sha: "abc123" }],
  ])("throws FORGE_CI_READ_FAILED when the head's pipeline has %s", async (_case, entry) => {
    const { deps, calls } = forgeFixture({ [GL_PIPELINES]: ok([entry]) });
    const promise = forge.readFailedChecks(gl, "abc123", deps, "/repo");
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code: "FORGE_CI_READ_FAILED", context: { stage: "forge" } });
    // The reply is malformed, so no jobs call is made.
    expect(calls.map((call) => call.cmd)).toEqual([PIPELINES_ARGV]);
  });
});

describe("readFailedChecks log errors", () => {
  test("US-002 AC-11 preserves unavailable Actions logs instead of composing blocks", async () => {
    const { deps } = forgeFixture({
      [GH_LISTING]: ok({
        check_runs: [{ id: 991, name: "build", conclusion: "failure", app: { slug: "github-actions" } }],
      }),
      [ghJobLog(991)]: { exitCode: 1, stdout: "##[error]partial output", stderr: "boom" },
    });
    expect(await forge.readFailedChecks(gh, "abc123", deps, "/repo")).toEqual([
      { name: "build", excerpt: "(log unavailable: boom)", logUnavailable: true, jobId: "991" },
    ]);
  });

  test.each([gh, gl])("US-001 marks unavailable logs on $forge (AC-12/13/15/16)", async (ref) => {
    const { deps } = forgeFixture({
      [GH_LISTING]: ok({
        check_runs: [{ id: 991, name: "build", conclusion: "failure", app: { slug: "github-actions" } }],
      }),
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 991, name: "build" }]),
      [ghJobLog(991)]: { exitCode: 1, stdout: "", stderr: "boom" },
      [glTrace(991)]: { exitCode: 1, stdout: "", stderr: "boom" },
    });
    const checks = await forge.readFailedChecks(ref, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe("(log unavailable: boom)");
    expect(checks[0]).toHaveProperty("logUnavailable", true);
  });

  test("bounds an unavailable log excerpt to the excerpt limit", async () => {
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 991, name: "unit" }]),
      [glTrace(991)]: { exitCode: 1, stdout: "", stderr: "x".repeat(20_000) },
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    const excerpt = checks[0]?.excerpt ?? "";
    expect(excerpt.startsWith("(log unavailable: ")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual("(log unavailable: )".length + forge.CI_EXCERPT_CHARS);
  });

  test("strips the ANSI codes of an unavailable log excerpt", async () => {
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 991, name: "unit" }]),
      [glTrace(991)]: { exitCode: 1, stdout: "", stderr: `${ESC}[31mboom${ESC}[0m\nmore` },
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe("(log unavailable: boom)");
  });

  test("redacts a credential whose closing delimiter crosses the excerpt boundary", async () => {
    // The unavailable excerpt keeps the first CI_EXCERPT_CHARS characters of
    // the line, so the cut lands on the credential's closing '@': without it
    // the URL matcher cannot see the password, and the excerpt would carry it
    // in cleartext.
    const credential = "postgres://alice:synthetic_password_123@db.example";
    const stderr = `${"x".repeat(forge.CI_EXCERPT_CHARS - credential.indexOf("@"))}${credential}`;
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 991, name: "unit" }]),
      [glTrace(991)]: { exitCode: 1, stdout: "", stderr },
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).not.toContain("synthetic_password_123");
    expect(checks[0]?.excerpt).toContain("[REDACTED]");
  });

  test("AC-8 reports an unavailable GitHub job log as the first stderr line", async () => {
    const { deps } = forgeFixture({
      [GH_LISTING]: ok({
        check_runs: [{ id: 991, name: "build", conclusion: "failure", app: { slug: "github-actions" } }],
      }),
      [ghJobLog(991)]: { exitCode: 1, stdout: "", stderr: "boom\nmore" },
    });
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks[0]?.excerpt).toBe("(log unavailable: boom)");
  });

  test("AC-9 keeps the other GitHub checks when one job log cannot be read", async () => {
    const { deps } = forgeFixture({
      [GH_LISTING]: ok({
        check_runs: [
          { id: 991, name: "one", conclusion: "failure", app: { slug: "github-actions" } },
          { id: 992, name: "two", conclusion: "failure", app: { slug: "github-actions" } },
        ],
      }),
      [ghJobLog(991)]: { exitCode: 1, stdout: "", stderr: "boom" },
      [ghJobLog(992)]: log("two failed"),
    });
    const checks = await forge.readFailedChecks(gh, "abc123", deps, "/repo");
    expect(checks.map((check) => check.name)).toEqual(["one", "two"]);
    expect(checks[0]?.excerpt).toBe("(log unavailable: boom)");
    expect(checks[1]?.excerpt).toBe("two failed");
  });
});

/** The argv of the success-jobs read of one sibling pipeline. */
const successArgv = (pipelineId: number): string[] => [
  "glab",
  "api",
  "--hostname",
  "gitlab.com",
  `projects/g%2Fp/pipelines/${pipelineId}/jobs?scope[]=success&per_page=100`,
];

/** The pipeline ids whose success jobs the fixture was asked for, in call order. */
function successReadIds(calls: readonly { readonly cmd: readonly string[] }[]): number[] {
  return calls.flatMap((call) => {
    const match = /pipelines\/(\d+)\/jobs\?scope\[\]=success&per_page=100$/.exec(call.cmd.at(-1) ?? "");
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });
}

/** A fixture of two head pipelines: 77 failed a job, 88 passed one on the same commit. */
function twoHeadPipelines(successReply: FakeReply) {
  return forgeFixture({
    [GL_PIPELINES]: ok([
      { id: 77, sha: "abc123" },
      { id: 88, sha: "abc123" },
    ]),
    [GL_JOBS]: ok([{ id: 501, name: "test" }]),
    [glSuccess(88)]: successReply,
    [glTrace(501)]: log("boom"),
  });
}

describe("readFailedChecks same-head evidence on GitLab", () => {
  test("AC-6 adds the job id and the same-named pass of a sibling pipeline", async () => {
    const { deps } = twoHeadPipelines(ok([{ id: 601, name: "test", web_url: "https://gitlab.com/g/p/-/jobs/601" }]));
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("test");
    expect(checks[0]?.jobId).toBe("501");
    expect(checks[0]?.passedOnSameHead).toEqual({ url: "https://gitlab.com/g/p/-/jobs/601" });
  });

  test("AC-7 reads the success jobs of the sibling pipeline", async () => {
    const { deps, calls } = twoHeadPipelines(ok([{ id: 601, name: "test" }]));
    await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(calls.map((call) => call.cmd)).toContainEqual(successArgv(88));
  });

  test("AC-8 never reads the jobs of a pipeline whose sha is not the head", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([
        { id: 77, sha: "abc123" },
        { id: 12, sha: "other" },
      ]),
      [GL_JOBS]: ok([{ id: 501, name: "test" }]),
      [glTrace(501)]: log("boom"),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks.map((check) => check.jobId)).toEqual(["501"]);
    expect(successReadIds(calls)).toEqual([]);
    expect(calls.map((call) => call.cmd.at(-1))).not.toContain(
      "projects/g%2Fp/pipelines/12/jobs?scope[]=success&per_page=100",
    );
  });

  test("AC-9 reads no success jobs for a single head pipeline and reports no pass", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 501, name: "test" }]),
      [glTrace(501)]: log("boom"),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(successReadIds(calls)).toEqual([]);
    expect(checks[0]?.jobId).toBe("501");
    expect(checks[0]).not.toHaveProperty("passedOnSameHead");
  });

  test("AC-10 resolves with the failed checks when a sibling read exits non-zero", async () => {
    const { deps } = twoHeadPipelines({ exitCode: 1, stdout: "", stderr: "boom" });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.jobId).toBe("501");
    expect(checks[0]).not.toHaveProperty("passedOnSameHead");
  });

  test("AC-11 reports no pass when no sibling success job has the failed job's name", async () => {
    const { deps } = twoHeadPipelines(ok([{ id: 601, name: "lint" }]));
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks[0]?.name).toBe("test");
    expect(checks[0]?.jobId).toBe("501");
    expect(checks[0]).not.toHaveProperty("passedOnSameHead");
  });

  test("AC-12 reads the failed jobs second and the sibling success jobs after them", async () => {
    const { deps, calls } = twoHeadPipelines(ok([{ id: 601, name: "test" }]));
    await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(calls[1]?.cmd).toEqual(JOBS_ARGV);
    expect(calls[2]?.cmd).toEqual(successArgv(88));
  });

  test("AC-13 reads the success jobs of the first three sibling pipelines only", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([
        { id: 77, sha: "abc123" },
        { id: 81, sha: "abc123" },
        { id: 82, sha: "abc123" },
        { id: 83, sha: "abc123" },
        { id: 84, sha: "abc123" },
      ]),
      [GL_JOBS]: ok([{ id: 501, name: "test" }]),
      [glSuccess(81)]: ok([]),
      [glSuccess(82)]: ok([]),
      [glSuccess(83)]: ok([]),
      [glTrace(501)]: log("boom"),
    });
    await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(successReadIds(calls)).toEqual([81, 82, 83]);
  });

  test("AC-14 skips a head pipeline without a numeric id and reads no success jobs", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([{ id: 77, sha: "abc123" }, { sha: "abc123" }]),
      [GL_JOBS]: ok([{ id: 501, name: "test" }]),
      [glTrace(501)]: log("boom"),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks.map((check) => check.jobId)).toEqual(["501"]);
    expect(successReadIds(calls)).toEqual([]);
  });

  test("AC-16 ignores an empty job name on both the failed and the passing job", async () => {
    const { deps } = forgeFixture({
      [GL_PIPELINES]: ok([
        { id: 77, sha: "abc123" },
        { id: 88, sha: "abc123" },
      ]),
      [GL_JOBS]: ok([{ id: 501, name: "" }]),
      [glSuccess(88)]: ok([{ id: 601, name: "", web_url: "https://gitlab.com/g/p/-/jobs/601" }]),
      [glTrace(501)]: log("boom"),
    });
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.jobId).toBe("501");
    expect(checks[0]).not.toHaveProperty("passedOnSameHead");
  });

  test("AC-17 reads no success jobs when the head pipeline has no failed job", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([
        { id: 77, sha: "abc123" },
        { id: 88, sha: "abc123" },
      ]),
      [GL_JOBS]: ok([]),
    });
    expect(await forge.readFailedChecks(gl, "abc123", deps, "/repo")).toEqual([]);
    expect(successReadIds(calls)).toEqual([]);
  });

  test.each([
    ["unparseable JSON", { exitCode: 0, stdout: "not JSON", stderr: "" }],
    ["a non-array JSON value", ok({ id: 601, name: "test" })],
  ])("AC-18 resolves with the failed checks when a sibling reply is %s", async (_case, reply) => {
    const { deps } = twoHeadPipelines(reply);
    const checks = await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("test");
    expect(checks[0]?.jobId).toBe("501");
    expect(checks[0]).not.toHaveProperty("passedOnSameHead");
  });

  test("AC-19 does not let an id-less sibling use up one of the three reads", async () => {
    const { deps, calls } = forgeFixture({
      [GL_PIPELINES]: ok([
        { id: 77, sha: "abc123" },
        { sha: "abc123" },
        { id: 81, sha: "abc123" },
        { id: 82, sha: "abc123" },
        { id: 83, sha: "abc123" },
        { id: 84, sha: "abc123" },
      ]),
      [GL_JOBS]: ok([{ id: 501, name: "test" }]),
      [glSuccess(81)]: ok([]),
      [glSuccess(82)]: ok([]),
      [glSuccess(83)]: ok([]),
      [glTrace(501)]: log("boom"),
    });
    await forge.readFailedChecks(gl, "abc123", deps, "/repo");
    expect(successReadIds(calls)).toEqual([81, 82, 83]);
  });
});

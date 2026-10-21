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

/** The argv of the GitHub listing and of one GitHub Actions job log. */
const GH_LISTING = "gh api --hostname github.com repos/o/r/commits/abc123/check-runs?per_page=100&filter=latest";
const ghJobLog = (jobId: number): string => `gh run view --job ${jobId} --log-failed -R github.com/o/r`;

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
});

describe("readFailedChecks log errors", () => {
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

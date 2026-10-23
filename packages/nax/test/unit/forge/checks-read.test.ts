import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeCheckStatus, ForgeDeps, ForgeRunResult, PrRef } from "@/forge";
import * as forge from "@/forge";

const gh: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 7 };
const gl: PrRef = { forge: "gitlab", host: "gitlab.com", repo: "g/p", number: 7 };
const GH = ["gh", "api", "--hostname", "github.com", "repos/o/r/commits/abc123/check-runs?per_page=100&filter=latest"];
const PIPELINES = ["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/merge_requests/7/pipelines?per_page=20"];
const JOBS = ["glab", "api", "--hostname", "gitlab.com", "projects/g%2Fp/pipelines/9/jobs?per_page=100"];
const ok = (payload: unknown): ForgeRunResult => ({ exitCode: 0, stdout: JSON.stringify(payload), stderr: "" });
const failed: ForgeRunResult = { exitCode: 1, stdout: "", stderr: "denied" };

function fixture(...replies: ForgeRunResult[]) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const deps: ForgeDeps = {
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      return replies[calls.length - 1] ?? failed;
    },
    readText: async () => null,
  };
  return { deps, calls };
}

async function githubCheck(run: Record<string, unknown>) {
  const { deps } = fixture(ok({ check_runs: [{ id: 7, name: "test", ...run }] }));
  return (await forge.listHeadChecks(gh, "abc123", deps, "/repo"))[0];
}

async function expectReadFailure(ref: PrRef, ...replies: ForgeRunResult[]) {
  const { deps } = fixture(...replies);
  const read = forge.listHeadChecks(ref, "abc123", deps, "/repo");
  await expect(read).rejects.toBeInstanceOf(NaxError);
  await expect(read).rejects.toMatchObject({ code: "FORGE_CI_READ_FAILED" });
}

describe("listHeadChecks", () => {
  test("AC-1 reads one GitHub check-runs page with explicit host and cwd", async () => {
    const { deps, calls } = fixture(ok({ check_runs: [] }));
    expect(await forge.listHeadChecks(gh, "abc123", deps, "/repo")).toEqual([]);
    expect(calls).toEqual([{ cmd: GH, cwd: "/repo" }]);
  });
  test("AC-2 normalizes a completed GitHub Actions check", async () => {
    expect(
      await githubCheck({ status: "completed", conclusion: "failure", html_url: "u", app: { slug: "github-actions" } }),
    ).toEqual({
      id: "7",
      name: "test",
      status: "completed",
      conclusion: "failure",
      url: "u",
      hasJobLog: true,
    });
  });
  test.each([
    ["AC-3", "in_progress", "in_progress"],
    ["AC-4", "waiting", "queued"],
    ["AC-5", "stalled", "queued"],
    ["queued", "queued", "queued"],
    ["requested", "requested", "queued"],
    ["pending", "pending", "queued"],
  ] satisfies [string, string, ForgeCheckStatus][])(
    "%s normalizes GitHub %s without a conclusion",
    async (_ac, status, expected) => {
      const check = await githubCheck({ status, conclusion: null });
      expect(check?.status).toBe(expected);
      expect(check).not.toHaveProperty("conclusion");
    },
  );
  test("AC-6 uses unknown for a completed null conclusion", async () => {
    expect(await githubCheck({ status: "completed", conclusion: null })).toMatchObject({ conclusion: "unknown" });
  });
  test("AC-7 marks third-party checks as having no readable job log", async () => {
    expect(await githubCheck({ app: { slug: "external" } })).toMatchObject({ hasJobLog: false });
  });
  test.each([undefined, null, "7"])("AC-8 drops nonnumeric GitHub id %s", async (id) => {
    const { deps } = fixture(ok({ check_runs: [{ id }, null, "invalid"] }));
    expect(await forge.listHeadChecks(gh, "abc123", deps, "/repo")).toEqual([]);
  });
  test("AC-9 preserves the GitHub subprocess error code", async () => {
    await expectReadFailure(gh, failed);
  });
  test("AC-10 reads the first head pipeline's jobs without failure scope", async () => {
    const { deps, calls } = fixture(
      ok([
        { id: 1, sha: "old" },
        { id: 9, sha: "abc123" },
        { id: 10, sha: "abc123" },
      ]),
      ok([]),
    );
    expect(await forge.listHeadChecks(gl, "abc123", deps, "/repo")).toEqual([]);
    expect(calls).toEqual([
      { cmd: PIPELINES, cwd: "/repo" },
      { cmd: JOBS, cwd: "/repo" },
    ]);
  });
  test.each([
    ["AC-11", "running", "in_progress", undefined],
    ["AC-12", "waiting_for_resource", "queued", undefined],
    ["AC-13", "canceled", "completed", "canceled"],
    ["success", "success", "completed", "success"],
    ["failed", "failed", "completed", "failed"],
    ["skipped", "skipped", "completed", "skipped"],
    ...["created", "pending", "preparing", "scheduled", "manual", "stalled"].map(
      (status): [string, string, ForgeCheckStatus, undefined] => [status, status, "queued", undefined],
    ),
  ] satisfies [string, string, ForgeCheckStatus, string | undefined][])(
    "%s normalizes GitLab %s including allowed failures",
    async (_ac, status, expected, conclusion) => {
      const { deps } = fixture(
        ok([{ id: 9, sha: "abc123" }]),
        ok([{ id: 8, name: "job", status, web_url: "u", allow_failure: true }]),
      );
      const checks = await forge.listHeadChecks(gl, "abc123", deps, "/repo");
      expect(checks).toEqual([
        { id: "8", name: "job", status: expected, url: "u", hasJobLog: true, ...(conclusion ? { conclusion } : {}) },
      ]);
      if (!conclusion) expect(checks[0]).not.toHaveProperty("conclusion");
    },
  );
  test("AC-14 returns no checks and makes no jobs call without a head pipeline", async () => {
    const { deps, calls } = fixture(ok([{ id: 9, sha: "old" }]));
    expect(await forge.listHeadChecks(gl, "abc123", deps, "/repo")).toEqual([]);
    expect(calls).toHaveLength(1);
  });
  test("AC-15 preserves the GitLab jobs subprocess error code", async () => {
    await expectReadFailure(gl, ok([{ id: 9, sha: "abc123" }]), failed);
  });
  test.each([ok({}), ok({ check_runs: null }), { exitCode: 0, stdout: "not json", stderr: "" }])(
    "rejects malformed GitHub listings %j",
    async (reply) => {
      await expectReadFailure(gh, reply);
    },
  );
  test.each([ok({}), ok([{ sha: "abc123" }]), { exitCode: 0, stdout: "not json", stderr: "" }, failed])(
    "rejects malformed or failed pipelines %j",
    async (reply) => {
      await expectReadFailure(gl, reply);
    },
  );
  test.each([ok({}), { exitCode: 0, stdout: "not json", stderr: "" }])(
    "rejects malformed GitLab jobs %j",
    async (reply) => {
      await expectReadFailure(gl, ok([{ id: 9, sha: "abc123" }]), reply);
    },
  );
  test("drops GitLab jobs without numeric ids and preserves unnamed jobs", async () => {
    const { deps } = fixture(ok([{ id: 9, sha: "abc123" }]), ok([null, "bad", {}, { id: "8" }, { id: 8 }]));
    expect(await forge.listHeadChecks(gl, "abc123", deps, "/repo")).toEqual([
      { id: "8", name: "", status: "queued", hasJobLog: true },
    ]);
  });
});

import { describe, expect, mock, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import * as forge from "@/forge";

const CWD = "/checkout/nested";
const GH: PrRef = { forge: "github", host: "github.example.com", repo: "acme/widgets", number: 7 };
const GL: PrRef = { forge: "gitlab", host: "gitlab.example.com", repo: "group/proj", number: 9 };
const GITHUB = {
  title: "Fix widgets",
  body: null,
  html_url: "https://github.example.com/acme/widgets/pull/7",
  state: "closed",
  merged_at: "2026-01-01",
  draft: true,
  user: { login: "alice", id: 12 },
  base: { ref: "main", repo: { full_name: "acme/widgets" } },
  head: { ref: "fix", sha: "github-sha", repo: { full_name: "acme/widgets" } },
};
const GITLAB = {
  title: "Fix project",
  description: "Details",
  web_url: "https://gitlab.example.com/group/proj/-/merge_requests/9",
  state: "opened",
  draft: false,
  author: { username: "bob", id: 23 },
  target_branch: "main",
  source_branch: "fix",
  sha: "gitlab-sha",
  diff_refs: { base_sha: "base-sha", start_sha: "start-sha", head_sha: "diff-head-sha" },
  source_project_id: 42,
  target_project_id: 42,
};

function fixture(reply: unknown, exitCode = 0, raw?: string) {
  const run = mock(async (_cmd: string[], _opts: { cwd: string }) => ({
    exitCode,
    stdout: raw ?? JSON.stringify(reply),
    stderr: exitCode ? "permission denied" : "",
  }));
  const deps: ForgeDeps = { run, readText: async () => null };
  return { deps, run };
}

async function expectFailure(ref: PrRef, reply: unknown, options: { code: string; exitCode?: number; raw?: string }) {
  const { code, exitCode = 0, raw } = options;
  const { deps, run } = fixture(reply, exitCode, raw);
  let caught: unknown;
  try {
    await forge.readPrInfo(ref, deps, CWD);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NaxError);
  expect(caught).toMatchObject({ code, context: { stage: "forge" } });
  expect(run).toHaveBeenCalledTimes(1);
}

describe("readPrInfo", () => {
  test.each([
    ["AC-1", GH, GITHUB, ["gh", "api", "--hostname", GH.host, "repos/acme/widgets/pulls/7"]],
    ["AC-10", GL, GITLAB, ["glab", "api", "--hostname", GL.host, "projects/group%2Fproj/merge_requests/9"]],
  ] satisfies [string, PrRef, unknown, string[]][])(
    "%s: uses explicit host, endpoint and cwd",
    async (_ac, ref, reply, argv) => {
      const { deps, run } = fixture(reply);
      await forge.readPrInfo(ref, deps, CWD);
      expect(run.mock.calls).toEqual([[argv, { cwd: CWD }]]);
    },
  );

  test.each([
    ["AC-2", "state", "merged"],
    ["AC-3", "body", ""],
    ["AC-4", "headSha", "github-sha"],
    ["AC-5", "author", { login: "alice", id: 12 }],
  ] satisfies [string, keyof forge.PrInfo, unknown][])("%s: maps GitHub %s", async (_ac, key, value) => {
    const { deps } = fixture(GITHUB);
    expect((await forge.readPrInfo(GH, deps, CWD))[key]).toEqual(value);
  });

  test.each([
    ["AC-6", { ...GITHUB.head, repo: null }, GITHUB.base, true],
    ["AC-7", { ...GITHUB.head, repo: { full_name: "fork/widgets" } }, GITHUB.base, true],
    ["AC-8", GITHUB.head, GITHUB.base, false],
    ["AC-9", GITHUB.head, { ref: "main" }, true],
    ["empty names", { ...GITHUB.head, repo: { full_name: "" } }, { ...GITHUB.base, repo: { full_name: "" } }, true],
    [
      "non-string names",
      { ...GITHUB.head, repo: { full_name: 42 } },
      { ...GITHUB.base, repo: { full_name: 42 } },
      true,
    ],
  ])("%s: fails closed for GitHub repository identity", async (_ac, head, base, crossRepo) => {
    const { deps } = fixture({ ...GITHUB, head, base });
    expect((await forge.readPrInfo(GH, deps, CWD)).crossRepo).toBe(crossRepo);
  });

  test.each([
    ["AC-11", "state", "open"],
    ["AC-12", "headSha", "gitlab-sha"],
    ["AC-13/AC-14", "diffRefs", { baseSha: "base-sha", startSha: "start-sha", headSha: "diff-head-sha" }],
  ] satisfies [string, keyof forge.PrInfo, unknown][])("%s: maps GitLab %s", async (_ac, key, value) => {
    const { deps } = fixture(GITLAB);
    expect((await forge.readPrInfo(GL, deps, CWD))[key]).toEqual(value);
  });

  test.each([
    ["AC-15", 41, 42, true],
    ["AC-16", 42, 42, false],
    ["AC-17", undefined, undefined, true],
    ["string ids", "42", "42", true],
    ["missing source", undefined, 42, true],
    ["missing target", 42, undefined, true],
    ["null ids", null, null, true],
  ])("%s: fails closed for GitLab project identity", async (_ac, source_project_id, target_project_id, crossRepo) => {
    const { deps } = fixture({ ...GITLAB, source_project_id, target_project_id });
    expect((await forge.readPrInfo(GL, deps, CWD)).crossRepo).toBe(crossRepo);
  });

  test.each([GH, GL])("AC-18: rejects command failure on $forge", async (ref) => {
    await expectFailure(ref, {}, { code: "FORGE_PR_READ_FAILED", exitCode: 1 });
  });
  test.each([GH, GL])("AC-19: rejects invalid JSON on $forge", async (ref) => {
    await expectFailure(ref, {}, { code: "FORGE_RESPONSE_UNPARSEABLE", raw: "not json" });
  });
  test("AC-20: rejects GitHub without head.sha", async () => {
    await expectFailure(GH, { ...GITHUB, head: { ref: "fix" } }, { code: "FORGE_RESPONSE_UNPARSEABLE" });
  });
  test.each([undefined, null, "", 42])("rejects missing or invalid GitLab sha %s", async (sha) => {
    await expectFailure(GL, { ...GITLAB, sha }, { code: "FORGE_RESPONSE_UNPARSEABLE" });
  });
  test.each([null, [], 42, {}])("rejects malformed GitHub reply %j", async (reply) => {
    await expectFailure(GH, reply, { code: "FORGE_RESPONSE_UNPARSEABLE" });
  });

  test("maps all remaining GitHub metadata and keeps the reference number", async () => {
    const { deps } = fixture({ ...GITHUB, number: 999, merged_at: null, state: "open", body: "Description" });
    expect(await forge.readPrInfo(GH, deps, CWD)).toEqual({
      number: 7,
      title: GITHUB.title,
      body: "Description",
      url: GITHUB.html_url,
      state: "open",
      draft: true,
      author: { login: "alice", id: 12 },
      baseRef: "main",
      headRef: "fix",
      headSha: "github-sha",
      crossRepo: false,
    });
  });
  test.each(["merged", "closed", "locked"])("maps GitLab state %s and remaining metadata", async (state) => {
    const { deps } = fixture({ ...GITLAB, state, description: null, diff_refs: undefined });
    expect(await forge.readPrInfo(GL, deps, CWD)).toEqual({
      number: 9,
      title: GITLAB.title,
      body: "",
      url: GITLAB.web_url,
      state: state === "merged" ? "merged" : "closed",
      draft: false,
      author: { login: "bob", id: 23 },
      baseRef: "main",
      headRef: "fix",
      headSha: "gitlab-sha",
      crossRepo: false,
    });
  });
});

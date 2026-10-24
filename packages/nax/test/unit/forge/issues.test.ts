import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeRunResult, PrRef } from "@/forge";
import * as forge from "@/forge";
import * as logging from "@/logger";

const gh: PrRef = { forge: "github", host: "github.corp", repo: "acme/widgets", number: 99 };
const gl: PrRef = { forge: "gitlab", host: "gitlab.corp", repo: "group/sub/proj", number: 99 };
const ok = (reply: unknown): ForgeRunResult => ({ exitCode: 0, stdout: JSON.stringify(reply), stderr: "" });
const failed: ForgeRunResult = { exitCode: 1, stdout: "", stderr: "not found" };
function fixture(...replies: (ForgeRunResult | Error)[]) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const deps: ForgeDeps = {
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (!reply) throw new TypeError("Unexpected forge call");
      return reply;
    },
    readText: async () => null,
  };
  return { deps, calls };
}

describe("parseClosingRefs", () => {
  test.each([
    ["AC-1", "Closes #12 and fixes #7", [12, 7]],
    ["AC-2", "RESOLVED: #3", [3]],
    ["AC-3", "closes owner/repo#9", []],
    ["AC-4", "see #4", []],
    ["AC-5", "prefixes #3", []],
    ["AC-6", "<!-- Fixes #123 -->\nCloses #8", [8]],
    ["AC-7", "fixes #5, fixes #5", [5]],
    ["multiline comments", "<!--\ncloses #1\n--> fixes #2 <!-- fixes #3 -->", [2]],
    ["requires whitespace", "fixes#1 resolve:#2", []],
    ["whole keywords", "unresolved #1 closedness #2", []],
  ] as const)("%s parses same-repo closing references", (_ac, body, expected) => {
    expect(forge.parseClosingRefs(body)).toEqual([...expected]);
  });
  test("AC-8 caps distinct numbers at five in first-seen order", () => {
    expect(forge.MAX_LINKED_ISSUES).toBe(5);
    expect(
      forge.parseClosingRefs("fixes #9 fixes #9 closes #2 closes #8 fixes #4 resolves #6 fixes #1 fixes #3"),
    ).toEqual([9, 2, 8, 4, 6]);
  });
  test.each(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"])(
    "accepts keyword %s case-insensitively",
    (keyword) => {
      expect(forge.parseClosingRefs(`${keyword.toUpperCase()}: \n#12`)).toEqual([12]);
    },
  );
});

describe("readIssue", () => {
  test.each([true, false])("US-008 AC-1/2 GitLab confidential=%s", async (confidential) => {
    const { deps } = fixture(ok({ title: "Leak", description: "secret", confidential }));
    expect(await forge.readIssue(gl, 1, deps, "/repo")).toEqual(
      confidential ? null : { number: 1, title: "Leak", body: "secret" },
    );
  });
  test.each([
    ["AC-9 AC-10", gh, { title: "Crash", body: "Steps" }, "gh", "repos/acme/widgets/issues/12"],
    [
      "AC-11 AC-12",
      gl,
      { title: "Crash", description: "Steps", body: "wrong" },
      "glab",
      "projects/group%2Fsub%2Fproj/issues/12",
    ],
  ] as const)("%s reads explicit host, repo, number and cwd", async (_ac, ref, reply, cli, endpoint) => {
    const { deps, calls } = fixture(ok(reply));
    expect(await forge.readIssue(ref, 12, deps, "/repo")).toEqual({ number: 12, title: "Crash", body: "Steps" });
    expect(calls).toEqual([{ cmd: [cli, "api", "--hostname", ref.host, endpoint], cwd: "/repo" }]);
  });
  test.each([gh, gl])("AC-13 normalizes null body/description for %s", async (ref) => {
    expect(
      await forge.readIssue(ref, 12, fixture(ok({ title: "Title", body: null, description: null })).deps, "/repo"),
    ).toEqual({ number: 12, title: "Title", body: "" });
  });
  test("AC-14 ignores GitHub PRs even with a null pull_request value", async () => {
    expect(await forge.readIssue(gh, 12, fixture(ok({ pull_request: null })).deps, "/repo")).toBeNull();
  });
  test.each([
    ["AC-15", failed, "FORGE_ISSUE_READ_FAILED"],
    ["AC-16", { exitCode: 0, stdout: "not JSON", stderr: "" }, "FORGE_RESPONSE_UNPARSEABLE"],
    ["null", ok(null), "FORGE_RESPONSE_UNPARSEABLE"],
    ["array", ok([]), "FORGE_RESPONSE_UNPARSEABLE"],
    ["primitive", ok("hello"), "FORGE_RESPONSE_UNPARSEABLE"],
    ["missing title", ok({ body: "Body" }), "FORGE_RESPONSE_UNPARSEABLE"],
    ["invalid body", ok({ title: "Title", body: 42 }), "FORGE_RESPONSE_UNPARSEABLE"],
  ] as const)("%s throws a contextual NaxError", async (_ac, reply, code) => {
    const promise = forge.readIssue(gh, 12, fixture(reply).deps, "/repo");
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code, context: { stage: "forge" } });
  });
  test("wraps dependency rejection with its cause", async () => {
    const cause = new TypeError("spawn failed");
    await expect(forge.readIssue(gh, 12, fixture(cause).deps, "/repo")).rejects.toMatchObject({
      code: "FORGE_ISSUE_READ_FAILED",
      context: { stage: "forge", cause },
    });
  });
});

describe("readLinkedIssues", () => {
  afterEach(() => {
    spyOnGetLogger?.mockRestore();
    spyOnGetLogger = undefined;
  });
  let spyOnGetLogger: ReturnType<typeof spyOn<typeof logging, "getLogger">> | undefined;
  function captureWarnings() {
    const logger = makeLogger();
    spyOnGetLogger = spyOn(logging, "getLogger").mockReturnValue(logger);
    return logger.calls;
  }
  test("US-008 AC-3 returns only public linked issues", async () => {
    const { deps } = fixture(
      ok({ title: "Leak", description: "secret", confidential: true }),
      ok({ title: "Public", description: "intent", confidential: false }),
    );
    expect(await forge.readLinkedIssues(gl, "Closes #1, closes #2", deps, "/repo")).toEqual([
      { number: 2, title: "Public", body: "intent" },
    ]);
  });
  test("US-008 AC-3/4 skips confidential intent and warns with its number", async () => {
    const warnings = captureWarnings();
    const { deps } = fixture(
      ok({ title: "Leak", description: "secret", confidential: true }),
      ok({ title: "Public", description: "intent", confidential: false }),
    );
    const issues = await forge.readLinkedIssues(gl, "Closes #1, closes #2", deps, "/repo");
    expect(warnings).toEqual([
      expect.objectContaining({
        level: "warn",
        stage: "forge",
        message: "Skipping linked reference: a pull request or a confidential issue",
        data: { host: gl.host, repo: gl.repo, number: 1 },
      }),
    ]);
    expect(issues).toEqual([{ number: 2, title: "Public", body: "intent" }]);
  });
  test("AC-17 AC-20 warns on failed issue and continues in reference order", async () => {
    const warnings = captureWarnings();
    const { deps, calls } = fixture(failed, ok({ title: "Second", body: "Intent" }));
    expect(await forge.readLinkedIssues(gh, "Closes #1, closes #2", deps, "/repo")).toEqual([
      { number: 2, title: "Second", body: "Intent" },
    ]);
    expect(calls.map((call) => call.cmd[4])).toEqual(["repos/acme/widgets/issues/1", "repos/acme/widgets/issues/2"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", stage: "forge", data: { number: 1, repo: gh.repo } });
  });
  test("AC-18 warns and skips a PR number", async () => {
    const warnings = captureWarnings();
    expect(await forge.readLinkedIssues(gh, "Fixes #3", fixture(ok({ pull_request: {} })).deps, "/repo")).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", stage: "forge", data: { number: 3 } });
  });
  test("AC-19 does not call forge without closing references", async () => {
    const { deps, calls } = fixture();
    expect(await forge.readLinkedIssues(gh, "See #4", deps, "/repo")).toEqual([]);
    expect(calls).toEqual([]);
  });
  test("continues after dependency rejection and malformed JSON on GitLab", async () => {
    captureWarnings();
    const { deps } = fixture(new TypeError("offline"), ok(null), ok({ title: "Third", description: "Intent" }));
    expect(await forge.readLinkedIssues(gl, "Fixes #1 fixes #2 fixes #3", deps, "/repo")).toEqual([
      { number: 3, title: "Third", body: "Intent" },
    ]);
  });
});

test("linked issue reads start concurrently, are capped, and preserve reference order", async () => {
  const pending: Array<(result: ForgeRunResult) => void> = [];
  const deps: ForgeDeps = { run: () => new Promise((resolve) => pending.push(resolve)), readText: async () => null };
  const result = forge.readLinkedIssues(gh, "Fixes #1 fixes #2 fixes #3 fixes #4 fixes #5 fixes #6", deps, "/repo");
  expect(pending).toHaveLength(5);
  for (let i = pending.length - 1; i >= 0; i--) pending[i]?.(ok({ title: `issue ${i + 1}`, body: "" }));
  expect((await result).map((issue) => issue.number)).toEqual([1, 2, 3, 4, 5]);
});

test("unterminated template comments hide closing refs", () => {
  expect(forge.parseClosingRefs("Closes #2 <!-- Fixes #1")).toEqual([2]);
});

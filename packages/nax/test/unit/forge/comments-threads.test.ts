import { describe, expect, mock, test } from "bun:test";
import type { ForgeDeps, ForgeRunResult, PrRef } from "@/forge";
import * as forge from "@/forge";

const github: PrRef = { forge: "github", host: "github.corp", repo: "acme/widgets", number: 7 };
const gitlab: PrRef = { forge: "gitlab", host: "gitlab.corp", repo: "group/sub/proj", number: 8 };
const cwd = "/repo";
function harness(result: Partial<ForgeRunResult> = {}) {
  const run = mock(async (_argv: string[], _opts: { cwd: string }) => ({
    exitCode: 0,
    stdout: '{"id":42,"html_url":"https://forge/comment/42"}',
    stderr: "",
    ...result,
  }));
  const deps: ForgeDeps = { run, readText: async () => null };
  return { run, deps };
}
const writeFailure = {
  code: "FORGE_COMMENT_WRITE_FAILED",
  context: { stage: "forge", exitCode: 1, stderr: "HTTP 403" },
};
const invalidId = { code: "FORGE_ID_INVALID", context: { stage: "forge" } };

describe("replyToThread", () => {
  test.each([
    ["AC-1", github, "991", "repos/acme/widgets/pulls/7/comments/991/replies", "gh"],
    ["AC-3", gitlab, "d1", "projects/group%2Fsub%2Fproj/merge_requests/8/discussions/d1/notes", "glab"],
  ] as const)("%s: posts a raw reply with explicit host and cwd", async (_ac, ref, replyTo, endpoint, cli) => {
    const { run, deps } = harness();
    expect(await forge.replyToThread(ref, { replyTo }, "@/etc/passwd", deps, cwd)).toEqual({
      id: "42",
      url: "https://forge/comment/42",
    });
    expect(run.mock.calls).toEqual([
      [[cli, "api", "--hostname", ref.host, "-X", "POST", endpoint, "-f", "body=@/etc/passwd"], { cwd }],
    ]);
  });
  test.each([
    ["AC-2", github, "12/../x"],
    ["AC-4", gitlab, "d1/../x"],
    ["empty", github, ""],
    ["newline", github, "991\n"],
    ["long", gitlab, "d".repeat(65)],
  ] as const)("%s: rejects invalid reply id", async (_ac, ref, replyTo) => {
    const { run, deps } = harness();
    await expect(forge.replyToThread(ref, { replyTo }, "reply", deps, cwd)).rejects.toMatchObject(invalidId);
    expect(run).not.toHaveBeenCalled();
  });
  test.each([github, gitlab])("AC-5: write failure is not retried on %s", async (ref) => {
    const { run, deps } = harness({ exitCode: 1, stderr: " HTTP 403\n" });
    await expect(forge.replyToThread(ref, { replyTo: "991" }, "reply", deps, cwd)).rejects.toMatchObject({
      ...writeFailure,
      context: { ...writeFailure.context, forge: ref.forge },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
  test.each(["", " \t\n", "x".repeat(65_537)])("rejects empty/oversized reply body %#", async (body) => {
    const { run, deps } = harness();
    await expect(forge.replyToThread(github, { replyTo: "991" }, body, deps, cwd)).rejects.toMatchObject({
      code: body.length > 65_536 ? "FORGE_COMMENT_TOO_LONG" : "FORGE_COMMENT_EMPTY",
      context: { stage: "forge" },
    });
    expect(run).not.toHaveBeenCalled();
  });
  test.each(["not json", "{}", "null", '{"id":null}'])("rejects malformed reply %s", async (stdout) => {
    const { deps } = harness({ stdout });
    await expect(forge.replyToThread(github, { replyTo: "991" }, "reply", deps, cwd)).rejects.toMatchObject({
      code: "FORGE_RESPONSE_UNPARSEABLE",
      context: { stage: "forge" },
    });
  });
});

describe("resolveThread", () => {
  test("AC-6/AC-7: GitHub resolves via GraphQL using a raw node id variable", async () => {
    const { run, deps } = harness();
    expect(await forge.resolveThread(github, { id: "PRRT_node/@id" }, deps, cwd)).toBeUndefined();
    const argv = run.mock.calls[0]?.[0] ?? [];
    expect(argv.slice(0, 6)).toEqual(["gh", "api", "--hostname", github.host, "graphql", "-f"]);
    expect(argv[6]).toContain("resolveReviewThread(input: {threadId: $id})");
    expect(argv[6]).toContain("$id: ID!");
    expect(argv.slice(7)).toEqual(["-f", "id=PRRT_node/@id"]);
    expect(run.mock.calls[0]?.[1]).toEqual({ cwd });
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("AC-8: GitLab resolves a discussion with raw resolved=true", async () => {
    const { run, deps } = harness();
    expect(await forge.resolveThread(gitlab, { id: "d1" }, deps, cwd)).toBeUndefined();
    expect(run.mock.calls).toEqual([
      [
        [
          "glab",
          "api",
          "--hostname",
          gitlab.host,
          "-X",
          "PUT",
          "projects/group%2Fsub%2Fproj/merge_requests/8/discussions/d1",
          "-f",
          "resolved=true",
        ],
        { cwd },
      ],
    ]);
  });
  test.each(["a b", "", "d1/../x", "d".repeat(65), "d1\n"])("AC-9: rejects invalid discussion id %j", async (id) => {
    const { run, deps } = harness();
    await expect(forge.resolveThread(gitlab, { id }, deps, cwd)).rejects.toMatchObject(invalidId);
    expect(run).not.toHaveBeenCalled();
  });
  test.each([github, gitlab])("AC-10: resolve failure is not retried on %s", async (ref) => {
    const { run, deps } = harness({ exitCode: 1, stderr: " HTTP 403\n" });
    await expect(forge.resolveThread(ref, { id: "d1" }, deps, cwd)).rejects.toMatchObject(writeFailure);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("editComment", () => {
  test.each([
    ["AC-11", github, "comment", "repos/acme/widgets/issues/comments/42", "gh", "PATCH"],
    ["AC-12", github, "thread", "repos/acme/widgets/pulls/comments/42", "gh", "PATCH"],
    ["AC-16", gitlab, "thread", "projects/group%2Fsub%2Fproj/merge_requests/8/notes/42", "glab", "PUT"],
  ] as const)("%s: edits with the proper endpoint and raw body", async (_ac, ref, kind, endpoint, cli, method) => {
    const { run, deps } = harness();
    expect(await forge.editComment(ref, { id: "42", kind }, "@/etc/passwd", deps, cwd)).toBeUndefined();
    expect(run.mock.calls).toEqual([
      [[cli, "api", "--hostname", ref.host, "-X", method, endpoint, "-f", "body=@/etc/passwd"], { cwd }],
    ]);
  });
  test("AC-13: edits the database id returned by the real thread reader", async () => {
    const { run, deps } = harness();
    run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRRT_thread",
                    isResolved: false,
                    isOutdated: false,
                    comments: {
                      nodes: [{ databaseId: 991, body: "review", author: { login: "bot" }, createdAt: "today" }],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    });
    const threads = await forge.listReviewThreads(github, deps, cwd);
    const comment = threads[0]?.comments[0];
    expect(comment).toMatchObject({ id: "991", kind: "thread" });
    if (!comment) throw new Error("Expected reader comment");
    await forge.editComment(github, comment, "edited", deps, cwd);
    expect(run.mock.calls[1]?.[0]).toEqual([
      "gh",
      "api",
      "--hostname",
      github.host,
      "-X",
      "PATCH",
      "repos/acme/widgets/pulls/comments/991",
      "-f",
      "body=edited",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });
  test("AC-14: rejects GitHub review edits before I/O", async () => {
    const { run, deps } = harness();
    await expect(forge.editComment(github, { id: "42", kind: "review" }, "edit", deps, cwd)).rejects.toMatchObject({
      code: "FORGE_EDIT_UNSUPPORTED",
      context: { stage: "forge" },
    });
    expect(run).not.toHaveBeenCalled();
  });
  test.each([
    ["AC-15", github, "abc"],
    ["AC-17", gitlab, "12x"],
    ["traversal", github, "12/../x"],
    ["newline", gitlab, "42\n"],
  ] as const)("%s: rejects invalid comment id", async (_ac, ref, id) => {
    const { run, deps } = harness();
    await expect(forge.editComment(ref, { id, kind: "thread" }, "edit", deps, cwd)).rejects.toMatchObject(invalidId);
    expect(run).not.toHaveBeenCalled();
  });
  test.each(["x".repeat(65_537), "😀".repeat(32_769), "", " \n"])(
    "AC-18: guards edit body %# before I/O",
    async (body) => {
      const { run, deps } = harness();
      await expect(forge.editComment(github, { id: "42", kind: "thread" }, body, deps, cwd)).rejects.toMatchObject({
        code: body.length > 65_536 ? "FORGE_COMMENT_TOO_LONG" : "FORGE_COMMENT_EMPTY",
        context: { stage: "forge" },
      });
      expect(run).not.toHaveBeenCalled();
    },
  );
  test.each([github, gitlab])("AC-19: edit failure is not retried on %s", async (ref) => {
    const { run, deps } = harness({ exitCode: 1, stderr: " HTTP 403\n" });
    await expect(forge.editComment(ref, { id: "42", kind: "thread" }, "edit", deps, cwd)).rejects.toMatchObject(
      writeFailure,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

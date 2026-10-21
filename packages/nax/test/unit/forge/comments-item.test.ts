import { describe, expect, mock, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import * as forge from "@/forge";

const gh: PrRef = { forge: "github", host: "github.corp", repo: "acme/widgets", number: 7 };
const gl: PrRef = { forge: "gitlab", host: "gitlab.corp", repo: "group/sub/proj", number: 7 };
const input = { path: "src/item.ts", body: "@literal\nitem", headSha: "abc123" };
function fixture(stdout: string, exitCode = 0) {
  const run = mock(async (_cmd: string[], _opts: { cwd: string }) => ({ stdout, exitCode, stderr: "denied" }));
  const deps: ForgeDeps = { run, readText: async () => null };
  return { deps, run };
}

describe("postItemComment", () => {
  test("AC-13 AC-14 GitHub posts a file comment without a line", async () => {
    const { deps, run } = fixture('{"id":42,"html_url":"https://comment"}');
    expect(await forge.postItemComment(gh, input, deps, "/repo")).toEqual({ id: "42", url: "https://comment" });
    expect(run.mock.calls).toEqual([
      [
        [
          "gh",
          "api",
          "--hostname",
          gh.host,
          "-X",
          "POST",
          "repos/acme/widgets/pulls/7/comments",
          "-f",
          `body=${input.body}`,
          "-f",
          "commit_id=abc123",
          "-f",
          "path=src/item.ts",
          "-f",
          "subject_type=file",
        ],
        { cwd: "/repo" },
      ],
    ]);
    expect(run.mock.calls[0]?.[0].some((arg) => arg.startsWith("line="))).toBe(false);
  });
  test("AC-15 AC-16 GitLab opens a positionless discussion and returns threadId", async () => {
    const { deps, run } = fixture('{"id":"discussion-1","notes":[{"id":81}]}');
    expect(await forge.postItemComment(gl, input, deps, "/repo")).toEqual({ id: "81", threadId: "discussion-1" });
    expect(run.mock.calls).toEqual([
      [
        [
          "glab",
          "api",
          "--hostname",
          gl.host,
          "-X",
          "POST",
          "projects/group%2Fsub%2Fproj/merge_requests/7/discussions",
          "-f",
          `body=${input.body}`,
        ],
        { cwd: "/repo" },
      ],
    ]);
    expect(run.mock.calls[0]?.[0].some((arg) => arg.includes("position"))).toBe(false);
  });
  test.each([gh, gl])("AC-17 $forge rejects oversized body before writing", async (ref) => {
    const { deps, run } = fixture("{}");
    const pending = forge.postItemComment(
      ref,
      { ...input, body: "x".repeat(forge.MAX_FORGE_COMMENT_CHARS + 1) },
      deps,
      "/repo",
    );
    await expect(pending).rejects.toBeInstanceOf(NaxError);
    await expect(pending).rejects.toMatchObject({ code: "FORGE_COMMENT_TOO_LONG" });
    expect(run).not.toHaveBeenCalled();
  });
  test.each([gh, gl])("$forge rejects blank body before writing", async (ref) => {
    const { deps, run } = fixture("{}");
    await expect(forge.postItemComment(ref, { ...input, body: " " }, deps, "/repo")).rejects.toMatchObject({
      code: "FORGE_COMMENT_EMPTY",
    });
    expect(run).not.toHaveBeenCalled();
  });
  test.each([gh, gl])("$forge write failure is not retried", async (ref) => {
    const { deps, run } = fixture("{}", 1);
    await expect(forge.postItemComment(ref, input, deps, "/repo")).rejects.toMatchObject({
      code: "FORGE_COMMENT_WRITE_FAILED",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
  test.each([
    [gh, "not JSON"],
    [gh, "{}"],
    [gl, '{"id":"d","notes":[]}'],
  ] as const)("rejects malformed write reply %#", async (ref, stdout) => {
    await expect(forge.postItemComment(ref, input, fixture(stdout).deps, "/repo")).rejects.toMatchObject({
      code: "FORGE_RESPONSE_UNPARSEABLE",
    });
  });
});

import { describe, expect, mock, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeRunResult, PrRef } from "@/forge";
import * as forge from "@/forge";

const github: PrRef = { forge: "github", host: "github.corp", repo: "acme/widgets", number: 7 };
const gitlab: PrRef = { forge: "gitlab", host: "gitlab.corp", repo: "group/sub/proj", number: 8 };
const input = {
  path: "@src/a & b?#雪.ts",
  line: 5,
  body: "@/etc/passwd\n inline",
  headSha: "commit-sha",
  diffRefs: { baseSha: "base", startSha: "start", headSha: "diff-head" },
};

function fakeDeps(result: Partial<ForgeRunResult> = {}) {
  const run = mock(async (_cmd: string[], _opts: { cwd: string }) => ({
    exitCode: 0,
    stdout: '{"id":42,"html_url":"https://github.corp/comment/42"}',
    stderr: "",
    ...result,
  }));
  const deps: ForgeDeps = { run, readText: async () => null };
  return { deps, run };
}

async function expectError(action: () => Promise<unknown>, code: string): Promise<NaxError> {
  const error = await action().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(NaxError);
  if (!(error instanceof NaxError)) throw new Error("Expected a NaxError rejection");
  expect(error.code).toBe(code);
  expect(error.context?.stage).toBe("forge");
  return error;
}

describe("postInlineComment", () => {
  test("AC-1/2/3/4: GitHub raw strings, integer line, RIGHT side and id/url", async () => {
    const { deps, run } = fakeDeps();
    expect(await forge.postInlineComment(github, input, deps, "/repo")).toEqual({
      id: "42",
      url: "https://github.corp/comment/42",
    });
    expect(run.mock.calls).toEqual([
      [
        [
          "gh",
          "api",
          "--hostname",
          "github.corp",
          "-X",
          "POST",
          "repos/acme/widgets/pulls/7/comments",
          "-f",
          `body=${input.body}`,
          "-f",
          "commit_id=commit-sha",
          "-f",
          `path=${input.path}`,
          "-F",
          "line=5",
          "-f",
          "side=RIGHT",
        ],
        { cwd: "/repo" },
      ],
    ]);
  });

  test("AC-5/6/7/8/9/10/11/12: GitLab query position, raw body only, note/thread ids", async () => {
    const { deps, run } = fakeDeps({ stdout: '{"id":"discussion-1","notes":[{"id":93},{"id":94}]}' });
    expect(await forge.postInlineComment(gitlab, input, deps, "/repo")).toEqual({ id: "93", threadId: "discussion-1" });
    expect(run).toHaveBeenCalledTimes(1);
    const [argv, opts] = run.mock.calls[0] ?? [[], undefined];
    expect(opts).toEqual({ cwd: "/repo" });
    expect(argv.slice(0, 6)).toEqual(["glab", "api", "--hostname", "gitlab.corp", "-X", "POST"]);
    const endpoint = argv[6] ?? "";
    expect(endpoint).toStartWith("projects/group%2Fsub%2Fproj/merge_requests/8/discussions?");
    const query = new URLSearchParams(endpoint.slice(endpoint.indexOf("?") + 1));
    expect(Object.fromEntries(query)).toEqual({
      "position[position_type]": "text",
      "position[base_sha]": "base",
      "position[start_sha]": "start",
      "position[head_sha]": "diff-head",
      "position[old_path]": input.path,
      "position[new_path]": input.path,
      "position[new_line]": "5",
    });
    expect(argv.slice(7)).toEqual(["-f", `body=${input.body}`]);
  });

  test("AC-13: missing GitLab diffRefs rejects before running", async () => {
    const { deps, run } = fakeDeps();
    await expectError(
      () => forge.postInlineComment(gitlab, { ...input, diffRefs: undefined }, deps, "/repo"),
      "FORGE_DIFF_REFS_REQUIRED",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "AC-14: invalid line %s rejects before running",
    async (line) => {
      const { deps, run } = fakeDeps();
      await expectError(
        () => forge.postInlineComment(github, { ...input, line }, deps, "/repo"),
        "FORGE_COMMENT_TARGET_INVALID",
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("AC-15: empty path rejects before running", async () => {
    const { deps, run } = fakeDeps();
    await expectError(
      () => forge.postInlineComment(github, { ...input, path: "" }, deps, "/repo"),
      "FORGE_COMMENT_TARGET_INVALID",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test.each([github, gitlab])("AC-16: %s rejects whitespace before running", async (ref) => {
    const { deps, run } = fakeDeps();
    await expectError(
      () => forge.postInlineComment(ref, { ...input, body: "   " }, deps, "/repo"),
      "FORGE_COMMENT_EMPTY",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test.each([github, gitlab])("AC-17: %s shared write failure without retry", async (ref) => {
    const { deps, run } = fakeDeps({ exitCode: 1, stdout: "not JSON", stderr: " HTTP 403\n" });
    const error = await expectError(
      () => forge.postInlineComment(ref, input, deps, "/repo"),
      "FORGE_COMMENT_WRITE_FAILED",
    );
    expect(error.context).toMatchObject({ stage: "forge", forge: ref.forge, exitCode: 1, stderr: "HTTP 403" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test.each([github, gitlab])("%s enforces shared UTF-16 limit before running", async (ref) => {
    const { deps, run } = fakeDeps();
    await expectError(
      () => forge.postInlineComment(ref, { ...input, body: "😀".repeat(32_769) }, deps, "/repo"),
      "FORGE_COMMENT_TOO_LONG",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test.each(["not JSON", "null", "{}", '{"id":null}', '{"id":"thread","notes":[]}'])(
    "rejects malformed GitLab reply %s",
    async (stdout) => {
      const { deps, run } = fakeDeps({ stdout });
      await expectError(() => forge.postInlineComment(gitlab, input, deps, "/repo"), "FORGE_RESPONSE_UNPARSEABLE");
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
});

import { describe, expect, mock, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeRunResult, PrRef } from "@/forge";
import * as forge from "@/forge";

const github: PrRef = { forge: "github", host: "github.corp", repo: "acme/widgets", number: 7 };
const gitlab: PrRef = { forge: "gitlab", host: "gitlab.corp", repo: "group/sub/proj", number: 8 };

function fakeDeps(result: Partial<ForgeRunResult> = {}) {
  const run = mock(async (_cmd: string[], _opts: { cwd: string }) => ({
    exitCode: 0,
    stdout: '{"id":42}',
    stderr: "",
    ...result,
  }));
  const deps: ForgeDeps = { run, readText: async () => null };
  return { deps, run };
}

async function postError(ref: PrRef, body: string, deps: ForgeDeps): Promise<NaxError> {
  const error = await forge.postPrComment(ref, body, deps, "/repo").catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(NaxError);
  if (!(error instanceof NaxError)) throw new Error("Expected a NaxError rejection");
  return error;
}

describe("postPrComment", () => {
  test("AC-1: posts to GitHub with explicit host, endpoint, raw body and cwd", async () => {
    const { deps, run } = fakeDeps();
    await forge.postPrComment(github, " summary\n", deps, "/repo");
    expect(run.mock.calls).toEqual([
      [
        [
          "gh",
          "api",
          "--hostname",
          "github.corp",
          "-X",
          "POST",
          "repos/acme/widgets/issues/7/comments",
          "-f",
          "body= summary\n",
        ],
        { cwd: "/repo" },
      ],
    ]);
  });

  test("AC-2: returns the GitHub id as a string and its html URL", async () => {
    const { deps } = fakeDeps({ stdout: '{"id":42,"html_url":"https://github.corp/comment/42"}' });
    expect(await forge.postPrComment(github, "summary", deps, "/repo")).toEqual({
      id: "42",
      url: "https://github.corp/comment/42",
    });
  });

  test("AC-3: posts to the encoded GitLab project and returns its note id", async () => {
    const { deps, run } = fakeDeps();
    expect(await forge.postPrComment(gitlab, "summary", deps, "/repo")).toEqual({ id: "42" });
    expect(run.mock.calls).toEqual([
      [
        [
          "glab",
          "api",
          "--hostname",
          "gitlab.corp",
          "-X",
          "POST",
          "projects/group%2Fsub%2Fproj/merge_requests/8/notes",
          "-f",
          "body=summary",
        ],
        { cwd: "/repo" },
      ],
    ]);
  });

  test.each([github, gitlab])("AC-4/AC-5: %s posts @ text literally without file upload flags", async (ref) => {
    const { deps, run } = fakeDeps();
    await forge.postPrComment(ref, "@/etc/passwd", deps, "/repo");
    const argv = run.mock.calls[0]?.[0] ?? [];
    expect(argv.slice(-2)).toEqual(["-f", "body=@/etc/passwd"]);
    expect(argv).not.toContain("-F");
    expect(argv).not.toContain("--form");
  });

  test.each(["   ", "", "\t\n"])("AC-6: rejects whitespace body %j without running", async (body) => {
    const { deps, run } = fakeDeps();
    const error = await postError(github, body, deps);
    expect(error.code).toBe("FORGE_COMMENT_EMPTY");
    expect(error.context?.stage).toBe("forge");
    expect(run).not.toHaveBeenCalled();
  });

  test.each(["x".repeat(65_537), "😀".repeat(32_769)])(
    "AC-7: rejects oversized UTF-16 body %# without running",
    async (body) => {
      const { deps, run } = fakeDeps();
      const error = await postError(github, body, deps);
      expect(error.code).toBe("FORGE_COMMENT_TOO_LONG");
      expect(error.context?.stage).toBe("forge");
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("AC-8: accepts exactly 65,536 code units and runs once", async () => {
    const { deps, run } = fakeDeps();
    await forge.postPrComment(github, "x".repeat(65_536), deps, "/repo");
    expect(run).toHaveBeenCalledTimes(1);
  });

  test.each([github, gitlab])("AC-9/AC-10/AC-11: %s fails once with structured write context", async (ref) => {
    const { deps, run } = fakeDeps({ exitCode: 1, stdout: "not JSON", stderr: "  HTTP 403\n" });
    const error = await postError(ref, "summary", deps);
    expect(error.code).toBe("FORGE_COMMENT_WRITE_FAILED");
    expect(run).toHaveBeenCalledTimes(1);
    expect(error.context).toMatchObject({ stage: "forge", forge: ref.forge, exitCode: 1, stderr: "HTTP 403" });
  });

  test.each(["null", "{}", "[]", '{"id":null}'])("rejects a JSON reply without a comment id: %s", async (stdout) => {
    const { deps } = fakeDeps({ stdout });
    const error = await postError(github, "summary", deps);
    expect(error.code).toBe("FORGE_RESPONSE_UNPARSEABLE");
    expect(error.context?.stage).toBe("forge");
  });

  test("AC-12: rejects non-JSON success output with forge context and cause", async () => {
    const { deps, run } = fakeDeps({ stdout: "not JSON" });
    const error = await postError(github, "summary", deps);
    expect(error.code).toBe("FORGE_RESPONSE_UNPARSEABLE");
    expect(error.context?.stage).toBe("forge");
    expect(error.context?.cause).toBeInstanceOf(SyntaxError);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("MAX_FORGE_COMMENT_CHARS", () => {
  test("AC-13: exports the forge comment limit", () => {
    expect(forge.MAX_FORGE_COMMENT_CHARS).toBe(65_536);
  });
});

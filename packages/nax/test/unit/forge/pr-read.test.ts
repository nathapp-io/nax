import { describe, expect, mock, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeKind, ForgeRunResult } from "@/forge";
import * as forge from "@/forge";

const CWD = "/checkout";
const ORIGIN_ARGV = ["git", "remote", "get-url", "origin"];
const OK = { exitCode: 0, stdout: "", stderr: "" };
const FAILED = { exitCode: 128, stdout: "", stderr: "no origin" };

function fixture(remote: string, nextRemote?: ForgeRunResult) {
  let reads = 0;
  const run = mock(async (cmd: string[], _opts: { cwd: string }): Promise<ForgeRunResult> => {
    if (cmd[0] !== "git") return OK;
    reads += 1;
    return reads > 1 && nextRemote ? nextRemote : { ...OK, stdout: `${remote}\n` };
  });
  const deps: ForgeDeps = { run, readText: async () => null };
  return { deps, run };
}

async function expectUnresolved(action: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NaxError);
  expect(caught).toMatchObject({ code: "FORGE_PR_REF_UNRESOLVED", context: { stage: "forge" } });
}

describe("repoSlugFromRemoteUrl", () => {
  test.each([
    ["AC-1", "git@github.com:acme/widgets.git", "acme/widgets"],
    ["AC-2", "https://gitlab.example.com/group/sub/proj.git/", "group/sub/proj"],
    ["AC-3", "ssh://git@gitlab.example.com:2222/group/proj.git", "group/proj"],
    ["AC-4", "https://github.com/", null],
    ["empty scp path", "git@github.com:", null],
    ["invalid remote", "not a remote", null],
    ["suffix-only path", "https://github.com/.git/", null],
    ["surrounding slashes", "https://github.com//acme/widgets///", "acme/widgets"],
  ])("%s: parses %s", (_ac, remote, expected) => {
    expect(forge.repoSlugFromRemoteUrl(remote)).toBe(expected);
  });
});

describe("encodeProjectPath", () => {
  test("AC-5: encodes the full nested GitLab path as one segment", () => {
    expect(forge.encodeProjectPath("group/sub/proj")).toBe("group%2Fsub%2Fproj");
  });
});

describe("resolvePrRef", () => {
  test.each([
    ["AC-6", "git@gitlab.example.com:group/proj.git", "gitlab", "gitlab.example.com", "group/proj"],
    ["AC-7", "https://github.com/acme/widgets.git", "github", "github.com", "acme/widgets"],
  ] satisfies [string, string, ForgeKind, string, string][])(
    "%s: resolves origin %s",
    async (_ac, remote, kind, host, repo) => {
      const { deps, run } = fixture(remote);
      expect(await forge.resolvePrRef(7, deps, CWD)).toEqual({ forge: kind, host, repo, number: 7 });
      expect(run.mock.calls).toEqual([
        [ORIGIN_ARGV, { cwd: CWD }],
        [ORIGIN_ARGV, { cwd: CWD }],
      ]);
    },
  );

  test("AC-8: rejects when detection cannot choose a forge", async () => {
    const { deps, run } = fixture("git@git.example.com:group/proj.git");
    await expectUnresolved(() => forge.resolvePrRef(7, deps, CWD));
    expect(run.mock.calls).toEqual([
      [ORIGIN_ARGV, { cwd: CWD }],
      [["gh", "--version"], { cwd: CWD }],
      [["glab", "--version"], { cwd: CWD }],
    ]);
  });

  test("AC-9: rejects a non-zero origin read after successful detection", async () => {
    const { deps, run } = fixture("git@github.com:acme/widgets.git", FAILED);
    await expectUnresolved(() => forge.resolvePrRef(7, deps, CWD));
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(ORIGIN_ARGV, { cwd: CWD });
  });

  test("AC-10: rejects a remote with no repository slug", async () => {
    const { deps } = fixture("https://github.com/");
    await expectUnresolved(() => forge.resolvePrRef(7, deps, CWD));
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "AC-11/12: rejects invalid number %s before any I/O",
    async (number) => {
      const { deps, run } = fixture("git@github.com:acme/widgets.git");
      await expectUnresolved(() => forge.resolvePrRef(number, deps, CWD));
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("AC-13: unresolved errors carry forge stage context", async () => {
    const { deps } = fixture("https://github.com/");
    await expectUnresolved(() => forge.resolvePrRef(7, deps, CWD));
  });
});

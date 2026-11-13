/**
 * flow-repo.ts — the repository state a flow send reads before the card.
 *
 * Every git call goes through `_flowRepoDeps`, so each arm of the check is
 * driven here without a repository on disk.
 */

import { describe, expect, test } from "bun:test";
import { withDepsRestore } from "@test/helpers";
import {
  _flowRepoDeps,
  checkFlowBranch,
  type FlowRepoState,
  type FlowSendFeature,
  normalizeGitHubRemote,
  readFlowRepoState,
} from "@/chat/flow";

withDepsRestore(_flowRepoDeps, ["git", "isDirty", "headSha"]);

const REPO_ROOT = "/repo";
const SPEC = ".nax/features/nax-flow-send/spec.md";
const OTHER_SPEC = ".nax/features/nax-flow-docs/spec.md";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const DETACHED = "[chat] nax-flow__send needs a checked-out branch";
const DIRTY = "[chat] commit or stash your changes before sending a flow";
const NO_COMMITS = "[chat] the branch has no commits";
const NO_ORIGIN = "[chat] the repository has no origin remote";

interface GitCall {
  readonly args: readonly string[];
  readonly workdir: string;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const ok = (stdout = ""): GitResult => ({ stdout, stderr: "", exitCode: 0 });
const failed = (stderr = "boom"): GitResult => ({ stdout: "", stderr, exitCode: 1 });

/** Replace `_flowRepoDeps.git` with `handler`, recording every call it receives. */
function stubGit(handler: (args: string[]) => GitResult): GitCall[] {
  const calls: GitCall[] = [];
  _flowRepoDeps.git = async (args, workdir) => {
    calls.push({ args, workdir });
    return handler(args);
  };
  return calls;
}

/** A git answering every call a successful read makes; `overrides` wins for one arm. */
function healthyGit(overrides: (args: string[]) => GitResult | undefined = () => undefined): GitCall[] {
  return stubGit((args) => {
    const override = overrides(args);
    if (override !== undefined) return override;
    if (args[0] === "symbolic-ref") return ok("feat/x\n");
    if (args[0] === "remote") return ok("git@github.com:o/r.git\n");
    return ok();
  });
}

/** Replace the tree seams: a clean tree and a committed head unless a test says otherwise. */
function stubTree(opts: { dirty?: boolean; sha?: string | null } = {}): void {
  _flowRepoDeps.isDirty = async () => opts.dirty ?? false;
  _flowRepoDeps.headSha = async () => (opts.sha === undefined ? SHA : opts.sha);
}

/** The message of a failure result; throws when the read succeeded. */
function failureOf(state: FlowRepoState): string {
  if (state.ok) throw new Error(`expected a failure result, got ok: true for branch ${state.branch}`);
  return state.message;
}

/** The features koda orders: `x` first, then `y` which waits for it. */
function features(): FlowSendFeature[] {
  return [
    { feature: "x", specPath: SPEC, dependsOn: [] },
    { feature: "y", specPath: OTHER_SPEC, dependsOn: ["x"] },
  ];
}

describe("normalizeGitHubRemote", () => {
  test("returns the lower-cased HTTPS form for an scp-style SSH remote (AC-1)", () => {
    expect(normalizeGitHubRemote("git@github.com:O/R.git")).toBe("https://github.com/o/r");
  });

  test("returns the HTTPS form for an ssh:// remote with a .git suffix (AC-2)", () => {
    expect(normalizeGitHubRemote("ssh://git@github.com/o/r.git")).toBe("https://github.com/o/r");
  });

  test("returns the HTTPS form for an https remote with a trailing slash (AC-3)", () => {
    expect(normalizeGitHubRemote("https://github.com/o/r/")).toBe("https://github.com/o/r");
  });

  test.each([
    ["an https remote without a .git suffix", "https://github.com/o/r"],
    ["an https remote with a .git suffix", "https://github.com/o/r.git"],
    ["an scp-style remote without a .git suffix", "git@github.com:o/r"],
    ["an ssh:// remote without a .git suffix", "ssh://git@github.com/o/r"],
    ["an upper-case ssh:// remote", "ssh://git@github.com/O/R.GIT"],
    ["an https remote with trailing whitespace and slashes", "https://github.com/o/r.git//  "],
  ])("returns https://github.com/o/r for %s", (_label, remote) => {
    expect(normalizeGitHubRemote(remote)).toBe("https://github.com/o/r");
  });
});

describe("normalizeGitHubRemote — refusals", () => {
  test("returns null for a GitLab remote (AC-4)", () => {
    expect(normalizeGitHubRemote("https://gitlab.com/o/r.git")).toBeNull();
  });

  test.each([
    ["a GitLab https remote", "https://gitlab.com/o/r.git"],
    ["a GitLab scp-style remote", "git@gitlab.com:o/r.git"],
    ["a plain http GitHub remote, which koda's parser rejects", "http://github.com/o/r.git"],
    ["a GitHub remote with no repository segment", "https://github.com/o"],
    ["a GitHub remote whose repository is only the .git suffix", "https://github.com/o/.git"],
    ["a GitHub remote with a third path segment", "https://github.com/o/r/tree/main"],
    ["an empty value", ""],
    ["a self-hosted host naming github", "https://github.example.com/o/r.git"],
  ])("returns null for %s", (_label, remote) => {
    expect(normalizeGitHubRemote(remote)).toBeNull();
  });
});

describe("readFlowRepoState — the successful read", () => {
  test("returns the branch, the sha and the normalised remote (AC-5)", async () => {
    const calls = healthyGit();
    stubTree();

    const state = await readFlowRepoState(REPO_ROOT, [SPEC]);

    expect(state).toEqual({ ok: true, branch: "feat/x", sha: SHA, remoteUrl: "https://github.com/o/r" });
    expect(calls.map((call) => call.args)).toEqual([
      ["symbolic-ref", "--short", "HEAD"],
      ["remote", "get-url", "origin"],
      ["cat-file", "-e", `HEAD:${SPEC}`],
    ]);
    expect(calls.every((call) => call.workdir === REPO_ROOT)).toBe(true);
  });

  test("checks every spec path at HEAD, in the order the request lists them", async () => {
    const calls = healthyGit();
    stubTree();

    const state = await readFlowRepoState(REPO_ROOT, [SPEC, OTHER_SPEC]);

    expect(state.ok).toBe(true);
    expect(calls.filter((call) => call.args[0] === "cat-file").map((call) => call.args[2])).toEqual([
      `HEAD:${SPEC}`,
      `HEAD:${OTHER_SPEC}`,
    ]);
  });

  test("accepts an https origin with a .git suffix", async () => {
    healthyGit((args) => (args[0] === "remote" ? ok("https://github.com/O/R.git\n") : undefined));
    stubTree();

    const state = await readFlowRepoState(REPO_ROOT, [SPEC]);

    expect(state).toEqual({ ok: true, branch: "feat/x", sha: SHA, remoteUrl: "https://github.com/o/r" });
  });
});

describe("readFlowRepoState — the branch", () => {
  test("fails with the checked-out-branch message when symbolic-ref fails (AC-6)", async () => {
    healthyGit((args) => (args[0] === "symbolic-ref" ? failed("fatal: ref HEAD is not a symbolic ref") : undefined));
    stubTree();

    expect(await readFlowRepoState(REPO_ROOT, [SPEC])).toEqual({ ok: false, message: DETACHED });
  });

  test("fails with the checked-out-branch message when symbolic-ref rejects", async () => {
    _flowRepoDeps.git = async () => {
      throw new Error("git is not installed");
    };
    stubTree();

    expect(await readFlowRepoState(REPO_ROOT, [SPEC])).toEqual({ ok: false, message: DETACHED });
  });

  test("fails with a message naming main when the branch is main (AC-7)", async () => {
    healthyGit((args) => (args[0] === "symbolic-ref" ? ok("main\n") : undefined));
    stubTree();

    expect(failureOf(await readFlowRepoState(REPO_ROOT, [SPEC]))).toContain("main");
  });

  test("fails with a message naming master or naming the branch as empty (AC-23)", async () => {
    healthyGit((args) => (args[0] === "symbolic-ref" ? ok("master\n") : undefined));
    stubTree();
    expect(failureOf(await readFlowRepoState(REPO_ROOT, [SPEC]))).toContain("master");

    healthyGit((args) => (args[0] === "symbolic-ref" ? ok("\n") : undefined));
    stubTree();
    expect(failureOf(await readFlowRepoState(REPO_ROOT, [SPEC]))).toContain("empty branch name");
  });

  test("reports the branch, not the tree, when the branch is main and the tree is dirty (AC-14)", async () => {
    healthyGit((args) => (args[0] === "symbolic-ref" ? ok("main\n") : undefined));
    let askedDirty = false;
    _flowRepoDeps.isDirty = async () => {
      askedDirty = true;
      return true;
    };
    _flowRepoDeps.headSha = async () => SHA;

    const message = failureOf(await readFlowRepoState(REPO_ROOT, [SPEC]));

    expect(message).toContain("main");
    expect(message).not.toContain("commit or stash");
    expect(askedDirty).toBe(false);
  });
});

describe("readFlowRepoState — the working tree", () => {
  test("fails with the dirty-tree message when the tree has changes (AC-8)", async () => {
    healthyGit();
    stubTree({ dirty: true });

    expect(await readFlowRepoState(REPO_ROOT, [SPEC])).toEqual({ ok: false, message: DIRTY });
  });

  test("fails with the unreadable-state prefix when isDirty throws (AC-9)", async () => {
    healthyGit();
    stubTree();
    _flowRepoDeps.isDirty = async () => {
      throw new Error("git status failed in /repo");
    };

    const message = failureOf(await readFlowRepoState(REPO_ROOT, [SPEC]));

    expect(message.startsWith("[chat] could not read the repository state: ")).toBe(true);
    expect(message).toContain("git status failed in /repo");
  });
});

describe("readFlowRepoState — the head sha", () => {
  test("fails with the no-commits message on an unborn branch (AC-10)", async () => {
    healthyGit();
    stubTree({ sha: null });

    expect(await readFlowRepoState(REPO_ROOT, [SPEC])).toEqual({ ok: false, message: NO_COMMITS });
  });
});

describe("readFlowRepoState — the origin remote", () => {
  test("fails with the no-origin message when remote get-url origin fails (AC-11)", async () => {
    healthyGit((args) => (args[0] === "remote" ? failed("error: No such remote 'origin'") : undefined));
    stubTree();

    expect(await readFlowRepoState(REPO_ROOT, [SPEC])).toEqual({ ok: false, message: NO_ORIGIN });
  });

  test("fails with a message naming the remote when the origin is not GitHub (AC-12)", async () => {
    healthyGit((args) => (args[0] === "remote" ? ok("https://gitlab.com/o/r.git\n") : undefined));
    stubTree();

    expect(failureOf(await readFlowRepoState(REPO_ROOT, [SPEC]))).toContain("https://gitlab.com/o/r.git");
  });
});

describe("readFlowRepoState — the spec paths", () => {
  test("fails with a message naming the one spec path absent at HEAD (AC-13)", async () => {
    healthyGit((args) => (args[2] === `HEAD:${OTHER_SPEC}` ? failed("fatal: Not a valid object name") : undefined));
    stubTree();

    const message = failureOf(await readFlowRepoState(REPO_ROOT, [SPEC, OTHER_SPEC]));

    expect(message).toContain(OTHER_SPEC);
    expect(message).not.toContain(SPEC);
  });
});

describe("checkFlowBranch", () => {
  test("returns undefined for a feature branch whose features do not collide (AC-15)", () => {
    expect(checkFlowBranch("feat/x", features())).toBeUndefined();
  });

  test("returns a message naming the branch when it fails koda's ref rule (AC-16)", () => {
    const message = checkFlowBranch("feat//x", features());

    expect(message).toBeDefined();
    expect(message).toContain("feat//x");
  });

  test.each([
    ["a leading dash", "-feat"],
    ["a leading dot", ".feat"],
    ["a leading slash", "/feat"],
    ["a double dot", "feat/../x"],
    ["a .lock suffix", "feat/x.lock"],
    ["a trailing slash", "feat/x/"],
    ["an empty name", ""],
    ["a space", "feat x"],
    ["more than 255 characters", `feat/${"a".repeat(252)}`],
  ])("returns a message naming the branch for %s", (_label, branch) => {
    expect(checkFlowBranch(branch, features())).toBeDefined();
  });

  test("returns a message naming feature y when y at index 1 would take the branch (AC-17)", () => {
    const message = checkFlowBranch("feat/y", features());

    expect(message).toBeDefined();
    expect(message).toContain("y");
    expect(message).toContain("feat/y");
  });

  test("does not collide with a feature at index 0, which koda itself branches on", () => {
    expect(checkFlowBranch("feat/x", features())).toBeUndefined();
  });
});

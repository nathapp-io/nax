import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { ResolveResult } from "@/cli";
import { _finishContextDeps, loadFinishContext } from "@/finish";
import type { ForgeDeps, ForgeRunResult } from "@/forge";

type GitResult = { stdout: string; stderr: string; exitCode: number };

const okGit = (stdout: string, exitCode = 0, stderr = ""): GitResult => ({ stdout, stderr, exitCode });

/** Every test drives its own git responder; default routes remote-show to a clean origin/main. */
function makeGit(opts: { remoteShow?: GitResult; verifyMain?: GitResult; revList?: GitResult }) {
  const remoteShow = opts.remoteShow ?? okGit("  HEAD branch: main\n");
  const verifyMain = opts.verifyMain ?? okGit("abc123\n");
  const revList = opts.revList ?? okGit("0\n");

  return async (args: string[], _workdir: string, _timeoutMs?: number): Promise<GitResult> => {
    if (args[0] === "remote" && args[1] === "show") return remoteShow;
    if (args[0] === "rev-parse" && args[1] === "--verify") return verifyMain;
    if (args[0] === "rev-list") return revList;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

const okResolve: ResolveResult = {
  status: "ok",
  featureName: "my-feature",
  specSource: { kind: "markdown", path: ".nax/features/my-feature/spec.md" },
  acceptance: {
    status: "ok",
    enabled: true,
    groups: [{ packageDir: "", testPath: "t.test.ts", exists: true, cwd: "" }],
  },
  testPatterns: { regex: ["\\.test\\.ts$"], resolution: "detected" },
  message: "resolved spec: .nax/features/my-feature/spec.md",
};

describe("loadFinishContext", () => {
  test("a null specSource (status missing) escalates and never proceeds with an empty specPath", async () => {
    _finishContextDeps.git = makeGit({});
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => ({
      status: "missing",
      featureName: "my-feature",
      specSource: null,
      checked: [".nax/features/my-feature/spec.md", ".nax/specs/my-feature.md"],
      message: "no spec found",
    });

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.route).toBe("escalate");
    expect(ctx.specPath).toBe("");
    expect(ctx.reason).toContain("my-feature");
    expect(ctx.reason).toContain(".nax/features/my-feature/spec.md");
  });

  test("a null specSource (status feature-not-found) also escalates", async () => {
    _finishContextDeps.git = makeGit({});
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => ({
      status: "feature-not-found",
      featureName: "ghost",
      specSource: null,
      checked: [".nax/features/ghost/spec.md"],
      candidates: [],
      message: "feature not found",
    });

    const ctx = await loadFinishContext("ghost", "/repo");

    expect(ctx.route).toBe("escalate");
    expect(ctx.specPath).toBe("");
  });

  test("resolveFeatureSpec throwing (invalid feature name) escalates instead of propagating", async () => {
    _finishContextDeps.git = makeGit({});
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => {
      throw new Error("invalid feature name: contains '/'");
    };

    const ctx = await loadFinishContext("bad/name", "/repo");

    expect(ctx.route).toBe("escalate");
    expect(ctx.specPath).toBe("");
    expect(ctx.reason).toContain("bad/name");
  });

  test("git rev-list exiting non-zero escalates rather than returning 0", async () => {
    _finishContextDeps.git = makeGit({ revList: okGit("", 128, "fatal: bad revision") });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.route).toBe("escalate");
    expect(ctx.commitsAhead).toBe(0);
    expect(ctx.reason).toContain("rev-list");
    // The spec/acceptance context that WAS resolved should still be reported.
    expect(ctx.specPath).toBe(".nax/features/my-feature/spec.md");
  });

  test("rev-list exiting 0 with empty/unparseable stdout escalates", async () => {
    _finishContextDeps.git = makeGit({ revList: okGit("   \n") });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.route).toBe("escalate");
    expect(ctx.commitsAhead).toBe(0);
    expect(ctx.reason).toBeDefined();
  });

  test("a clean count of 0 returns nothing-to-finish, not escalate", async () => {
    _finishContextDeps.git = makeGit({ revList: okGit("0\n") });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.route).toBe("nothing-to-finish");
    expect(ctx.commitsAhead).toBe(0);
  });

  test("a positive commit count proceeds", async () => {
    _finishContextDeps.git = makeGit({ revList: okGit("3\n") });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.route).toBe("proceed");
    expect(ctx.commitsAhead).toBe(3);
    expect(ctx.base).toBe("origin/main");
  });

  test("resolveTestFilePatterns having failed internally (testPatterns absent) yields testFileRegex: [] and does not fail the load", async () => {
    _finishContextDeps.git = makeGit({ revList: okGit("1\n") });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => ({
      ...okResolve,
      testPatterns: undefined,
    });

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.route).toBe("proceed");
    expect(ctx.testFileRegex).toEqual([]);
  });

  test("acceptanceStatus: disabled is passed through untouched", async () => {
    _finishContextDeps.git = makeGit({ revList: okGit("1\n") });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => ({
      ...okResolve,
      acceptance: { status: "disabled", enabled: false, groups: [] },
    });

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.acceptanceStatus).toBe("disabled");
    expect(ctx.groups).toEqual([]);
  });

  test("base branch falls back to origin/master when neither HEAD branch nor origin/main verify", async () => {
    _finishContextDeps.git = makeGit({
      remoteShow: okGit("some other output with no HEAD branch line\n"),
      verifyMain: okGit("", 1, "fatal: no such ref"),
      revList: okGit("2\n"),
    });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.base).toBe("origin/master");
    expect(ctx.route).toBe("proceed");
  });
});

describe("loadFinishContext — ledger entry check (#1674 part 1)", () => {
  test("no ledgerOpts passed: behaves exactly as before (route stays 'proceed')", async () => {
    _finishContextDeps.git = makeGit({ revList: okGit("3\n") });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

    const ctx = await loadFinishContext("my-feature", "/repo");

    expect(ctx.route).toBe("proceed");
  });

  test("a ledger hit at the identical HEAD on the same branch routes to already-finished", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "my-feature");
      await Bun.write(
        join(auditDir, "last.json"),
        JSON.stringify({
          branch: "feat/x",
          headSha: "same-sha",
          status: "opened",
          prUrl: "https://example.com/pr/9",
          runId: "run-0",
          finishedAt: "2026-08-20T00:00:00.000Z",
        }),
      );
      _finishContextDeps.git = async (args: string[]): Promise<GitResult> => {
        if (args[0] === "remote" && args[1] === "show") return okGit("  HEAD branch: main\n");
        if (args[0] === "rev-list") return okGit("3\n");
        if (args[0] === "rev-parse" && args[1] === "HEAD") return okGit("same-sha\n");
        if (args[0] === "rev-parse" && args[1] === "--verify") return okGit("abc123\n");
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

      const ctx = await loadFinishContext("my-feature", "/repo", {
        branch: "feat/x",
        auditDir,
        rerun: "on-change",
      });

      expect(ctx.route).toBe("already-finished");
      expect(ctx.prUrl).toBe("https://example.com/pr/9");
    });
  });

  test("a ledger miss after a new commit (different HEAD) still proceeds", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "my-feature");
      await Bun.write(
        join(auditDir, "last.json"),
        JSON.stringify({
          branch: "feat/x",
          headSha: "old-sha",
          status: "opened",
          runId: "run-0",
          finishedAt: "2026-08-20T00:00:00.000Z",
        }),
      );
      _finishContextDeps.git = async (args: string[]): Promise<GitResult> => {
        if (args[0] === "remote" && args[1] === "show") return okGit("  HEAD branch: main\n");
        if (args[0] === "rev-list") return okGit("1\n");
        if (args[0] === "rev-parse" && args[1] === "HEAD") return okGit("new-sha\n");
        if (args[0] === "rev-parse" && args[1] === "--verify") return okGit("abc123\n");
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

      const ctx = await loadFinishContext("my-feature", "/repo", {
        branch: "feat/x",
        auditDir,
        rerun: "on-change",
      });

      expect(ctx.route).toBe("proceed");
    });
  });

  test("an escalated ledger entry at the same HEAD also routes to already-finished (must not re-page)", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "my-feature");
      await Bun.write(
        join(auditDir, "last.json"),
        JSON.stringify({
          branch: "feat/x",
          headSha: "same-sha",
          status: "escalated",
          runId: "run-0",
          finishedAt: "2026-08-20T00:00:00.000Z",
        }),
      );
      _finishContextDeps.git = async (args: string[]): Promise<GitResult> => {
        if (args[0] === "remote" && args[1] === "show") return okGit("  HEAD branch: main\n");
        if (args[0] === "rev-list") return okGit("2\n");
        if (args[0] === "rev-parse" && args[1] === "HEAD") return okGit("same-sha\n");
        if (args[0] === "rev-parse" && args[1] === "--verify") return okGit("abc123\n");
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

      const ctx = await loadFinishContext("my-feature", "/repo", {
        branch: "feat/x",
        auditDir,
        rerun: "on-change",
      });

      expect(ctx.route).toBe("already-finished");
    });
  });

  test("finish.rerun 'always' bypasses the ledger check entirely", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "my-feature");
      await Bun.write(
        join(auditDir, "last.json"),
        JSON.stringify({
          branch: "feat/x",
          headSha: "same-sha",
          status: "opened",
          runId: "run-0",
          finishedAt: "2026-08-20T00:00:00.000Z",
        }),
      );
      _finishContextDeps.git = async (args: string[]): Promise<GitResult> => {
        if (args[0] === "remote" && args[1] === "show") return okGit("  HEAD branch: main\n");
        if (args[0] === "rev-list") return okGit("2\n");
        if (args[0] === "rev-parse" && args[1] === "HEAD") return okGit("same-sha\n");
        if (args[0] === "rev-parse" && args[1] === "--verify") return okGit("abc123\n");
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

      const ctx = await loadFinishContext("my-feature", "/repo", {
        branch: "feat/x",
        auditDir,
        rerun: "always",
      });

      expect(ctx.route).toBe("proceed");
    });
  });

  test("a corrupt last.json fails open — finish proceeds rather than throwing", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "my-feature");
      await Bun.write(join(auditDir, "last.json"), "{ not valid json at all");
      _finishContextDeps.git = makeGit({ revList: okGit("2\n") });
      _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

      const ctx = await loadFinishContext("my-feature", "/repo", {
        branch: "feat/x",
        auditDir,
        rerun: "on-change",
      });

      expect(ctx.route).toBe("proceed");
    });
  });

  test("an absent last.json fails open — finish proceeds rather than throwing", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "my-feature");
      _finishContextDeps.git = makeGit({ revList: okGit("2\n") });
      _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

      const ctx = await loadFinishContext("my-feature", "/repo", {
        branch: "feat/x",
        auditDir,
        rerun: "on-change",
      });

      expect(ctx.route).toBe("proceed");
    });
  });

  test("a ledger entry for a different branch does not skip", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "my-feature");
      await Bun.write(
        join(auditDir, "last.json"),
        JSON.stringify({
          branch: "feat/other",
          headSha: "same-sha",
          status: "opened",
          runId: "run-0",
          finishedAt: "2026-08-20T00:00:00.000Z",
        }),
      );
      _finishContextDeps.git = async (args: string[]): Promise<GitResult> => {
        if (args[0] === "remote" && args[1] === "show") return okGit("  HEAD branch: main\n");
        if (args[0] === "rev-list") return okGit("2\n");
        if (args[0] === "rev-parse" && args[1] === "HEAD") return okGit("same-sha\n");
        if (args[0] === "rev-parse" && args[1] === "--verify") return okGit("abc123\n");
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

      const ctx = await loadFinishContext("my-feature", "/repo", {
        branch: "feat/x",
        auditDir,
        rerun: "on-change",
      });

      expect(ctx.route).toBe("proceed");
    });
  });
});

/**
 * A `ForgeDeps` whose `run` answers the branch's PR view with `stdout`, and
 * records every argv it was handed so a test can assert the check did (or did
 * not) reach the forge.
 */
function makeForge(res: Partial<ForgeRunResult> & { throws?: boolean }): {
  deps: ForgeDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  const deps: ForgeDeps = {
    run: async (cmd: string[]): Promise<ForgeRunResult> => {
      calls.push(cmd);
      if (res.throws) throw new Error("gh: command not found");
      return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode: res.exitCode ?? 0 };
    },
    readText: async () => null,
  };
  return { deps, calls };
}

/** The git responder every #1674-part-2 test shares: 3 commits ahead, no ledger involvement. */
const aheadGit = async (args: string[]): Promise<GitResult> => {
  if (args[0] === "remote" && args[1] === "show") return okGit("  HEAD branch: main\n");
  if (args[0] === "rev-list") return okGit("3\n");
  if (args[0] === "rev-parse" && args[1] === "HEAD") return okGit("head-sha\n");
  if (args[0] === "rev-parse" && args[1] === "--verify") return okGit("abc123\n");
  throw new Error(`unexpected git call: ${args.join(" ")}`);
};

describe("loadFinishContext — merged/closed PR short-circuit (#1674 part 2)", () => {
  const ledgerOpts = (deps: ForgeDeps) => ({
    branch: "feat/x",
    auditDir: "/nonexistent-audit-dir",
    rerun: "on-change" as const,
    forge: { kind: "github" as const, deps },
  });

  test("a merged GitHub PR routes to nothing-to-finish, carrying its url", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps, calls } = makeForge({
      stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-08-22T00:00:00Z", url: "https://example.com/pr/7" }),
    });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("nothing-to-finish");
    expect(ctx.skipReason).toBe("pr-merged");
    expect(ctx.prUrl).toBe("https://example.com/pr/7");
    // Reported honestly: the branch really is ahead, it is the PR that is done.
    expect(ctx.commitsAhead).toBe(3);
    expect(calls[0]?.slice(0, 3)).toEqual(["gh", "pr", "view"]);
  });

  test("a merged GitLab MR (lower-case state) is recognised too", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({ stdout: JSON.stringify({ state: "merged", web_url: "https://gl.example/mr/2" }) });

    const ctx = await loadFinishContext("my-feature", "/repo", {
      ...ledgerOpts(deps),
      forge: { kind: "gitlab", deps },
    });

    expect(ctx.route).toBe("nothing-to-finish");
    expect(ctx.skipReason).toBe("pr-merged");
    expect(ctx.prUrl).toBe("https://gl.example/mr/2");
  });

  test("a CLOSED PR carrying a mergedAt is treated as merged, not as an escalation", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({
      stdout: JSON.stringify({ state: "CLOSED", mergedAt: "2026-08-22T00:00:00Z", url: "https://example.com/pr/8" }),
    });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("nothing-to-finish");
    expect(ctx.skipReason).toBe("pr-merged");
  });

  test("a closed-unmerged PR escalates rather than reporting nothing to finish", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({
      stdout: JSON.stringify({ state: "CLOSED", mergedAt: null, url: "https://example.com/pr/9" }),
    });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("escalate");
    expect(ctx.reason).toContain("closed without being merged");
    expect(ctx.reason).toContain("https://example.com/pr/9");
    expect(ctx.prUrl).toBe("https://example.com/pr/9");
  });

  test("an open PR proceeds", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({ stdout: JSON.stringify({ state: "OPEN", url: "https://example.com/pr/1" }) });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("proceed");
    expect(ctx.skipReason).toBeUndefined();
  });

  test("fails open: a non-zero forge exit (no PR, or an unauthenticated CLI) proceeds", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({ exitCode: 1, stderr: "no pull requests found for branch" });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("proceed");
  });

  test("fails open: unparseable forge output proceeds", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({ stdout: "not json at all" });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("proceed");
  });

  // Post-review CRITICAL: `JSON.parse("null")` SUCCEEDS, so the parse catch
  // never fires and the first property read threw a TypeError — out of
  // `loadFinishContext`, which runs before the state machine and so is
  // outside its catch, aborting the entire finish phase. Every non-object
  // payload is pinned here, not just the one that crashed, because the crash
  // was the only member of this set anyone had thought to try.
  for (const [label, stdout] of [
    ["literal null", "null"],
    ["an array", "[]"],
    ["a bare string", '"no result"'],
    ["a number", "5"],
  ] as const) {
    test(`fails open: forge output that is ${label} proceeds instead of throwing`, async () => {
      _finishContextDeps.git = aheadGit;
      _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
      const { deps } = makeForge({ stdout });

      const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

      expect(ctx.route).toBe("proceed");
    });
  }

  test("the closed-unmerged route marks the escalation as one that must not push", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({ stdout: JSON.stringify({ state: "CLOSED", mergedAt: null }) });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("escalate");
    expect(ctx.escalateWithoutPush).toBe(true);
  });

  test("a merged PR does not set escalateWithoutPush — it never escalates at all", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({ stdout: JSON.stringify({ state: "MERGED" }) });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.escalateWithoutPush).toBeUndefined();
  });

  test("fails open: a forge CLI that cannot be spawned proceeds instead of throwing", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps } = makeForge({ throws: true });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("proceed");
  });

  test("a null forge kind never reaches the forge at all", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps, calls } = makeForge({ stdout: JSON.stringify({ state: "MERGED" }) });

    const ctx = await loadFinishContext("my-feature", "/repo", { ...ledgerOpts(deps), forge: { kind: null, deps } });

    expect(ctx.route).toBe("proceed");
    expect(calls).toHaveLength(0);
  });

  test("omitting the forge option entirely keeps the pre-#1674-part-2 behaviour", async () => {
    _finishContextDeps.git = aheadGit;
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;

    const ctx = await loadFinishContext("my-feature", "/repo", {
      branch: "feat/x",
      auditDir: "/nonexistent-audit-dir",
      rerun: "on-change",
    });

    expect(ctx.route).toBe("proceed");
  });

  test("a zero-commit branch never asks the forge — the preflight already routed it", async () => {
    _finishContextDeps.git = makeGit({ revList: okGit("0\n") });
    _finishContextDeps.resolveFeatureSpec = async (): Promise<ResolveResult> => okResolve;
    const { deps, calls } = makeForge({ stdout: JSON.stringify({ state: "MERGED" }) });

    const ctx = await loadFinishContext("my-feature", "/repo", ledgerOpts(deps));

    expect(ctx.route).toBe("nothing-to-finish");
    // The plain preflight route, not the merged short-circuit.
    expect(ctx.skipReason).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

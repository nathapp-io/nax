import { describe, expect, test } from "bun:test";
import type { ResolveResult } from "@/cli";
import { _finishContextDeps, loadFinishContext } from "@/finish";

type GitResult = { stdout: string; stderr: string; exitCode: number };

const okGit = (stdout: string, exitCode = 0, stderr = ""): GitResult => ({ stdout, stderr, exitCode });

/** Every test drives its own git responder; default routes remote-show to a clean origin/main. */
function makeGit(opts: {
  remoteShow?: GitResult;
  verifyMain?: GitResult;
  revList?: GitResult;
}) {
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
  acceptance: { status: "ok", enabled: true, groups: [{ packageDir: "", testPath: "t.test.ts", exists: true, cwd: "" }] },
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

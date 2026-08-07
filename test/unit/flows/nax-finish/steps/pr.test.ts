import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openOrPromotePr } from "@flows/nax-finish/steps/pr";
// `_prDeps` (readText/warn/run) and `loadFinishPrContext` live on `_prBodyDeps`
// in `./pr-body` — `./pr` only re-exports `run`-typed `_prDeps` for its own
// forge-CLI calls, so the full seam is imported from its actual owner here.
import { _prBodyDeps as _prDeps, loadFinishPrContext } from "@flows/nax-finish/steps/pr-body";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import type { FinishInput, FinishRound, RunResult } from "@flows/nax-finish/types";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const originalRun = _prDeps.run;
const originalReadText = _prDeps.readText;
const originalWarn = _prDeps.warn;
const originalResultReadText = _resultDeps.readText;
const input = (overrides: Partial<FinishInput> = {}): FinishInput => ({
  feature: "finish-pr-body",
  workdir: "/repo",
  branch: "feat/finish-pr-body",
  prdPath: "/repo/.nax/features/finish-pr-body/prd.json",
  escalateTelegram: false,
  ...overrides,
});
// US-003 tests only assert on PRD/status parsing; US-004 made the loader
// also call `_prDeps.run` (git diff --stat) and `_resultDeps.readText`
// (audit-trail JSONL), so we mock every external dependency up front. Tests
// that care about real-IO behavior override these in their own body.
beforeEach(() => {
  _prDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  _prDeps.readText = async () => null;
  _resultDeps.readText = async () => null;
});
afterEach(() => {
  _prDeps.run = originalRun;
  _prDeps.readText = originalReadText;
  _prDeps.warn = originalWarn;
  _resultDeps.readText = originalResultReadText;
});

describe("loadFinishPrContext (US-003 AC1-AC10)", () => {
  test("US-003 AC1 returns each PRD story with id, title, and acceptance criteria count", async () => {
    _prDeps.readText = async (path) =>
      path.endsWith("prd.json")
        ? JSON.stringify({
            userStories: [
              { id: "US-001", title: "First", acceptanceCriteria: ["one", "two"] },
              { id: "US-002", title: "Second", acceptanceCriteria: [] },
            ],
          })
        : null;

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.stories).toEqual([
      { id: "US-001", title: "First", acCount: 2 },
      { id: "US-002", title: "Second", acCount: 0 },
    ]);
  });

  test("US-003 AC2 returns the PRD outOfScope array", async () => {
    _prDeps.readText = async (path) =>
      path.endsWith("prd.json") ? JSON.stringify({ outOfScope: ["templates", "cost reporting"] }) : null;

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.outOfScope).toEqual(["templates", "cost reporting"]);
  });

  test("US-003 AC3 returns FinishInput.feature", async () => {
    _prDeps.readText = async () => null;

    const result = await loadFinishPrContext(input({ feature: "artifact-context" }), {
      base: "main",
      gatesRan: [],
    });

    expect(result.feature).toBe("artifact-context");
  });

  test("US-003 AC4 reads status.json beside an absolute prdPath", async () => {
    const paths: string[] = [];
    _prDeps.readText = async (path) => {
      paths.push(path);
      return null;
    };

    await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(paths).toContain("/repo/.nax/features/finish-pr-body/status.json");
  });

  test("US-003 AC5 resolves a relative PRD and sibling status path against workdir", async () => {
    const paths: string[] = [];
    _prDeps.readText = async (path) => {
      paths.push(path);
      return null;
    };

    await loadFinishPrContext(input({ workdir: "/workspace", prdPath: ".nax/features/x/prd.json" }), {
      base: "main",
      gatesRan: [],
    });

    expect(paths).toEqual(["/workspace/.nax/features/x/prd.json", "/workspace/.nax/features/x/status.json"]);
  });

  test("US-003 keeps empty prdPath artifact reads inside workdir", async () => {
    const paths: string[] = [];
    _prDeps.readText = async (path) => {
      paths.push(path);
      return null;
    };

    await loadFinishPrContext(input({ workdir: "/workspace", prdPath: "" }), {
      base: "main",
      gatesRan: [],
    });

    expect(paths).toEqual(["/workspace/prd.json", "/workspace/status.json"]);
  });

  test("US-003 AC6-AC10 returns status outcomes, duration, and story progress", async () => {
    _prDeps.readText = async (path) =>
      path.endsWith("status.json")
        ? JSON.stringify({
            postRun: { acceptance: { status: "passed" }, regression: { status: "failed" } },
            durationMs: 12_345,
            progress: { passed: 4, total: 5 },
          })
        : null;

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: ["lint"] });

    expect(result.acceptance).toBe("passed");
    expect(result.regression).toBe("failed");
    expect(result.run).toEqual({ durationMs: 12_345, storiesPassed: 4, storiesTotal: 5 });
  });
});

describe("loadFinishPrContext fail-open behavior (US-003 AC11-AC14)", () => {
  test("US-003 AC11 returns empty PRD fields when the PRD file is missing", async () => {
    _prDeps.readText = async () => null;

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.stories).toEqual([]);
    expect(result.outOfScope).toEqual([]);
  });

  test("US-003 AC12 returns empty PRD fields when the PRD JSON is invalid", async () => {
    _prDeps.readText = async (path) => (path.endsWith("prd.json") ? "{ invalid" : null);

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.stories).toEqual([]);
    expect(result.outOfScope).toEqual([]);
  });

  test("US-003 AC13 leaves status outcomes undefined when status.json is missing", async () => {
    _prDeps.readText = async (path) => (path.endsWith("prd.json") ? "{}" : null);

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.acceptance).toBeUndefined();
    expect(result.regression).toBeUndefined();
  });

  test("US-003 AC14 leaves status outcomes undefined when status.json is invalid", async () => {
    _prDeps.readText = async (path) => (path.endsWith("status.json") ? "{ invalid" : "{}");

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.acceptance).toBeUndefined();
    expect(result.regression).toBeUndefined();
  });

  test("US-003 reports unreadable artifacts while preserving fail-open results", async () => {
    const warnings: { message: string; path: string; error: unknown }[] = [];
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    _prDeps.readText = async () => {
      throw failure;
    };
    _prDeps.warn = (message, details) => warnings.push({ message, ...details });

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.stories).toEqual([]);
    expect(result.outOfScope).toEqual([]);
    expect(result.acceptance).toBeUndefined();
    expect(result.regression).toBeUndefined();
    expect(warnings).toEqual([
      {
        message: "[finish-pr] Failed to read PR context artifact",
        path: "/repo/.nax/features/finish-pr-body/prd.json",
        error: failure,
      },
      {
        message: "[finish-pr] Failed to read PR context artifact",
        path: "/repo/.nax/features/finish-pr-body/status.json",
        error: failure,
      },
    ]);
  });
});

describe("loadFinishPrContext (US-004 AC1-AC6)", () => {
  // US-004 AC1 — every round read from the audit trail reaches the PR context
  // with its `sha` preserved, so the body can cite "Fixed in <sha>" without a
  // second `git log` lookup.
  test("US-004 AC1 returns rounds from readRounds with each sha preserved", async () => {
    const rounds: FinishRound[] = [
      {
        ts: "2026-08-01T05:00:00.000Z",
        phase: "spec",
        attempt: 1,
        committed: true,
        findings: [],
        sha: "abc123def4567",
      },
      {
        ts: "2026-08-01T05:01:00.000Z",
        phase: "gate",
        attempt: 1,
        committed: true,
        findings: [],
        sha: "def456abc7890",
      },
    ];
    _resultDeps.readText = async () => `${JSON.stringify(rounds[0])}\n${JSON.stringify(rounds[1])}\n`;

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].sha).toBe("abc123def4567");
    expect(result.rounds[1].sha).toBe("def456abc7890");
  });

  // US-004 AC2 — the caller-supplied gatesRan list is what gates are surfaced
  // as "green" in the PR's verification line, and it must round-trip exactly.
  test("US-004 AC2 returns args.gatesRan verbatim as gatesRan", async () => {
    const result = await loadFinishPrContext(input(), {
      base: "main",
      gatesRan: ["lint", "typecheck_1", "security_gate"],
    });

    expect(result.gatesRan).toEqual(["lint", "typecheck_1", "security_gate"]);
  });

  // US-004 AC3 — the diffstat command is the only reason the loader now needs
  // `_prDeps.run`; it must use the caller-supplied base verbatim so a fork with
  // an unusual default branch is not silently diffed against `main`.
  test("US-004 AC3 invokes git diff --stat with the supplied base branch", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 1, stdout: "", stderr: "" };
    };

    await loadFinishPrContext(input(), { base: "origin/release/2026.08", gatesRan: [] });

    // Two calls since the artifact exclusion landed: the reviewable diffstat,
    // and the `--shortstat` that accounts for the nax artifacts held out of it.
    // Both must carry the caller's base — the point of this AC.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain("origin/release/2026.08...HEAD");
    }
    expect(calls.find((c) => c.includes("--stat"))).toEqual([
      "git",
      "diff",
      "--stat",
      "origin/release/2026.08...HEAD",
      "--",
      ":(glob,exclude)**/.nax/**",
    ]);
  });

  // US-004 AC4 — the diffstat text is rendered verbatim into the Verification
  // block of the PR body, so the loader must return stdout unchanged.
  test("US-004 AC4 returns diffstat stdout verbatim when git exits 0", async () => {
    const stdout = " src/foo.ts | 12 ++++--\n 1 file changed, 9 insertions(+), 3 deletions(-)\n";
    _prDeps.run = async () => ({ exitCode: 0, stdout, stderr: "" });

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.diffstat).toBe(stdout);
  });

  // US-004 AC5 — a non-zero diff (no commits, divergent branch, missing fork)
  // must not throw and must leave diffstat undefined, otherwise `open_pr` loses
  // its try/catch and the whole finish fails on a routine empty-branch case.
  test("US-004 AC5 returns diffstat undefined and does not throw when git exits non-zero", async () => {
    _prDeps.run = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: bad revision" });

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.diffstat).toBeUndefined();
  });

  // US-004 AC5 (rejection path) — the diffstat command can also reject (e.g.,
  // fork too slow to start). The loader must swallow that the same way it
  // swallows a non-zero exit, otherwise the rejection becomes an uncaught error
  // in the flow `open_pr` node.
  test("US-004 AC5 returns diffstat undefined and does not throw when git rejects", async () => {
    _prDeps.run = async () => {
      throw new Error("spawn ENOENT");
    };

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.diffstat).toBeUndefined();
  });

  // US-004 AC6 — a missing audit trail is the *common* case (first finish of a
  // feature, run killed before any fix round lands) and must surface as an
  // empty `rounds` array with no throw — readRounds already returns [] on
  // ENOENT, but the loader must not turn that into an error path of its own.
  test("US-004 AC6 returns an empty rounds array when the audit trail file does not exist", async () => {
    // _resultDeps.readText is default-mocked to return null in beforeEach, which
    // is what readRounds surfaces for a missing audit trail.
    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.rounds).toEqual([]);
  });
});

describe("openOrPromotePr", () => {
  test("promotes an existing draft to ready", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url"))
        return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      if (cmd.includes("view"))
        return { exitCode: 0, stdout: JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("promoted");
    expect(r.url).toBe("https://gh/pr/1");
    expect(calls.some((c) => c.includes("ready"))).toBe(true);
  });

  test("opens a new ready PR when none exists", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) return ok("Creating pull request\nhttps://gh/pr/2\n");
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("opened");
    expect(r.url).toBe("https://gh/pr/2");
    expect(calls.some((c) => c.includes("create") && c.includes("--draft"))).toBe(false);
  });

  test("returns already-ready when view succeeds and not draft", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: false, url: "https://gh/pr/3" }));
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("already-ready");
    expect(r.url).toBe("https://gh/pr/3");
    expect(calls.some((c) => c.includes("ready"))).toBe(false);
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  test("throws when the remote URL doesn't match github.com or gitlab.com", async () => {
    _prDeps.run = async () => ok("git@bitbucket.org:o/r.git");
    await expect(openOrPromotePr("/repo", "feat/x", "t", "b")).rejects.toThrow();
  });

  test("throws when creating the PR fails", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) return { exitCode: 1, stdout: "", stderr: "auth required" };
      return ok("");
    };
    await expect(openOrPromotePr("/repo", "feat/x", "t", "b")).rejects.toThrow(/auth required/);
  });

  test("throws when promoting the draft fails", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }));
      if (cmd.includes("ready")) return { exitCode: 1, stdout: "", stderr: "conflict" };
      return ok("");
    };
    await expect(openOrPromotePr("/repo", "feat/x", "t", "b")).rejects.toThrow(/conflict/);
  });
});

describe("openOrPromotePr — finish metadata write (US-005 AC1-AC7)", () => {
  test("US-005 AC1 invokes gh pr edit with title/body after gh pr ready on a draft", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }));
      return ok("");
    };
    await openOrPromotePr("/repo", "feat/x", "finish-title", "finish-body");
    const readyIdx = calls.findIndex((c) => c.includes("ready"));
    const editIdx = calls.findIndex((c) => c.includes("edit"));
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(editIdx).toBeGreaterThan(readyIdx);
    expect(calls[editIdx]).toEqual(["gh", "pr", "edit", "feat/x", "--title", "finish-title", "--body", "finish-body"]);
  });

  test("US-005 AC2 returns status promoted for a github draft", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }));
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("promoted");
  });

  test("US-005 AC3 invokes gh pr edit and returns already-ready for a non-draft", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: false, url: "https://gh/pr/3" }));
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "finish-title", "finish-body");
    expect(r.status).toBe("already-ready");
    expect(calls.some((c) => c.join(" ") === "gh pr edit feat/x --title finish-title --body finish-body")).toBe(true);
  });

  test("US-005 AC4 invokes gh pr create with the received title/body and returns opened", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) return ok("https://gh/pr/9");
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "finish-title", "finish-body");
    expect(r.status).toBe("opened");
    const create = calls.find((c) => c.includes("create"));
    expect(create).toBeDefined();
    expect(create).toEqual(expect.arrayContaining(["--title", "finish-title", "--body", "finish-body"]));
  });

  test("US-005 AC5 invokes glab mr update with title/description for a gitlab draft", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@gitlab.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gitlab/mr/1" }));
      return ok("");
    };
    await openOrPromotePr("/repo", "feat/x", "finish-title", "finish-body");
    expect(
      calls.some((c) => c.join(" ") === "glab mr update feat/x --title finish-title --description finish-body"),
    ).toBe(true);
  });

  test("US-005 AC6 does not throw and returns promoted with the URL when gh pr edit exits non-zero", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }));
      if (cmd.includes("edit")) return { exitCode: 1, stdout: "", stderr: "not found" };
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("promoted");
    expect(r.url).toBe("https://gh/pr/1");
  });

  test("US-005 AC7 does not throw and preserves promoted status + URL when glab mr update exits non-zero", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@gitlab.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gitlab/mr/1" }));
      // The `--ready` promotion call must still succeed — only the metadata
      // write (`--title`) is allowed to fail here.
      if (cmd.includes("--ready")) return ok("");
      if (cmd.includes("update")) return { exitCode: 1, stdout: "", stderr: "forbidden" };
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("promoted");
    expect(r.url).toBe("https://gitlab/mr/1");
  });

  test("US-005 AC7 does not throw and preserves already-ready status + URL when glab mr update exits non-zero", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@gitlab.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: false, url: "https://gitlab/mr/3" }));
      if (cmd.includes("update")) return { exitCode: 1, stdout: "", stderr: "forbidden" };
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("already-ready");
    expect(r.url).toBe("https://gitlab/mr/3");
  });
});

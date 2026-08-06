import { afterEach, describe, expect, test } from "bun:test";
import { _prDeps, loadFinishPrContext, openOrPromotePr } from "@flows/nax-finish/steps/pr";
import type { FinishInput, RunResult } from "@flows/nax-finish/types";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const originalRun = _prDeps.run;
const originalReadText = _prDeps.readText;
const input = (overrides: Partial<FinishInput> = {}): FinishInput => ({
  feature: "finish-pr-body",
  workdir: "/repo",
  branch: "feat/finish-pr-body",
  prdPath: "/repo/.nax/features/finish-pr-body/prd.json",
  escalateTelegram: false,
  ...overrides,
});
afterEach(() => {
  _prDeps.run = originalRun;
  _prDeps.readText = originalReadText;
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

  test("US-003 never throws when artifact reads reject", async () => {
    _prDeps.readText = async () => {
      throw new Error("unreadable");
    };

    const result = await loadFinishPrContext(input(), { base: "main", gatesRan: [] });

    expect(result.stories).toEqual([]);
    expect(result.outOfScope).toEqual([]);
    expect(result.acceptance).toBeUndefined();
    expect(result.regression).toBeUndefined();
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

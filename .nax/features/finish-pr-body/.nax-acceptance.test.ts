import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowNodeContext } from "acpx/flows";

import flow from "@flows/nax-finish/nax-finish.flow";
import { _gitDeps } from "@flows/nax-finish/steps/git";
import {
  buildFinishBody,
  buildFinishTitle,
  loadFinishPrContext,
  _prBodyDeps,
  type FinishPrContext,
} from "@flows/nax-finish/steps/pr-body";
import { _prDeps, openOrPromotePr } from "@flows/nax-finish/steps/pr";
import { _resultDeps, readRounds, roundsPath } from "@flows/nax-finish/steps/result";
import type { FinishInput, FinishRound, RunResult } from "@flows/nax-finish/types";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });

// ---------------------------------------------------------------------------
// US-001 — the fix-commit SHA on the finish-audit trail
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "init\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

function headSha(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
}

type NodeRun<T> = { run: (ctx: FlowNodeContext) => Promise<T> | T };
const nodeRun = <T>(id: string) => flow.nodes[id] as unknown as NodeRun<T>;

const flowCtxOf = (
  input: FinishInput,
  over: { outputs?: Record<string, unknown>; steps?: { nodeId: string; output?: unknown }[] } = {},
): FlowNodeContext =>
  ({
    input,
    outputs: over.outputs ?? {},
    results: {},
    state: { steps: over.steps ?? [] } as never,
    services: {},
  }) as FlowNodeContext;

describe("US-001: commit_<phase> records the fix-commit SHA", () => {
  test("AC-1: a dirty tree produces committed:true with the round's sha equal to post-commit HEAD", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "nax-finish-ac-repo-"));
    const auditDir = mkdtempSync(join(tmpdir(), "nax-finish-ac-audit-"));
    try {
      initRepo(repoDir);
      writeFileSync(join(repoDir, "changed.txt"), "edit\n");
      const input: FinishInput = {
        feature: "x",
        workdir: repoDir,
        branch: "feat/x",
        prdPath: "prd.json",
        auditDir,
        runId: "r1",
        escalateTelegram: false,
      };
      await nodeRun<{ committed: boolean }>("commit_acceptance").run(flowCtxOf(input));
      const sha = headSha(repoDir);
      const rounds = await readRounds(input);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.committed).toBe(true);
      expect((rounds[0] as FinishRound & { sha?: string }).sha).toBe(sha);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test("AC-2: a clean tree produces committed:false with no sha recorded", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "nax-finish-ac-repo-"));
    const auditDir = mkdtempSync(join(tmpdir(), "nax-finish-ac-audit-"));
    try {
      initRepo(repoDir);
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir }).toString();
      expect(status.trim()).toBe("");
      const input: FinishInput = {
        feature: "x",
        workdir: repoDir,
        branch: "feat/x",
        prdPath: "prd.json",
        auditDir,
        runId: "r2",
        escalateTelegram: false,
      };
      await nodeRun<{ committed: boolean }>("commit_gate").run(flowCtxOf(input));
      const rounds = await readRounds(input);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.committed).toBe(false);
      expect((rounds[0] as FinishRound & { sha?: string }).sha).toBeUndefined();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test("AC-3: readRounds preserves every field, including sha, from a hand-written JSONL line", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "nax-finish-ac-rounds-"));
    try {
      const input: FinishInput = {
        feature: "x",
        workdir: "/unused",
        branch: "b",
        prdPath: "p",
        auditDir,
        runId: "r3",
        escalateTelegram: false,
      };
      const line = { ts: "2024-01-01T00:00:00Z", phase: "implement", attempt: 1, committed: true, sha: "abc123", findings: [] };
      writeFileSync(roundsPath(input), `${JSON.stringify(line)}\n`);
      const rounds = await readRounds(input);
      expect(rounds).toHaveLength(1);
      expect((rounds[0] as unknown as { sha: string }).sha).toBe("abc123");
      expect(rounds[0]).toEqual(line as unknown as FinishRound);
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  describe("AC-4: writeResult embeds every round's sha at result.rounds[i].sha", () => {
    const originalWriteText = _resultDeps.writeText;
    const originalReadText = _resultDeps.readText;
    afterEach(() => {
      _resultDeps.writeText = originalWriteText;
      _resultDeps.readText = originalReadText;
    });

    test("both round shas appear in the serialized result", async () => {
      const input: FinishInput = {
        feature: "x",
        workdir: "/unused",
        branch: "b",
        prdPath: "p",
        auditDir: "/unused-audit",
        runId: "r4",
        escalateTelegram: false,
      };
      const rounds = [
        { ts: "t1", phase: "implement", attempt: 1, committed: true, sha: "sha1", findings: [] },
        { ts: "t2", phase: "verify", attempt: 1, committed: true, sha: "sha2", findings: [] },
      ];
      _resultDeps.readText = async () => `${rounds.map((r) => JSON.stringify(r)).join("\n")}\n`;
      let written = "";
      _resultDeps.writeText = async (_p, s) => {
        written = s;
      };
      const { writeResult } = await import("@flows/nax-finish/steps/result");
      await writeResult(input, { feature: "x", status: "opened" });
      const parsed = JSON.parse(written);
      expect(parsed.rounds[0].sha).toBe("sha1");
      expect(parsed.rounds[1].sha).toBe("sha2");
    });
  });
});

// ---------------------------------------------------------------------------
// US-002 — buildFinishTitle / buildFinishBody (pure)
// ---------------------------------------------------------------------------

const baseCtx = (): FinishPrContext => ({
  feature: "f",
  stories: [],
  outOfScope: [],
  gatesRan: [],
  rounds: [],
  run: {},
});
const withCtx = (over: Partial<FinishPrContext>): FinishPrContext => ({ ...baseCtx(), ...over });

describe("US-002: buildFinishTitle / buildFinishBody", () => {
  test("AC-5: buildFinishTitle returns the conventional-commit feat: prefix", () => {
    expect(buildFinishTitle(withCtx({ feature: "my-feature" }))).toBe("feat: my-feature");
  });

  test("AC-6: buildFinishBody renders one table row per story with id/title/acCount", () => {
    const body = buildFinishBody(
      withCtx({
        stories: [
          { id: "s1", title: "t", acCount: 2 },
          { id: "s2", title: "u", acCount: 3 },
        ],
      }),
    );
    expect(body).toContain("| s1 | t | 2 |");
    expect(body).toContain("| s2 | u | 3 |");
  });

  test("AC-7: a pipe in a story title is escaped, not treated as a column separator", () => {
    const body = buildFinishBody(withCtx({ stories: [{ id: "s1", title: "foo|bar", acCount: 1 }] }));
    const row = body.split("\n").find((l) => l.trim().startsWith("| s1"));
    expect(row).toBeDefined();
    expect(row).toContain("foo\\|bar");
    const columnCount = (row as string).replace(/\\\|/g, "").split("|").length - 2;
    expect(columnCount).toBe(3);
  });

  test("AC-8: buildFinishBody reports the acceptance status under Verification", () => {
    const body = buildFinishBody(withCtx({ acceptance: "passed" }));
    expect(body).toContain("Verification");
    expect(body).toContain("passed");
  });

  test("AC-9: buildFinishBody reports the regression status under Verification", () => {
    const body = buildFinishBody(withCtx({ regression: "all green" }));
    expect(body).toContain("Verification");
    expect(body).toContain("all green");
  });

  test("AC-10: buildFinishBody lists every gate name that ran, in the Verification section", () => {
    const body = buildFinishBody(withCtx({ gatesRan: ["lint", "typecheck", "test"] }));
    const section = body.slice(body.indexOf("Verification"));
    expect(section).toContain("lint");
    expect(section).toContain("typecheck");
    expect(section).toContain("test");
  });

  test("AC-11: buildFinishBody includes the diffstat output verbatim", () => {
    expect(buildFinishBody(withCtx({ diffstat: "+100 -50" }))).toContain("+100 -50");
  });

  test("AC-12: a round heading names both its phase and attempt number", () => {
    const body = buildFinishBody(
      withCtx({
        rounds: [{ phase: "implement", attempt: 1, committed: true, findings: [], ts: "t" } as unknown as FinishRound],
      }),
    );
    const heading = body.split("\n").find((l) => l.trim().startsWith("#") && l.includes("implement"));
    expect(heading).toBeDefined();
    expect(heading).toMatch(/1/);
  });

  test("AC-13: a round's findings render as bullets with severity and title", () => {
    const body = buildFinishBody(
      withCtx({
        rounds: [
          {
            phase: "quality",
            attempt: 1,
            committed: true,
            findings: [{ severity: "HIGH", title: "Memory leak", problem: "p", fix: "f" }],
            ts: "t",
          } as unknown as FinishRound,
        ],
      }),
    );
    const bullet = body.split("\n").find((l) => l.trim().startsWith("-") && l.includes("Memory leak"));
    expect(bullet).toBeDefined();
    expect(bullet).toContain("HIGH");
  });

  test("AC-14: a committed round's heading includes the first 7 characters of its fix-commit sha", () => {
    const body = buildFinishBody(
      withCtx({
        rounds: [
          { phase: "quality", attempt: 1, committed: true, sha: "abc123def456abc", findings: [], ts: "t" } as unknown as FinishRound,
        ],
      }),
    );
    expect(body).toContain("abc123d");
  });

  test("AC-15: an uncommitted round's section carries no 7-character sha substring", () => {
    const body = buildFinishBody(
      withCtx({
        rounds: [{ phase: "quality", attempt: 1, committed: false, findings: [], ts: "t" } as unknown as FinishRound],
      }),
    );
    const idx = body.indexOf("quality");
    const section = idx >= 0 ? body.slice(idx) : body;
    expect(/\b[0-9a-f]{7}\b/i.test(section)).toBe(false);
  });

  test("AC-16: no rounds means no Review rounds heading at all", () => {
    const body = buildFinishBody(withCtx({ rounds: [] }));
    expect(body).not.toContain("Review rounds");
    expect(body).not.toContain("## Review");
  });

  test("AC-17: out-of-scope entries render as one bullet each, content unchanged", () => {
    const body = buildFinishBody(withCtx({ outOfScope: ["item1", "item2"] }));
    const bullets = body.split("\n").filter((l) => /^[-*]\s+item[12]\s*$/.test(l.trim()));
    expect(bullets).toHaveLength(2);
    expect(bullets.some((l) => l.trim().endsWith("item1"))).toBe(true);
    expect(bullets.some((l) => l.trim().endsWith("item2"))).toBe(true);
  });

  test("AC-18: an empty out-of-scope list omits the Out of scope heading", () => {
    expect(buildFinishBody(withCtx({ outOfScope: [] }))).not.toContain("Out of scope");
  });

  test("AC-19: the footer reports the stories-passed ratio and formatted duration", () => {
    const body = buildFinishBody(withCtx({ run: { storiesPassed: 5, storiesTotal: 7, durationMs: 125000 } }));
    expect(body).toContain("5/7 stories · 2m 5s");
  });
});

// ---------------------------------------------------------------------------
// US-003 / US-004 — loadFinishPrContext
// ---------------------------------------------------------------------------

describe("US-003/US-004: loadFinishPrContext", () => {
  const originalReadText = _prBodyDeps.readText;
  const originalRun = _prBodyDeps.run;
  const originalResultReadText = _resultDeps.readText;
  afterEach(() => {
    _prBodyDeps.readText = originalReadText;
    _prBodyDeps.run = originalRun;
    _resultDeps.readText = originalResultReadText;
  });

  const INPUT: FinishInput = {
    feature: "x",
    workdir: "/workdir",
    branch: "b",
    prdPath: "prd.json",
    escalateTelegram: false,
  };

  const PRD_FIXTURE = {
    userStories: [
      { id: "US-001", title: "First", acceptanceCriteria: ["a", "b"] },
      { id: "US-002", title: "Second", acceptanceCriteria: ["a", "b", "c"] },
    ],
    outOfScope: ["not this", "not that"],
  };
  const STATUS_FIXTURE = {
    postRun: { acceptance: { status: "passed" }, regression: { status: "failed" } },
    durationMs: 12345,
    progress: { passed: 5, total: 10 },
  };

  const mockArtifacts = (opts: { prdFails?: boolean; statusFails?: boolean } = {}) => {
    const readCalls: string[] = [];
    _prBodyDeps.readText = async (path: string) => {
      readCalls.push(path);
      if (path.includes("status.json")) return opts.statusFails ? null : JSON.stringify(STATUS_FIXTURE);
      return opts.prdFails ? null : JSON.stringify(PRD_FIXTURE);
    };
    _prBodyDeps.run = async () => ok("");
    _resultDeps.readText = async () => null;
    return readCalls;
  };

  test("AC-20: context.stories mirrors the PRD's story id/title/AC-count", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.stories).toHaveLength(2);
    expect(ctx.stories[0]).toMatchObject({ id: "US-001", title: "First", acCount: 2 });
    expect(ctx.stories[1]).toMatchObject({ id: "US-002", title: "Second", acCount: 3 });
  });

  test("AC-21: context.outOfScope carries the PRD's outOfScope array", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.outOfScope).toEqual(PRD_FIXTURE.outOfScope);
  });

  test("AC-22: context.feature mirrors the flow input's feature", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext({ ...INPUT, feature: "my-feature" }, { base: "origin/main", gatesRan: [] });
    expect(ctx.feature).toBe("my-feature");
  });

  test("AC-23: an absolute prdPath resolves status.json as its sibling", async () => {
    const calls = mockArtifacts();
    await loadFinishPrContext({ ...INPUT, prdPath: "/path/to/prd.json", workdir: "/path/to" }, { base: "origin/main", gatesRan: [] });
    expect(calls).toContain("/path/to/status.json");
  });

  test("AC-24: a relative prdPath resolves status.json against workdir, not process.cwd", async () => {
    const calls = mockArtifacts();
    await loadFinishPrContext({ ...INPUT, prdPath: "prd.json", workdir: "/workdir" }, { base: "origin/main", gatesRan: [] });
    expect(calls).toContain("/workdir/status.json");
    expect(calls).not.toContain("./status.json");
  });

  test("AC-25: context.acceptance mirrors status.json's postRun.acceptance.status", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.acceptance).toBe("passed");
  });

  test("AC-26: context.regression mirrors status.json's postRun.regression.status", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.regression).toBe("failed");
  });

  test("AC-27: context.run.durationMs mirrors status.json's durationMs", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.run.durationMs).toBe(12345);
  });

  test("AC-28: context.run.storiesPassed mirrors status.json's progress.passed", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.run.storiesPassed).toBe(5);
  });

  test("AC-29: context.run.storiesTotal mirrors status.json's progress.total", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.run.storiesTotal).toBe(10);
  });

  test("AC-30: a non-existent prdPath does not throw and yields empty stories/outOfScope", async () => {
    mockArtifacts({ prdFails: true });
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.stories).toEqual([]);
    expect(ctx.outOfScope).toEqual([]);
  });

  test("AC-31: an invalid-JSON prdPath does not throw and yields empty stories/outOfScope", async () => {
    mockArtifacts();
    _prBodyDeps.readText = async (path: string) => (path.includes("status.json") ? JSON.stringify(STATUS_FIXTURE) : "{not valid json");
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.stories).toEqual([]);
    expect(ctx.outOfScope).toEqual([]);
  });

  test("AC-32: a missing status.json does not throw and leaves acceptance/regression undefined", async () => {
    mockArtifacts({ statusFails: true });
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.acceptance).toBeUndefined();
    expect(ctx.regression).toBeUndefined();
  });

  test("AC-33: an invalid-JSON status.json does not throw and leaves acceptance/regression undefined", async () => {
    mockArtifacts();
    _prBodyDeps.readText = async (path: string) => (path.includes("status.json") ? "{not valid json" : JSON.stringify(PRD_FIXTURE));
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.acceptance).toBeUndefined();
    expect(ctx.regression).toBeUndefined();
  });

  test("AC-34: context.rounds mirrors readRounds' output, sha included, in order", async () => {
    mockArtifacts();
    const rounds = [
      { ts: "t1", phase: "spec", attempt: 1, committed: true, sha: "abc123", findings: [] },
      { ts: "t2", phase: "quality", attempt: 1, committed: true, sha: "def456", findings: [] },
    ];
    _resultDeps.readText = async () => `${rounds.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.rounds).toHaveLength(2);
    expect((ctx.rounds[0] as unknown as { sha: string }).sha).toBe("abc123");
    expect((ctx.rounds[1] as unknown as { sha: string }).sha).toBe("def456");
  });

  test("AC-35: context.gatesRan mirrors the caller-supplied gate names", async () => {
    mockArtifacts();
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: ["quality_gate_1", "security_gate"] });
    expect(ctx.gatesRan).toEqual(["quality_gate_1", "security_gate"]);
  });

  test("AC-36: the diffstat is fetched via git diff --stat <base>...HEAD", async () => {
    mockArtifacts();
    const calls: string[][] = [];
    _prBodyDeps.run = async (cmd) => {
      calls.push(cmd);
      return ok("3 files changed");
    };
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(calls).toContainEqual(["git", "diff", "--stat", "origin/main...HEAD"]);
    expect(ctx.diffstat).toBe("3 files changed");
  });

  test("AC-37: diffstat equals the diff command's stdout on success", async () => {
    mockArtifacts();
    _prBodyDeps.run = async () => ok("10 files changed, 5 insertions(+), 3 deletions(-)");
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.diffstat).toBe("10 files changed, 5 insertions(+), 3 deletions(-)");
  });

  test("AC-38: a non-zero or rejected diff leaves diffstat undefined without throwing", async () => {
    mockArtifacts();
    _prBodyDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "fatal: bad revision" });
    const ctxNonZero = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctxNonZero.diffstat).toBeUndefined();

    _prBodyDeps.run = async () => {
      throw new Error("spawn failed");
    };
    const ctxRejected = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctxRejected.diffstat).toBeUndefined();
  });

  test("AC-39: an unreadable audit trail leaves rounds empty without throwing", async () => {
    mockArtifacts();
    _resultDeps.readText = async () => null; // readRounds' own ENOENT-as-absent contract
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.rounds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// US-005 — openOrPromotePr writes finish metadata on every forge path
// ---------------------------------------------------------------------------

describe("US-005: openOrPromotePr writes title/body on every forge path", () => {
  const originalRun = _prDeps.run;
  afterEach(() => {
    _prDeps.run = originalRun;
  });

  test("AC-40 & AC-41: promoting a GitHub draft runs gh pr ready then gh pr edit, and reports promoted", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }));
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "My Title", "My Body");
    expect(r.status).toBe("promoted");
    expect(r.url).toBe("https://gh/pr/1");
    const readyIdx = calls.findIndex((c) => c.includes("ready"));
    const editIdx = calls.findIndex((c) => c.includes("edit"));
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(editIdx).toBeGreaterThan(readyIdx);
    expect(calls[editIdx]).toEqual(["gh", "pr", "edit", "feat/x", "--title", "My Title", "--body", "My Body"]);
  });

  test("AC-42: a non-draft GitHub PR gets edited and reports already-ready", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: false, url: "https://gh/pr/3" }));
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "My Title", "My Body");
    expect(r.status).toBe("already-ready");
    expect(r.url).toBe("https://gh/pr/3");
    expect(calls.some((c) => c.join(" ") === "gh pr edit feat/x --title My Title --body My Body")).toBe(true);
  });

  test("AC-43: no existing PR opens one via gh pr create and reports opened", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) return ok("https://gh/pr/2");
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "My Title", "My Body");
    expect(r.status).toBe("opened");
    expect(r.url).toBe("https://gh/pr/2");
    expect(calls.some((c) => c.includes("create") && c.includes("My Title"))).toBe(true);
  });

  test("AC-44: a draft GitLab MR gets promoted via glab mr update with title/description", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@gitlab.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gitlab.com/mr/1" }));
      return ok("");
    };
    await openOrPromotePr("/repo", "feat/x", "My Title", "My Body");
    expect(calls.some((c) => c.join(" ") === "glab mr update feat/x --title My Title --description My Body")).toBe(true);
  });

  test("AC-45: a non-zero gh pr edit is caught and does not stop promotion", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }));
      if (cmd.includes("edit")) return { exitCode: 1, stdout: "", stderr: "conflict" };
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "My Title", "My Body");
    expect(r.status).toBe("promoted");
    expect(r.url).toBe("https://gh/pr/1");
  });

  test("AC-46: a non-zero glab mr update is caught and does not stop promotion/already-ready", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@gitlab.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: false, url: "https://gitlab.com/mr/2" }));
      if (cmd.includes("update")) return { exitCode: 1, stdout: "", stderr: "locked" };
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "My Title", "My Body");
    expect(["promoted", "already-ready"]).toContain(r.status);
    expect(r.url).toBe("https://gitlab.com/mr/2");
  });
});

// ---------------------------------------------------------------------------
// US-005 — the open_pr flow node's wiring and fallback behaviour
//
// buildFinishTitle/buildFinishBody are pure and take no I/O of their own, so
// the only way open_pr can fall back around a builder throwing (AC-51) is a
// dedicated test seam — spec.md's own S2 traceability note says US-005
// "declares behavioural seam ACs that stub each builder". This mirrors the
// `_gitDeps` / `_resultDeps` / `_prDeps` injectable-dependency convention used
// by every other step in this module.
// ---------------------------------------------------------------------------

type PrBodyBuilderDeps = {
  buildFinishTitle: typeof buildFinishTitle;
  buildFinishBody: typeof buildFinishBody;
};
const builderDeps = _prBodyDeps as unknown as PrBodyBuilderDeps;

describe("US-005: the open_pr node builds and forwards finish PR metadata", () => {
  const originalPrRun = _prDeps.run;
  const originalGitRun = _gitDeps.run;
  const originalAppend = _resultDeps.appendText;
  const originalWrite = _resultDeps.writeText;
  const originalResultReadText = _resultDeps.readText;
  const originalBodyReadText = _prBodyDeps.readText;
  const originalBodyRun = _prBodyDeps.run;
  const originalBuildTitle = builderDeps.buildFinishTitle;
  const originalBuildBody = builderDeps.buildFinishBody;

  afterEach(() => {
    _prDeps.run = originalPrRun;
    _gitDeps.run = originalGitRun;
    _resultDeps.appendText = originalAppend;
    _resultDeps.writeText = originalWrite;
    _resultDeps.readText = originalResultReadText;
    _prBodyDeps.readText = originalBodyReadText;
    _prBodyDeps.run = originalBodyRun;
    builderDeps.buildFinishTitle = originalBuildTitle;
    builderDeps.buildFinishBody = originalBuildBody;
  });

  const INPUT: FinishInput = {
    feature: "x",
    workdir: "/repo",
    branch: "feat/x",
    prdPath: "p",
    auditDir: "/audit",
    runId: "r",
    escalateTelegram: false,
  };

  const wireHappyDeps = () => {
    _gitDeps.run = async () => ok("");
    _resultDeps.appendText = async () => {};
    _resultDeps.writeText = async () => {};
    _resultDeps.readText = async () => null;
    _prBodyDeps.readText = async () => null;
    _prBodyDeps.run = async () => ok("");
  };

  const openPrCalls = () => {
    const calls: { title: string; body: string }[] = [];
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr" };
      if (cmd.includes("create")) {
        const titleIdx = cmd.indexOf("--title");
        const bodyIdx = cmd.indexOf("--body");
        calls.push({ title: cmd[titleIdx + 1] ?? "", body: cmd[bodyIdx + 1] ?? "" });
        return ok("https://gh/pr/9");
      }
      return ok("");
    };
    return calls;
  };

  const openPrCtx = (over: { outputs?: Record<string, unknown> } = {}): FlowNodeContext =>
    flowCtxOf(INPUT, {
      outputs: { load_ctx: { route: "proceed", base: "origin/main" }, quality_gates: { ran: ["lint"] }, ...over.outputs },
    });

  const runOpenPr = () => nodeRun<{ route: string; status?: string }>("open_pr").run(openPrCtx());

  test("AC-47: a stubbed buildFinishTitle's return value reaches openOrPromotePr", async () => {
    wireHappyDeps();
    const calls = openPrCalls();
    builderDeps.buildFinishTitle = () => "stubbed-title";
    await runOpenPr();
    expect(calls[0]?.title).toBe("stubbed-title");
  });

  test("AC-48: a stubbed buildFinishBody's return value reaches openOrPromotePr", async () => {
    wireHappyDeps();
    const calls = openPrCalls();
    builderDeps.buildFinishBody = () => "stubbed-body";
    await runOpenPr();
    expect(calls[0]?.body).toBe("stubbed-body");
  });

  test("AC-49: a nothing-to-finish route returns before loading finish-PR context", async () => {
    wireHappyDeps();
    let readTextCalled = false;
    _prBodyDeps.readText = async () => {
      readTextCalled = true;
      return null;
    };
    const out = await nodeRun<{ route: string; status?: string }>("open_pr").run(
      openPrCtx({ outputs: { load_ctx: { route: "nothing-to-finish" } } }),
    );
    expect(readTextCalled).toBe(false);
    expect(out.status).toBe("nothing-to-finish");
  });

  test("AC-50: when loadFinishPrContext throws, open_pr still opens the PR with the fallback title", async () => {
    wireHappyDeps();
    _prBodyDeps.readText = (() => {
      throw new Error("boom");
    }) as unknown as typeof _prBodyDeps.readText;
    const calls = openPrCalls();
    await runOpenPr();
    expect(calls[0]?.title).toBe("nax-finish: x");
  });

  test("AC-51: when a builder throws, open_pr falls back to the literal title and body", async () => {
    wireHappyDeps();
    let calls = openPrCalls();
    builderDeps.buildFinishTitle = () => {
      throw new Error("boom");
    };
    await runOpenPr();
    expect(calls[0]?.title).toBe("nax-finish: x");
    expect(calls[0]?.body).toBe("Automated finish of `x`.");

    builderDeps.buildFinishTitle = originalBuildTitle;
    calls = openPrCalls();
    builderDeps.buildFinishBody = () => {
      throw new Error("boom");
    };
    await runOpenPr();
    expect(calls[0]?.title).toBe("nax-finish: x");
    expect(calls[0]?.body).toBe("Automated finish of `x`.");
  });
});
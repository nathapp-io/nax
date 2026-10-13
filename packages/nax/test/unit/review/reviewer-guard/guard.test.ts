import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { RestoreReport } from "@/review/reviewer-guard";
import { _reviewerGuardDeps, REVIEWER_SESSION_ROLES, ReviewerTreeGuard } from "@/review/reviewer-guard";
import type { SessionDescriptor, SessionRole } from "@/session";

const saved = { ..._reviewerGuardDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_reviewerGuardDeps, saved);
  resetLogger();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function desc(role: SessionRole, id: string = role, workdir = "/repo/pkg"): SessionDescriptor {
  return {
    id,
    role,
    state: "RUNNING",
    agent: "claude",
    workdir,
    storyId: "US-001",
    protocolIds: { recordId: null, sessionId: null },
    completedStages: [],
    createdAt: "",
    lastActivityAt: "",
  };
}

const CLEAN: RestoreReport = { paths: [], indexRestored: false, headRestored: false, stashesDropped: 0, failures: [] };

function fakes(report: RestoreReport = CLEAN) {
  const calls: string[] = [];
  _reviewerGuardDeps.toplevel = async () => "/repo";
  _reviewerGuardDeps.take = async () => {
    calls.push("take");
    return {
      toplevel: "/repo",
      tree: "t",
      indexTree: "i",
      head: "h",
      symbolicHead: "refs/heads/main",
      refs: [],
      stashes: [],
    };
  };
  _reviewerGuardDeps.restore = async () => {
    calls.push("restore");
    return report;
  };
  return calls;
}

function captureLogs(): LogEntry[] {
  resetLogger();
  initLogger({ level: "silent", suppressConsole: true });
  const entries: LogEntry[] = [];
  addSink((e) => {
    if (e.level === "warn") entries.push(e);
  });
  return entries;
}

describe("ReviewerTreeGuard (nax#2500)", () => {
  test("the role set is the seven reviewer roles", () => {
    expect([...REVIEWER_SESSION_ROLES].sort()).toEqual([
      "finish-review-quality",
      "finish-review-spec",
      "reviewer-adversarial",
      "reviewer-semantic",
      "wf-branch-review",
      "wf-rereview",
      "wf-story-review",
    ]);
  });

  test("non-reviewer roles are untouched", async () => {
    const calls = fakes();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("implementer"));
    await g.afterTurn(desc("implementer"));
    expect(calls).toEqual([]);
  });

  test("one reviewer: take then restore", async () => {
    const calls = fakes();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("wf-branch-review"));
    await g.afterTurn(desc("wf-branch-review"));
    expect(calls).toEqual(["take", "restore"]);
  });

  test("two concurrent reviewers on one repo: one snapshot, restored once by the last out", async () => {
    const calls = fakes();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("finish-review-spec", "a"));
    await g.beforeTurn(desc("finish-review-quality", "b", "/repo"));
    await g.afterTurn(desc("finish-review-spec", "a"));
    expect(calls).toEqual(["take"]);
    await g.afterTurn(desc("finish-review-quality", "b", "/repo"));
    expect(calls).toEqual(["take", "restore"]);
  });

  test("a failing snapshot or restore never throws", async () => {
    fakes();
    _reviewerGuardDeps.take = async () => {
      throw new Error("git gone");
    };
    const g = new ReviewerTreeGuard();
    await expect(g.beforeTurn(desc("wf-story-review"))).resolves.toBeUndefined();
    await expect(g.afterTurn(desc("wf-story-review"))).resolves.toBeUndefined();
  });

  test("a throwing restore never throws", async () => {
    fakes();
    _reviewerGuardDeps.restore = async () => {
      throw new Error("restore boom");
    };
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("wf-story-review"));
    await expect(g.afterTurn(desc("wf-story-review"))).resolves.toBeUndefined();
  });

  test("a beforeTurn during an in-flight restore waits for it before taking a new snapshot", async () => {
    const calls = fakes();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    _reviewerGuardDeps.restore = async () => {
      calls.push("restore-start");
      await gate;
      calls.push("restore-end");
      return CLEAN;
    };
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("wf-story-review", "a"));
    const out = g.afterTurn(desc("wf-story-review", "a"));
    await Bun.sleep(10);
    const next = g.beforeTurn(desc("wf-rereview", "b"));
    await Bun.sleep(20);
    expect(calls).toEqual(["take", "restore-start"]);
    release();
    await out;
    await next;
    expect(calls).toEqual(["take", "restore-start", "restore-end", "take"]);
  });

  test("the same id registered twice restores once after a single afterTurn", async () => {
    const calls = fakes();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("wf-story-review", "a"));
    await g.beforeTurn(desc("wf-story-review", "a"));
    await g.afterTurn(desc("wf-story-review", "a"));
    expect(calls).toEqual(["take", "restore"]);
  });

  test("afterTurn without a matching beforeTurn is a no-op", async () => {
    const calls = fakes();
    await new ReviewerTreeGuard().afterTurn(desc("wf-story-review"));
    expect(calls).toEqual([]);
  });

  test("a clean restore logs nothing", async () => {
    fakes();
    const logs = captureLogs();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("wf-story-review"));
    await g.afterTurn(desc("wf-story-review"));
    expect(logs).toEqual([]);
  });

  test("a reverted tree logs reviewer-tree-reverted with paths and failures", async () => {
    fakes({ ...CLEAN, paths: ["a.txt"], failures: [] });
    const logs = captureLogs();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("wf-story-review"));
    await g.afterTurn(desc("wf-story-review"));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("reviewer-tree-reverted");
    expect(logs[0]?.data).toMatchObject({ storyId: "US-001", role: "wf-story-review", paths: ["a.txt"], failures: [] });
  });

  test("restore failures count as touched and log a separate WARN", async () => {
    fakes({ ...CLEAN, failures: ["tree: boom"] });
    const logs = captureLogs();
    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("wf-story-review"));
    await g.afterTurn(desc("wf-story-review"));
    const reverted = logs.find((e) => e.message === "reviewer-tree-reverted");
    expect(reverted?.data).toMatchObject({ failures: ["tree: boom"] });
    expect(logs.some((e) => e.message.includes("[WARN]") && e.message.includes("restore"))).toBe(true);
  });
});

describe("ReviewerTreeGuard with a real repository", () => {
  test("an edit between two reviewers' beforeTurn is reverted by the last one out", async () => {
    const d = await mkdtemp(join(tmpdir(), "nax-rguard-g-"));
    dirs.push(d);
    const run = async (...args: string[]) => {
      const p = Bun.spawn(["git", ...args], {
        cwd: d,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
      await p.exited;
    };
    await run("init", "-q", "-b", "main");
    await writeFile(join(d, "a.txt"), "a\n");
    await run("add", "-A");
    await run("commit", "-q", "-m", "seed");

    const g = new ReviewerTreeGuard();
    await g.beforeTurn(desc("finish-review-spec", "a", d));
    await writeFile(join(d, "a.txt"), "edited\n");
    await g.beforeTurn(desc("finish-review-quality", "b", d));
    await g.afterTurn(desc("finish-review-spec", "a", d));
    await g.afterTurn(desc("finish-review-quality", "b", d));
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
  });
});

/**
 * Finish A 4.5: `finalizeDraftPr` after a stop. A set-aside whose restore failed and left the tree dirty
 * is set aside again (with that fix session's base) instead of committed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext, withTempDir } from "@test/helpers";
import { _finishGitDeps, _setAsideDeps, createFinishOps, createFinishState } from "@/finish";
import type { ForgeDeps } from "@/forge";

const originalGit = _finishGitDeps.git;
afterEach(() => {
  _finishGitDeps.git = originalGit;
});

function freshState() {
  return createFinishState({
    feature: "demo",
    workdir: "/repo",
    branch: "feat/demo",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/demo/spec.md",
  });
}

function baseDeps() {
  const forge: ForgeDeps = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readText: async () => null };
  return {
    deps: {
      callCtx: makeMockCallContext(),
      forge,
      forgeKind: "github" as const,
      audit: { auditDir: "/tmp/audit", runId: "run-1" },
    },
  };
}

describe("finalizeDraftPr after a stop (finish A 4.5)", () => {
  type GitOut = { exitCode: number; stdout: string; stderr: string };
  const out = (stdout = "", exitCode = 0, stderr = ""): GitOut => ({ exitCode, stdout, stderr });

  function stubDirtyGit(calls: string[][], dirty: { value: boolean }, restoreFails = false): void {
    const answers: Record<string, (args: string[]) => GitOut> = {
      status: () => out(dirty.value ? " M a.ts\n?? new.ts\n" : ""),
      restore: () => {
        if (restoreFails) return out("", 1, "restore failed");
        dirty.value = false;
        return out();
      },
      "rev-parse": () => out("sha1\n"),
      diff: (args) => {
        if (args.includes("--name-only")) return out(dirty.value ? "a.ts\0" : "");
        return out("", args.includes("--cached") && dirty.value ? 1 : 0);
      },
    };
    _finishGitDeps.git = async (args: string[]) => {
      calls.push(args);
      const sub = args.find((a) => a !== "--literal-pathspecs") ?? "";
      return answers[sub]?.(args) ?? out();
    };
  }

  test("a restore-failed set-aside: the remaining dirt is set aside with the recorded untrackedBefore, not committed", async () => {
    await withTempDir(async (dir) => {
      const { deps } = baseDeps();
      const calls: string[][] = [];
      stubDirtyGit(calls, { value: true }, true); // the restore keeps failing: the tree stays dirty
      const removed: string[] = [];
      const originalRemove = _setAsideDeps.remove;
      _setAsideDeps.remove = async (p) => void removed.push(p);
      try {
        const state = {
          ...freshState(),
          stops: [{ kind: "flow" as const, step: "review" as const, at: "t", limitMs: 1 }],
          handoffs: [
            {
              n: 1,
              dir: `${dir}/h1`,
              phase: "review" as const,
              limit: "flow" as const,
              baseSha: "sha1",
              headSha: "sha1",
              findingIds: [],
              newUntracked: [],
              changedPaths: ["a.ts"],
              stoppedAt: "t",
              hasNote: false,
              patchSaved: true,
              restored: false,
              consumed: false,
              untrackedRestored: [],
              untrackedMovedAside: [],
              untrackedFailed: [],
              base: { baseSha: "sha1", headSha: "sha1", untrackedBefore: ["new.ts"] },
            },
          ],
        };
        const out = await createFinishOps({
          ...deps,
          forgeKind: null,
          audit: { auditDir: dir, runId: "run-1" },
        }).finalizeDraftPr(state);
        expect(out.status).toBe("local-only");
        expect(calls.some((a) => a[0] === "commit")).toBe(false);
        expect(calls.some((a) => a[0] === "push")).toBe(true);
        expect(state.handoffs).toHaveLength(2);
        expect(state.handoffs[1]?.restored).toBe(false);
        expect(removed).toEqual([]); // new.ts existed before the session: never deleted
      } finally {
        _setAsideDeps.remove = originalRemove;
      }
    });
  });

  test("when the failed restore is repaired by the extra set-aside, the tree is clean and nothing is committed", async () => {
    await withTempDir(async (dir) => {
      const { deps } = baseDeps();
      const calls: string[][] = [];
      stubDirtyGit(calls, { value: true });
      const state = { ...freshState(), handoffs: [record(dir, false)] };

      await createFinishOps({ ...deps, forgeKind: null, audit: { auditDir: dir, runId: "run-1" } }).finalizeDraftPr(
        state,
      );
      expect(state.handoffs).toHaveLength(2);
      expect(calls.some((a) => a[0] === "commit")).toBe(false);
    });
  });

  const record = (dir: string, restored: boolean) => ({
    n: 1,
    dir: `${dir}/h1`,
    phase: "review" as const,
    limit: "fix" as const,
    baseSha: "sha1",
    headSha: "sha1",
    findingIds: [],
    newUntracked: [],
    changedPaths: [],
    stoppedAt: "t",
    hasNote: false,
    patchSaved: true,
    restored,
    consumed: false,
    untrackedRestored: [],
    untrackedMovedAside: [],
    untrackedFailed: [],
    base: { baseSha: "sha1", headSha: "sha1", untrackedBefore: [] },
  });

  test("a restored set-aside with a recorded base does not trigger another: the dirt is committed", async () => {
    await withTempDir(async (dir) => {
      const { deps } = baseDeps();
      const calls: string[][] = [];
      stubDirtyGit(calls, { value: true });
      const state = { ...freshState(), handoffs: [record(dir, true)] };
      await createFinishOps({ ...deps, forgeKind: null, audit: { auditDir: dir, runId: "run-1" } }).finalizeDraftPr(
        state,
      );
      expect(state.handoffs).toHaveLength(1);
      expect(calls.some((a) => a[0] === "commit")).toBe(true);
    });
  });

  test("a failed restore on a tree that is clean now sets nothing more aside", async () => {
    await withTempDir(async (dir) => {
      const { deps } = baseDeps();
      stubDirtyGit([], { value: false });
      const state = { ...freshState(), handoffs: [record(dir, false)] };
      await createFinishOps({ ...deps, forgeKind: null, audit: { auditDir: dir, runId: "run-1" } }).finalizeDraftPr(
        state,
      );
      expect(state.handoffs).toHaveLength(1);
    });
  });

  test("a failed handoff with no recorded base fails closed: nothing committed, the draft says so", async () => {
    await withTempDir(async (dir) => {
      const { deps } = baseDeps();
      const calls: string[][] = [];
      stubDirtyGit(calls, { value: true });
      const { base: _omitted, ...noBase } = record(dir, false);
      const state = { ...freshState(), handoffs: [noBase] };
      await createFinishOps({ ...deps, forgeKind: null, audit: { auditDir: dir, runId: "run-1" } }).finalizeDraftPr(
        state,
      );
      expect(calls.some((a) => a[0] === "commit")).toBe(false);
      expect(calls.some((a) => a[0] === "push")).toBe(true);
      expect(state.handoffs).toHaveLength(1);
      expect(state.reason).toContain("uncommitted changes left in the worktree");
    });
  });

  test("without a failed restore, a dirty tree is committed as before", async () => {
    const { deps } = baseDeps();
    const calls: string[][] = [];
    stubDirtyGit(calls, { value: true });
    const state = {
      ...freshState(),
      stops: [{ kind: "fix" as const, phase: "review" as const, at: "t", limitMs: 1, handoff: 1 }],
    };
    await createFinishOps({ ...deps, forgeKind: null }).finalizeDraftPr(state);
    expect(calls.some((a) => a[0] === "commit")).toBe(true);
  });
});

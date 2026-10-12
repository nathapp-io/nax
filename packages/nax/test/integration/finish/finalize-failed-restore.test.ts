/**
 * Finish A 4.5, real git: a restore-failed session's half-edit must be set aside at finalize with THAT
 * session's base, even when a later session folded the half-edit into its own base.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, makeFinishOps, makeFinishState, makeMockCallContext, withTempDir } from "@test/helpers";
import { createFinishOps } from "@/finish";
import { runFixStep } from "@/finish/fix-step";
import { restorePendingNumbers } from "@/finish/handoff-state";
import type { ForgeDeps } from "@/forge";
import { failGit, git, now, withRepo } from "./set-aside-fixture";

const forge: ForgeDeps = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readText: async () => null };
const finding = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };
const HALF = "export const a = 'half edit';\n";

async function withRemote(dir: string, fn: (branch: string) => Promise<void>): Promise<void> {
  await withTempDir(async (remote) => {
    await git(remote, "init", "-q", "--bare");
    await git(dir, "remote", "add", "origin", remote);
    await fn((await git(dir, "branch", "--show-current")).trim());
  });
}

/** Session 1 edits a.ts then throws while `git restore` is failing: its restore fails and leaves the half-edit. */
async function failedSession(
  dir: string,
  audit: { auditDir: string; runId: string },
  state: ReturnType<typeof makeFinishState>,
) {
  const ops = makeFinishOps(
    [],
    {},
    {
      fix: async () => {
        await writeFile(join(dir, "a.ts"), HALF);
        throw new Error("agent crashed");
      },
    },
  );
  const undo = failGit((args) => args.includes("restore"));
  try {
    await runFixStep(state, { ops, audit, now }, "review", { findings: [finding] });
  } finally {
    undo();
  }
}

describe("finalizeDraftPr with a restore-failed handoff (real git)", () => {
  test("session 2 sets the half-edit aside before it starts; finalize then has nothing of it left to set aside", async () => {
    await withRepo(async (dir, audit) => {
      await withRemote(dir, async (branch) => {
        await writeFile(join(dir, "u.txt"), "user file\n"); // untracked before session 1
        const state = makeFinishState({ workdir: dir, branch });
        await failedSession(dir, audit, state);
        expect(state.handoffs[0]?.restored).toBe(false);
        expect(await readFile(join(dir, "a.ts"), "utf8")).toBe(HALF);
        // Session 2's guard sets the half-edit aside with session 1's own base, then session 2 does nothing.
        const ops2 = makeFinishOps([], {}, { fix: async () => ({ dispositions: [] }) });
        await runFixStep(state, { ops: ops2, audit, now }, "review", { findings: [finding] });
        expect(state.handoffs).toHaveLength(2);
        expect(state.handoffs[0]?.settledBy).toBe(2);
        expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
        // Session 1's snapshot is settled with it; session 2's own is cleared when its step settles.
        expect(existsSync(join(audit.auditDir, "run-1.fix-base-1"))).toBe(false);

        const head = (await git(dir, "rev-parse", "HEAD")).trim();
        const fin = createFinishOps({ callCtx: makeMockCallContext(), forge, forgeKind: null, audit });
        await fin.finalizeDraftPr(state);

        // Only the user file is swept into the finalize commit (as before); nothing is set aside twice.
        expect(await git(dir, "diff", "--name-only", head, "HEAD")).toBe("u.txt\n");
        expect(await readFile(join(dir, "u.txt"), "utf8")).toBe("user file\n");
        expect(state.handoffs).toHaveLength(2);
        const extra = state.handoffs[1];
        assertDefined(extra, "the leftover handoff");
        expect(extra.restored).toBe(true);
        expect(await readFile(join(extra.dir, "changes.patch"), "utf8")).toContain("half edit");
      });
    });
  });

  test("finalize: a leftover whose patch was not saved stays pending and the reason says the work was lost", async () => {
    await withRepo(async (dir, audit) => {
      await withRemote(dir, async (branch) => {
        const state = makeFinishState({ workdir: dir, branch });
        await failedSession(dir, audit, state);
        const head = (await git(dir, "rev-parse", "HEAD")).trim();
        const fin = createFinishOps({ callCtx: makeMockCallContext(), forge, forgeKind: null, audit });
        const undo = failGit((args) => args.includes("--binary"));
        try {
          await fin.finalizeDraftPr(state);
        } finally {
          undo();
        }
        expect(state.handoffs[0]?.settledBy).toBeUndefined();
        expect(restorePendingNumbers(state.handoffs)).toEqual([1]);
        expect(state.reason).toContain("handoff 1");
        expect(state.reason).toContain("patch was not saved");
        expect((await git(dir, "rev-parse", "HEAD")).trim()).toBe(head);
      });
    });
  });

  test("a fix committed after the failed session is kept; only the half-edit is set aside", async () => {
    await withRepo(async (dir, audit) => {
      await withRemote(dir, async (branch) => {
        const state = makeFinishState({ workdir: dir, branch });
        await failedSession(dir, audit, state);
        // A later fix on another file is committed, with the half-edit riding along in the tree.
        await writeFile(join(dir, "keep.ts"), "export const keep = 'fixed';\n");
        await git(dir, "add", "keep.ts");
        await git(dir, "commit", "-q", "-m", "fix: later");
        const head = (await git(dir, "rev-parse", "HEAD")).trim();

        const fin = createFinishOps({ callCtx: makeMockCallContext(), forge, forgeKind: null, audit });
        await fin.finalizeDraftPr(state);

        expect((await git(dir, "rev-parse", "HEAD")).trim()).toBe(head);
        expect(await readFile(join(dir, "keep.ts"), "utf8")).toBe("export const keep = 'fixed';\n");
        expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
        const extra = state.handoffs[state.handoffs.length - 1];
        assertDefined(extra, "extra handoff");
        expect(extra.n).toBe(2);
        expect(await readFile(join(extra.dir, "changes.patch"), "utf8")).toContain("half edit");
      });
    });
  });

  test("a pre-existing untracked file a later fix committed is never overwritten by the old snapshot", async () => {
    await withRepo(async (dir, audit) => {
      await withRemote(dir, async (branch) => {
        await writeFile(join(dir, "u.txt"), "user file\n"); // untracked before session 1, so snapshotted
        const state = makeFinishState({ workdir: dir, branch });
        await failedSession(dir, audit, state);
        expect(state.handoffs[0]?.base?.untrackedSnapshot?.files.map((f) => f.path)).toEqual(["u.txt"]);
        // A later fix rewrites the file and commits it; the half-edit rides along in the tree.
        await writeFile(join(dir, "u.txt"), "reviewed fix\n");
        await git(dir, "add", "u.txt");
        await git(dir, "commit", "-q", "-m", "fix: later");
        const head = (await git(dir, "rev-parse", "HEAD")).trim();

        const fin = createFinishOps({ callCtx: makeMockCallContext(), forge, forgeKind: null, audit });
        await fin.finalizeDraftPr(state);

        expect(await readFile(join(dir, "u.txt"), "utf8")).toBe("reviewed fix\n");
        expect(await git(dir, "diff", "--name-only", head, "HEAD")).toBe("");
        expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
      });
    });
  });
});

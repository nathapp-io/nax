/** Real git: the audit directory (snapshots, handoffs) can sit inside the repo; it is never user work. */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, makeFinishOps, makeFinishState, withTempDir } from "@test/helpers";
import { commitFixes } from "@/finish/commit";
import { runFixStep } from "@/finish/fix-step";
import { failGit, git, now, repo } from "./set-aside-fixture";

const finding = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

/** A repo whose audit dir is INSIDE it and not ignored (a repo without the nax .gitignore section). */
async function withInRepoAudit(fn: (dir: string, audit: { auditDir: string; runId: string }) => Promise<void>) {
  await withTempDir(async (dir) => {
    await repo(dir);
    const auditDir = join(dir, ".nax", "finish-audit", "feat");
    await mkdir(auditDir, { recursive: true });
    await fn(dir, { auditDir, runId: "run-1" });
  });
}

describe("audit directory inside the repo and not ignored (B5)", () => {
  test("the snapshot is not 'created': the user's edited file is put back, nothing is lost", async () => {
    await withInRepoAudit(async (dir, audit) => {
      await writeFile(join(dir, "u.txt"), "user file\n");
      const state = makeFinishState({ workdir: dir });
      const ops = makeFinishOps(
        [],
        {},
        {
          fix: async () => {
            await writeFile(join(dir, "u.txt"), "edited by the session\n");
            return { interrupted: true };
          },
        },
      );
      const result = await runFixStep(state, { ops, audit, now }, "review", { findings: [finding] });
      expect(result.kind).toBe("stopped");
      const record = state.handoffs[0];
      assertDefined(record, "handoff");
      expect(record.restored).toBe(true);
      expect(record.newUntracked).toEqual([]);
      expect(record.untrackedRestored).toEqual(["u.txt"]);
      expect(await readFile(join(dir, "u.txt"), "utf8")).toBe("user file\n");
    });
  });

  test("commitFixes never stages the audit directory", async () => {
    await withInRepoAudit(async (dir, audit) => {
      await writeFile(join(audit.auditDir, "run-1.rounds.jsonl"), "{}\n");
      await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
      const out = await commitFixes(dir, "fix: x", { skipHooks: true, excludeDir: audit.auditDir });
      expect(out.committed).toBe(true);
      expect((await git(dir, "show", "--name-only", "--format=", "HEAD")).trim()).toBe("a.ts");
      const audit2 = await commitFixes(dir, "fix: y", { skipHooks: true, excludeDir: audit.auditDir });
      expect(audit2.committed).toBe(false);
    });
  });
});

describe("fix-base snapshot lifecycle and modes (B4)", () => {
  const snapshot = (audit: { auditDir: string; runId: string }, n = 1) => join(audit.auditDir, `run-1.fix-base-${n}`);

  test("removed once a step settles: done, and stopped with a clean restore", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (auditDir) => {
        await repo(dir);
        const audit = { auditDir, runId: "run-1" };
        await writeFile(join(dir, ".env.local"), "TOKEN=secret\n");
        const state = makeFinishState({ workdir: dir });
        const done = makeFinishOps([], {}, { fix: async () => ({ dispositions: [] }) });
        await runFixStep(state, { ops: done, audit, now }, "review", { findings: [finding] });
        expect(existsSync(snapshot(audit, 1))).toBe(false);
        const stopped = makeFinishOps([], {}, { fix: async () => ({ interrupted: true }) });
        const result = await runFixStep(state, { ops: stopped, audit, now }, "review", { findings: [finding] });
        expect(result.kind).toBe("stopped");
        expect(state.handoffs[0]?.restored).toBe(true);
        expect(existsSync(snapshot(audit, 1))).toBe(false);
      });
    });
  });

  test("kept, owner-only, for a handoff whose restore failed (finalize needs it)", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (auditDir) => {
        await repo(dir);
        const audit = { auditDir, runId: "run-1" };
        await writeFile(join(dir, ".env.local"), "TOKEN=secret\n");
        await mkdir(join(dir, "sub"), { recursive: true });
        await writeFile(join(dir, "sub", "n.txt"), "nested\n");
        const state = makeFinishState({ workdir: dir });
        const ops = makeFinishOps(
          [],
          {},
          {
            fix: async () => {
              await writeFile(join(dir, "a.ts"), "half\n");
              return { interrupted: true };
            },
          },
        );
        const undo = failGit((args) => args.includes("restore"));
        try {
          await runFixStep(state, { ops, audit, now }, "review", { findings: [finding] });
        } finally {
          undo();
        }
        expect(state.handoffs[0]?.restored).toBe(false);
        const snap = snapshot(audit, 1);
        expect(await readFile(join(snap, ".env.local"), "utf8")).toBe("TOKEN=secret\n");
        expect(await modeOf(snap)).toBe(0o700);
        expect(await modeOf(join(snap, "sub"))).toBe(0o700);
        expect(await modeOf(join(snap, ".env.local"))).toBe(0o600);
        expect(await modeOf(join(snap, "sub", "n.txt"))).toBe(0o600);
      });
    });
  });

  test("a user's file deleted by the session is put back with its own mode", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (auditDir) => {
        await repo(dir);
        const audit = { auditDir, runId: "run-1" };
        await writeFile(join(dir, "run.sh"), "echo hi\n", { mode: 0o755 });
        const state = makeFinishState({ workdir: dir });
        const ops = makeFinishOps(
          [],
          {},
          {
            fix: async () => {
              await rm(join(dir, "run.sh")); // put back as a NEW file, so the mode must be restored explicitly
              return { interrupted: true };
            },
          },
        );
        await runFixStep(state, { ops, audit, now }, "review", { findings: [finding] });
        expect(await readFile(join(dir, "run.sh"), "utf8")).toBe("echo hi\n");
        expect(await modeOf(join(dir, "run.sh"))).toBe(0o755);
      });
    });
  });
});

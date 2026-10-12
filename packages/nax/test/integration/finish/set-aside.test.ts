import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import {
  _setAsideDeps,
  captureFixBase,
  handoffDir,
  markHandoffConsumed,
  reapplyHandoff,
  setAside,
  snapshotUntracked,
} from "@/finish/set-aside";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  return new Response(p.stdout).text();
}

async function repo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "keep.ts"), "export const keep = 1;\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
}

const now = () => "2026-10-12T00:00:00.000Z";

/** Runs `fn` with a fresh repo and a separate audit dir outside it. */
async function withRepo(fn: (dir: string, audit: { auditDir: string; runId: string }) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    await withTempDir(async (outside) => {
      await repo(dir);
      await fn(dir, { auditDir: outside, runId: "run-1" });
    });
  });
}

describe("set-aside (finish A §4)", () => {
  test("saves only the session's work; pre-existing tracked edits and untracked files survive", async () => {
    await withRepo(async (dir, audit) => {
      await writeFile(join(dir, ".env"), "SECRET=1\n"); // untracked before the session
      await writeFile(join(dir, "keep.ts"), "export const keep = 2;\n"); // a pre-existing tracked edit
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      expect(base.untrackedBefore).toContain(".env");
      await writeFile(join(dir, "a.ts"), "export const a = 2;\n"); // the session's edit
      await writeFile(join(dir, "b.ts"), "export const b = 1;\n"); // the session's new file
      const record = await setAside({
        workdir: dir,
        audit,
        n: 1,
        base,
        phase: "review",
        limit: "fix",
        findingIds: ["quality|x|a.ts"],
        now,
      });
      expect(record).toMatchObject({
        patchSaved: true,
        restored: true,
        newUntracked: ["b.ts"],
        changedPaths: ["a.ts"],
      });
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(existsSync(join(dir, "b.ts"))).toBe(false);
      expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(await readFile(join(dir, "keep.ts"), "utf8")).toBe("export const keep = 2;\n");
      const patch = await readFile(join(handoffDir(audit, 1), "changes.patch"), "utf8");
      expect(patch).toContain("export const a = 2;");
      expect(patch).toContain("b.ts");
      expect(patch).not.toContain("keep");
      expect(JSON.parse(await readFile(join(handoffDir(audit, 1), "meta.json"), "utf8"))).toMatchObject({
        phase: "review",
        limit: "fix",
        consumed: false,
      });
    });
  });

  test("writes note.json when a note is given", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "a.ts"), "x\n");
      const note = { findings: [{ index: 1, status: "partial" as const, files: ["a.ts"], remaining: "tests" }] };
      const record = await setAside({
        workdir: dir,
        audit,
        n: 1,
        base,
        phase: "review",
        limit: "flow",
        findingIds: [],
        note,
        now,
      });
      expect(record.hasNote).toBe(true);
      expect(JSON.parse(await readFile(join(handoffDir(audit, 1), "note.json"), "utf8"))).toEqual(note);
    });
  });

  test("reapply restores the set-aside edits and lists the files; consumed is recorded", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "a.ts"), "export const a = 3;\n");
      await writeFile(join(dir, "c.ts"), "c\n");
      const record = await setAside({
        workdir: dir,
        audit,
        n: 1,
        base,
        phase: "review",
        limit: "fix",
        findingIds: [],
        now,
      });
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(true);
      expect([...out.files].sort()).toEqual(["a.ts", "c.ts"]);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 3;\n");
      expect((await markHandoffConsumed(record)).consumed).toBe(true);
    });
  });

  test("a pre-existing untracked file the session edited is put back, and its edit kept in the handoff", async () => {
    await withRepo(async (dir, audit) => {
      await writeFile(join(dir, "notes.md"), "mine\n"); // untracked, not ignored, before the session
      const captured = await captureFixBase(dir);
      assertDefined(captured, "base");
      const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "run-1.fix-base"));
      const base = { ...captured, untrackedSnapshot: snapshot };
      await writeFile(join(dir, "notes.md"), "half-edited by the session\n");
      const record = await setAside({
        workdir: dir,
        audit,
        n: 1,
        base,
        phase: "review",
        limit: "fix",
        findingIds: [],
        now,
      });
      expect(record.untrackedRestored).toEqual(["notes.md"]);
      expect(record.untrackedMovedAside).toEqual([]);
      expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("mine\n");
      expect(await readFile(join(handoffDir(audit, 1), "untracked-modified", "notes.md"), "utf8")).toBe(
        "half-edited by the session\n",
      );
    });
  });

  test("an edited untracked file over the snapshot cap is moved into the handoff, never left on the branch", async () => {
    await withRepo(async (dir, audit) => {
      const limits = { ..._setAsideDeps.limits };
      _setAsideDeps.limits = { fileMax: 3, totalMax: 3 };
      try {
        await writeFile(join(dir, "big.md"), "too big to snapshot\n");
        await writeFile(join(dir, ".env"), "SECRET=1\n"); // also over the cap, but never touched
        const captured = await captureFixBase(dir);
        assertDefined(captured, "base");
        const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "run-1.fix-base"));
        expect(snapshot.files.every((f) => !f.saved)).toBe(true);
        await writeFile(join(dir, "big.md"), "edited\n");
        const record = await setAside({
          workdir: dir,
          audit,
          n: 1,
          base: { ...captured, untrackedSnapshot: snapshot },
          phase: "review",
          limit: "fix",
          findingIds: [],
          now,
        });
        expect(record.untrackedMovedAside).toEqual(["big.md"]);
        expect(existsSync(join(dir, "big.md"))).toBe(false);
        expect(await readFile(join(handoffDir(audit, 1), "untracked-modified", "big.md"), "utf8")).toBe("edited\n");
        expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET=1\n");
      } finally {
        _setAsideDeps.limits = limits;
      }
    });
  });

  test("never runs git clean or reset --hard, and a file the session git-added is removed", async () => {
    await withRepo(async (dir, audit) => {
      const { _finishGitDeps } = await import("@/finish");
      const real = _finishGitDeps.git;
      const argv: string[][] = [];
      _finishGitDeps.git = async (args, cwd, ms) => {
        argv.push(args);
        return real(args, cwd, ms);
      };
      try {
        const base = await captureFixBase(dir);
        assertDefined(base, "base");
        await writeFile(join(dir, "staged.ts"), "s\n");
        await git(dir, "add", "staged.ts");
        await setAside({ workdir: dir, audit, n: 1, base, phase: "gate", limit: "fix", findingIds: [], now });
        expect(existsSync(join(dir, "staged.ts"))).toBe(false);
        expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
        expect(argv.some((a) => a[0] === "clean")).toBe(false);
        expect(argv.some((a) => a[0] === "reset" && a.includes("--hard"))).toBe(false);
      } finally {
        _finishGitDeps.git = real;
      }
    });
  });

  test("a patch that no longer applies touches nothing", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "a.ts"), "export const a = 4;\n");
      const record = await setAside({
        workdir: dir,
        audit,
        n: 1,
        base,
        phase: "review",
        limit: "fix",
        findingIds: [],
        now,
      });
      await writeFile(join(dir, "a.ts"), "totally different\n");
      await git(dir, "commit", "-qam", "conflict");
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(false);
      expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
    });
  });
});

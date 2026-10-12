import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import { _finishGitDeps } from "@/finish/commit";
import {
  _setAsideDeps,
  captureFixBase,
  handoffDir,
  markHandoffConsumed,
  readHandoffNote,
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
      _setAsideDeps.limits = { fileMax: 3, totalMax: 1_000_000 };
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
        expect(argv.some((a) => a.includes("clean"))).toBe(false);
        expect(argv.some((a) => a.includes("reset") && a.includes("--hard"))).toBe(false);
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

type GitResult = Awaited<ReturnType<typeof _finishGitDeps.git>>;

/** Makes every git call whose argv matches `match` fail (exit 1). Returns the undo. */
function failGit(match: (args: string[]) => boolean): () => void {
  const real = _finishGitDeps.git;
  _finishGitDeps.git = async (args, cwd, ms) => {
    if (match(args)) return { stdout: "", stderr: "injected", exitCode: 1 } satisfies GitResult;
    return real(args, cwd, ms);
  };
  return () => {
    _finishGitDeps.git = real;
  };
}

async function commitAll(dir: string, msg: string): Promise<void> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", msg);
}

describe("set-aside hardening", () => {
  test("a tracked file the session renamed: both the old and new path are put back", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await git(dir, "mv", "a.ts", "d.ts");
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
      expect(record.restored).toBe(true);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(existsSync(join(dir, "d.ts"))).toBe(false);
      expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
    });
  });

  test("a failed copy into untracked-modified leaves the user's file in place and reports it", async () => {
    await withRepo(async (dir, audit) => {
      await writeFile(join(dir, "notes.md"), "mine\n");
      const captured = await captureFixBase(dir);
      assertDefined(captured, "base");
      const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
      await writeFile(join(dir, "notes.md"), "edited\n");
      await mkdir(handoffDir(audit, 1), { recursive: true });
      await writeFile(join(handoffDir(audit, 1), "untracked-modified"), "blocks the directory");
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
      expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("edited\n");
      expect(record.untrackedFailed).toEqual(["notes.md"]);
      expect(record.restored).toBe(false);
    });
  });

  test("a failing git status or diff is not read as 'nothing changed'", async () => {
    for (const bad of ["status", "diff"]) {
      await withRepo(async (dir, audit) => {
        const base = await captureFixBase(dir);
        assertDefined(base, "base");
        await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
        const undo = failGit((a) => a.includes(bad));
        try {
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
          expect(record.restored).toBe(false);
        } finally {
          undo();
        }
      });
    }
  });

  test("a failing git restore reports restored=false", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
      const undo = failGit((a) => a.includes("restore"));
      try {
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
        expect(record.restored).toBe(false);
      } finally {
        undo();
      }
    });
  });

  test("when the patch cannot be written the worktree is still restored", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
      await mkdir(join(handoffDir(audit, 1), "changes.patch"), { recursive: true }); // a directory where the file goes
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
      expect(record.patchSaved).toBe(false);
      expect(record.restored).toBe(true);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    });
  });

  test("a leftover intent-to-add entry is not left behind when diff fails", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "new.ts"), "n\n");
      const undo = failGit((a) => a.includes("diff") && a.includes("--binary"));
      try {
        await setAside({ workdir: dir, audit, n: 1, base, phase: "review", limit: "fix", findingIds: [], now });
      } finally {
        undo();
      }
      expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
    });
  });

  test("files that each fit the file cap but together exceed the total cap: the overflow is not saved", async () => {
    await withRepo(async (dir, audit) => {
      const limits = { ..._setAsideDeps.limits };
      _setAsideDeps.limits = { fileMax: 100, totalMax: 25 };
      try {
        await writeFile(join(dir, "n1.md"), "0123456789012345678\n");
        await writeFile(join(dir, "n2.md"), "0123456789012345678\n");
        const captured = await captureFixBase(dir);
        assertDefined(captured, "base");
        const snap = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
        expect(snap.files.map((f) => f.saved)).toEqual([true, false]);
      } finally {
        _setAsideDeps.limits = limits;
      }
    });
  });

  test("captureFixBase is null when stash create fails on a dirty tree, and when HEAD is unreadable", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, "a.ts"), "dirty\n");
      const undo = failGit((a) => a.includes("stash"));
      try {
        expect(await captureFixBase(dir)).toBeNull();
      } finally {
        undo();
      }
    });
    await withTempDir(async (dir) => {
      await git(dir, "init", "-q");
      expect(await captureFixBase(dir)).toBeNull();
    });
  });

  test("a pre-existing untracked file the session deleted is put back from the snapshot", async () => {
    await withRepo(async (dir, audit) => {
      await writeFile(join(dir, "notes.md"), "mine\n");
      const captured = await captureFixBase(dir);
      assertDefined(captured, "base");
      const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
      await Bun.file(join(dir, "notes.md")).delete();
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
      expect(record.untrackedRestored).toEqual(["notes.md"]);
      expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("mine\n");
    });
  });

  test("unicode and spaced names: created files are removed, tracked ones restored, patch keeps the name", async () => {
    await withRepo(async (dir, audit) => {
      await writeFile(join(dir, "ü x.ts"), "one\n");
      await commitAll(dir, "unicode");
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "ü x.ts"), "two\n");
      await writeFile(join(dir, "dé f.ts"), "new\n");
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
      expect(record.newUntracked).toEqual(["dé f.ts"]);
      expect(record.changedPaths).toEqual(["ü x.ts"]);
      expect(existsSync(join(dir, "dé f.ts"))).toBe(false);
      expect(await readFile(join(dir, "ü x.ts"), "utf8")).toBe("one\n");
      expect(record.restored).toBe(true);
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(true);
      expect(await readFile(join(dir, "dé f.ts"), "utf8")).toBe("new\n");
      expect(await readFile(join(dir, "ü x.ts"), "utf8")).toBe("two\n");
    });
  });

  test("a workdir that is a package subdirectory resolves root-relative paths correctly", async () => {
    await withRepo(async (dir, audit) => {
      await mkdir(join(dir, "pkg"), { recursive: true });
      await writeFile(join(dir, "pkg", "x.ts"), "x1\n");
      await commitAll(dir, "pkg");
      const sub = join(dir, "pkg");
      const base = await captureFixBase(sub);
      assertDefined(base, "base");
      await writeFile(join(sub, "x.ts"), "x2\n");
      await writeFile(join(sub, "n.ts"), "n\n");
      const record = await setAside({
        workdir: sub,
        audit,
        n: 1,
        base,
        phase: "review",
        limit: "fix",
        findingIds: [],
        now,
      });
      expect(record.restored).toBe(true);
      expect(await readFile(join(sub, "x.ts"), "utf8")).toBe("x1\n");
      expect(existsSync(join(sub, "n.ts"))).toBe(false);
      expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
      const out = await reapplyHandoff(sub, record);
      expect(out.applied).toBe(true);
      expect(await readFile(join(sub, "x.ts"), "utf8")).toBe("x2\n");
    });
  });

  test("a created file whose name looks like a glob is saved in the patch literally", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "[ab].ts"), "glob\n");
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
      expect(await readFile(join(handoffDir(audit, 1), "changes.patch"), "utf8")).toContain("glob");
      expect(existsSync(join(dir, "[ab].ts"))).toBe(false);
      expect(record.restored).toBe(true);
    });
  });

  test("a symlink the session swapped in is replaced, never written through to its target", async () => {
    await withRepo(async (dir, audit) => {
      await withTempDir(async (outside) => {
        const target = join(outside, "target.txt");
        await writeFile(target, "outside\n");
        await writeFile(join(dir, "notes.md"), "mine\n");
        const captured = await captureFixBase(dir);
        assertDefined(captured, "base");
        const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
        await Bun.file(join(dir, "notes.md")).delete();
        await symlink(target, join(dir, "notes.md"));
        await setAside({
          workdir: dir,
          audit,
          n: 1,
          base: { ...captured, untrackedSnapshot: snapshot },
          phase: "review",
          limit: "fix",
          findingIds: [],
          now,
        });
        expect(await readFile(target, "utf8")).toBe("outside\n");
        expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("mine\n");
      });
    });
  });

  test("a pre-existing untracked symlink is never copied through", async () => {
    await withRepo(async (dir, audit) => {
      await withTempDir(async (outside) => {
        await writeFile(join(outside, "secret.txt"), "s\n");
        await symlink(join(outside, "secret.txt"), join(dir, "link.md"));
        const captured = await captureFixBase(dir);
        assertDefined(captured, "base");
        const snap = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
        expect(snap.files.filter((f) => f.saved)).toEqual([]);
        expect(existsSync(join(audit.auditDir, "snap", "link.md"))).toBe(false);
      });
    });
  });

  test("a patch that conflicts in one file applies to none", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "a.ts"), "export const a = 5;\n");
      await writeFile(join(dir, "keep.ts"), "export const keep = 5;\n");
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
      await writeFile(join(dir, "keep.ts"), "other\n");
      await commitAll(dir, "diverge");
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(false);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    });
  });

  test("readHandoffNote reads the note back, and is undefined without one", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      const note = { findings: [{ index: 1, status: "done" as const, files: ["a.ts"], remaining: "" }] };
      const withNote = await setAside({
        workdir: dir,
        audit,
        n: 1,
        base,
        phase: "review",
        limit: "fix",
        findingIds: [],
        note,
        now,
      });
      expect(await readHandoffNote(withNote)).toEqual(note);
      const without = await setAside({
        workdir: dir,
        audit,
        n: 2,
        base,
        phase: "review",
        limit: "fix",
        findingIds: [],
        now,
      });
      expect(await readHandoffNote(without)).toBeUndefined();
    });
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import { _finishGitDeps } from "@/finish/commit";
import {
  _setAsideDeps,
  captureFixBase,
  handoffDir,
  readHandoffNote,
  reapplyHandoff,
  restoreUntracked,
  setAside,
  snapshotUntracked,
} from "@/finish/set-aside";

import { commitAll, failGit, git, now, withRepo } from "./set-aside-fixture";

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

  test("an over-cap pre-existing untracked file the session git-added and edited is never lost", async () => {
    await withRepo(async (dir, audit) => {
      const limits = { ..._setAsideDeps.limits };
      _setAsideDeps.limits = { fileMax: 3, totalMax: 1_000_000 };
      try {
        await writeFile(join(dir, "big.md"), "mine, over the cap\n");
        const captured = await captureFixBase(dir);
        assertDefined(captured, "base");
        const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
        await writeFile(join(dir, "big.md"), "edited by the session\n");
        await git(dir, "add", "big.md");
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
        expect(await readFile(join(handoffDir(audit, 1), "untracked-modified", "big.md"), "utf8")).toBe(
          "edited by the session\n",
        );
        expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
      } finally {
        _setAsideDeps.limits = limits;
      }
    });
  });

  test("when that file's handoff copy fails it stays on disk and is reported", async () => {
    await withRepo(async (dir, audit) => {
      const limits = { ..._setAsideDeps.limits };
      _setAsideDeps.limits = { fileMax: 3, totalMax: 1_000_000 };
      try {
        await writeFile(join(dir, "big.md"), "mine, over the cap\n");
        const captured = await captureFixBase(dir);
        assertDefined(captured, "base");
        const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
        await writeFile(join(dir, "big.md"), "edited by the session\n");
        await git(dir, "add", "big.md");
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
        expect(await readFile(join(dir, "big.md"), "utf8")).toBe("edited by the session\n");
        expect(record.untrackedFailed).toEqual(["big.md"]);
        expect(record.restored).toBe(false);
      } finally {
        _setAsideDeps.limits = limits;
      }
    });
  });

  test("a non-UTF-8 file's edit is kept byte for byte in changes.patch and applies back", async () => {
    await withRepo(async (dir, audit) => {
      await writeFile(join(dir, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      await commitAll(dir, "latin");
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xe9, 0x0a]));
      await writeFile(join(dir, "new.txt"), Buffer.from([0x6e, 0xe9, 0x0a]));
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
      const patch = Buffer.from(await Bun.file(join(handoffDir(audit, 1), "changes.patch")).arrayBuffer());
      expect(patch.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xe9, 0x0a]))).toBe(true);
      expect(patch.includes(Buffer.from([0x6e, 0xe9, 0x0a]))).toBe(true);
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(true);
      expect(Buffer.from(await Bun.file(join(dir, "latin.txt")).arrayBuffer())).toEqual(
        Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xe9, 0x0a]),
      );
    });
  });

  test("a created file reached through a directory the session swapped for a symlink deletes nothing outside", async () => {
    await withRepo(async (dir, audit) => {
      await withTempDir(async (outside) => {
        const victim = join(outside, "f.txt");
        await writeFile(victim, "outside\n");
        const base = await captureFixBase(dir);
        assertDefined(base, "base");
        await mkdir(join(dir, "sub"));
        await writeFile(join(dir, "sub", "f.txt"), "created\n");
        const real = _finishGitDeps.git;
        _finishGitDeps.git = async (args, cwd, ms) => {
          const res = await real(args, cwd, ms);
          if (args.includes("--binary")) {
            await rm(join(dir, "sub"), { recursive: true });
            await symlink(outside, join(dir, "sub"));
          }
          return res;
        };
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
          _finishGitDeps.git = real;
        }
        expect(await readFile(victim, "utf8")).toBe("outside\n");
      });
    });
  });

  test("an over-cap untracked file whose directory became a symlink is not removed through it", async () => {
    await withRepo(async (dir, audit) => {
      await withTempDir(async (outside) => {
        const limits = { ..._setAsideDeps.limits };
        _setAsideDeps.limits = { fileMax: 3, totalMax: 1_000_000 };
        try {
          await mkdir(join(dir, "d"));
          await writeFile(join(dir, "d", "big.md"), "mine, over the cap\n");
          await writeFile(join(outside, "big.md"), "outside\n");
          const captured = await captureFixBase(dir);
          assertDefined(captured, "base");
          const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
          await rm(join(dir, "d"), { recursive: true });
          await symlink(outside, join(dir, "d"));
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
          expect(await readFile(join(outside, "big.md"), "utf8")).toBe("outside\n");
          expect(record.untrackedFailed).toEqual(["d/big.md"]);
          expect(record.restored).toBe(false);
        } finally {
          _setAsideDeps.limits = limits;
        }
      });
    });
  });

  test("snapshotUntracked refuses a directory that is the repo root or above it", async () => {
    await withRepo(async (dir) => {
      await expect(snapshotUntracked(dir, [], dir)).rejects.toThrow();
      await expect(snapshotUntracked(dir, [], join(dir, ".."))).rejects.toThrow();
      expect(existsSync(join(dir, "a.ts"))).toBe(true);
    });
  });

  test("a literal-glob name does not unstage the tracked files it would match as a pattern", async () => {
    await withRepo(async (dir, audit) => {
      await writeFile(join(dir, "b.ts"), "export const b = 1;\n");
      await commitAll(dir, "b");
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      await writeFile(join(dir, "[ab].ts"), "glob\n");
      await git(dir, "add", "[ab].ts");
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
      expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
    });
  });

  test("captureFixBase fails when it cannot tell whether tracked files changed, or list untracked ones", async () => {
    await withRepo(async (dir) => {
      let undo = failGit((a) => a.includes("stash") || a.includes("diff"));
      try {
        expect(await captureFixBase(dir)).toBeNull();
      } finally {
        undo();
      }
      undo = failGit((a) => a.includes("status"));
      try {
        expect(await captureFixBase(dir)).toBeNull();
      } finally {
        undo();
      }
      undo = failGit((a) => a.includes("stash"));
      try {
        expect(await captureFixBase(dir)).not.toBeNull(); // clean tree: HEAD is the base
      } finally {
        undo();
      }
    });
  });

  test("a note.json of the wrong shape reads as no note", async () => {
    await withRepo(async (dir, audit) => {
      const base = await captureFixBase(dir);
      assertDefined(base, "base");
      const note = { findings: [{ index: 1, status: "done" as const, files: [], remaining: "" }] };
      const record = await setAside({
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
      await writeFile(join(handoffDir(audit, 1), "note.json"), JSON.stringify({ findings: [{ index: "x" }] }));
      expect(await readHandoffNote(record)).toBeUndefined();
    });
  });

  test("restoreUntracked itself never removes through a swapped-in directory symlink", async () => {
    await withRepo(async (dir, audit) => {
      await withTempDir(async (outside) => {
        const limits = { ..._setAsideDeps.limits };
        _setAsideDeps.limits = { fileMax: 3, totalMax: 1_000_000 };
        try {
          await mkdir(join(dir, "d"));
          await writeFile(join(dir, "d", "big.md"), "mine, over the cap\n");
          await writeFile(join(outside, "big.md"), "outside\n");
          const captured = await captureFixBase(dir);
          assertDefined(captured, "base");
          const snapshot = await snapshotUntracked(dir, captured.untrackedBefore, join(audit.auditDir, "snap"));
          await rm(join(dir, "d"), { recursive: true });
          await symlink(outside, join(dir, "d"));
          const out = await restoreUntracked(dir, snapshot, join(audit.auditDir, "handoff"));
          expect(out.failed).toEqual(["d/big.md"]);
          expect(await readFile(join(outside, "big.md"), "utf8")).toBe("outside\n");
          expect(existsSync(join(audit.auditDir, "handoff", "untracked-modified", "d", "big.md"))).toBe(false);
        } finally {
          _setAsideDeps.limits = limits;
        }
      });
    });
  });
});

/**
 * B1 — the second read a `nax memory mirrors --prune` removal is decided on.
 *
 * The listing is read before the question and the removal happens after it, so the mirror is read
 * again with its lock held. The first version of that recheck listed the projects directory again
 * and treated "the listing does not hold this mirror" as "the mirror is gone". `listMemoryMirrors`
 * answers `[]` for a projects directory it cannot list, so an unreadable inventory and an absent
 * mirror were one answer, and a populated mirror was deleted on it. Only a positively read,
 * prunable mirror may be removed now.
 *
 * The two closed sets of cases are here — the stubbed answers for the three shapes the recheck can
 * give, and the real filesystem reproduction of the reported failure. Everything about the
 * listing, the question and the removal itself stays in `memory-mirrors.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  emptyMirror,
  makeMirrorsHarness,
  makeTempDir,
  PROBE_MIRROR,
  PROJECTS_DIR,
  probe,
  runMirrors,
} from "@test/helpers";
import { type MemoryMirrorsCliDeps, memoryMirrorsCommand } from "@/cli";
import { listMemoryMirrors, type MemoryMirrorRead, readMemoryMirror } from "@/memory";

/** Two leftover probes under the stubbed projects directory. */
const PROBE_A = join(PROJECTS_DIR, "probe-01234567");
const PROBE_B = join(PROJECTS_DIR, "probe-89abcdef");

describe("nax memory mirrors --prune — the recheck that cannot read the mirror", () => {
  test("B1: a mirror the recheck could not read is not removed, and says so", async () => {
    const h = makeMirrorsHarness({
      mirrors: [PROBE_MIRROR],
      recheck: (): MemoryMirrorRead => ({ kind: "unreadable" }),
    });

    expect(await runMirrors(h, { prune: true, yes: true })).toBe(0);
    expect(h.removed).toEqual([]);
    expect(h.err).toEqual(["Skipped probe-89abcdef: it could not be read"]);
    // The lock still comes back: an unreadable mirror is skipped, not left held.
    expect(h.released).toEqual([PROBE_B]);
  });

  test("B1: an unreadable mirror does not stop the readable one beside it being removed", async () => {
    const h = makeMirrorsHarness({
      mirrors: [emptyMirror("probe-01234567"), PROBE_MIRROR],
      recheck: (dir): MemoryMirrorRead =>
        dir === PROBE_A ? { kind: "unreadable" } : { kind: "read", mirror: PROBE_MIRROR },
    });

    expect(await runMirrors(h, { prune: true, yes: true })).toBe(0);
    expect(h.removed).toEqual([PROBE_B]);
    expect(h.err).toEqual(["Skipped probe-01234567: it could not be read"]);
  });

  test("B1: a mirror whose contents the recheck could only partly read is not removed", async () => {
    const h = makeMirrorsHarness({
      mirrors: [PROBE_MIRROR],
      // A read that answered, and answered that it could not see everything: the counts are a
      // lower bound, so "0 notes" is not "empty".
      recheck: (): MemoryMirrorRead => ({
        kind: "read",
        mirror: probe({ notes: 0, unreadable: [join(PROBE_B, "notes")] }),
      }),
    });

    expect(await runMirrors(h, { prune: true, yes: true })).toBe(0);
    expect(h.removed).toEqual([]);
    expect(h.err).toEqual(["Skipped probe-89abcdef: it is no longer empty"]);
  });

  test("B1: a mirror that went while the question was open needs no removal and reports none", async () => {
    const h = makeMirrorsHarness({ mirrors: [PROBE_MIRROR], recheck: (): MemoryMirrorRead => ({ kind: "absent" }) });

    expect(await runMirrors(h, { prune: true, yes: true })).toBe(0);
    // Nothing to delete: the directory is already gone, so no removal is attempted at all — and the
    // row says so rather than claiming a removal this run did not do.
    expect(h.removed).toEqual([]);
    expect(h.err).toEqual(["Skipped probe-89abcdef: it is already gone"]);
    expect(h.out).toEqual([expect.stringContaining("probe-89abcdef")]);
  });

  test("B1: an inventory that could not be listed is not an empty inventory", async () => {
    // The listing is read once, before the question; a projects directory that cannot be listed
    // answers no mirrors, which is why the recheck asks the mirror itself instead.
    const h = makeMirrorsHarness({ mirrors: [PROBE_MIRROR] });

    await runMirrors(h, { prune: true, yes: true });

    expect(h.reread).toEqual([PROBE_B]);
    expect(h.listed).toEqual([PROJECTS_DIR]);
  });
});

// ─── the regression the review found (B1) ────────────────────────────────────
//
// Reproduced as it was reported: the question is open, a session saves a note into the mirror
// while it is, and the projects directory loses its read permission — the directory can still be
// traversed by name, but can no longer be listed. `listMemoryMirrors` answers "no mirrors" for
// that, which the old recheck read as "this mirror is gone" and authorized the delete on. The
// note was gone with the directory, and the command exited 0.

describe("nax memory mirrors --prune — a recheck that fails after the mirror gains content", () => {
  let projectsDir: string;
  /** The mode the projects directory had, put back before the temp tree is cleaned up. */
  let projectsMode: number;

  /** One mirror directory under the projects directory, holding `notes/`. */
  function mirrorDir(name: string): string {
    const dir = join(projectsDir, name);
    mkdirSync(join(dir, "notes"), { recursive: true });
    return dir;
  }

  /** The note a session would have saved while the question was open. */
  function saveNote(dir: string, slug: string): void {
    writeFileSync(join(dir, "notes", `${slug}.md`), `---\nslug: ${slug}\n---\nBody of ${slug}\n`);
  }

  beforeEach(() => {
    projectsDir = makeTempDir("nax-mirrors-b1-");
    projectsMode = statSync(projectsDir).mode & 0o777;
  });

  afterEach(() => {
    // The mirror inside must be reachable again before the tree can be walked and removed.
    chmodSync(projectsDir, projectsMode);
    cleanupTempDir(projectsDir);
  });

  test("B1: the populated mirror survives an unlistable projects directory", async () => {
    const mirror = mirrorDir("probe-01234567");
    const h = makeMirrorsHarness({ mirrors: [] });
    const deps: MemoryMirrorsCliDeps = {
      ...h.deps,
      projectsDir: () => projectsDir,
      listMemoryMirrors,
      readMirror: readMemoryMirror,
      confirm: async () => {
        saveNote(mirror, "saved-mid-question");
        // Readable names, unlistable: a traversal by exact path still works, a directory listing
        // does not — the state the probe put the projects directory in.
        chmodSync(projectsDir, 0o111);
        return true;
      },
    };

    expect(await memoryMirrorsCommand({ prune: true }, deps)).toBe(0);

    // Nothing was deleted, and the command said why rather than reporting a removal.
    expect(h.removed).toEqual([]);
    expect(h.err).toEqual(["Skipped probe-01234567: it is no longer empty"]);
    expect(existsSync(join(mirror, "notes", "saved-mid-question.md"))).toBe(true);
  });

  test("B1: the recheck reads the mirror by name, so an unlistable directory is not an empty one", async () => {
    const mirror = mirrorDir("probe-01234567");
    chmodSync(projectsDir, 0o111);

    // The listing cannot see the mirror at all; the exact-path read still can.
    expect(await listMemoryMirrors(projectsDir)).toEqual([]);
    const reread = await readMemoryMirror(mirror);

    expect(reread.kind).toBe("read");
    expect(reread.kind === "read" ? reread.mirror.name : null).toBe("probe-01234567");
  });
});

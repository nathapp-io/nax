/**
 * US-010 — the mirror transition `nax memory link --force` makes.
 *
 * A relink is two writes that must both land: the project config names a new koda project, and
 * the mirror that still holds the previous project's notes and export cursor is discarded. This
 * file covers everything that can go wrong between them — a discard that fails, a rollback that
 * fails with it, and the record that makes the next run finish the job — using `statefulFs`, a
 * filesystem that remembers what one run left for the next.
 *
 * The command's checks, the config it writes, the probe, the output and the registration are
 * `memory-admin-link.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  answerProbe,
  entriesUnder,
  jsonAnswer,
  LINK_CONFIG_PATH,
  LINK_REPO,
  LINK_SLUG,
  LINK_TMP_PATH,
  LINKED_TO_SLUG,
  MIRROR_DIR,
  makeLinkHarness,
  mirrorDiscards,
  OTHER_LINKED,
  OTHER_PROJECT,
  projectIn,
  RELINK_RECORD_PATH,
  restoreSeams,
  runLink,
  type StatefulFs,
  saveSeams,
  statefulFs,
} from "@test/helpers";

/** The `direct` envelope the probe answers. */
function directProbe(): void {
  answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));
}

/** A record naming the project a relink was moving to, and the one it was moving from. */
function recordOf(project: string, from: string): string {
  return `${JSON.stringify({ project, from })}\n`;
}

beforeEach(() => {
  saveSeams();
});

afterEach(() => {
  restoreSeams();
});

// ─── the successful transition ──────────────────────────────────────────────

describe("nax memory link — the mirror a relink discards", () => {
  test("AC-18: a forced relink writes the config and then removes the project mirror", async () => {
    const h = makeLinkHarness({ projectConfig: OTHER_LINKED });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    // The record is staged first, then the config write and its rename, and the discard last.
    expect(h.fs.writes.map((write) => write.path)).toEqual([`${RELINK_RECORD_PATH}.tmp`, LINK_TMP_PATH]);
    expect(h.fs.renames).toEqual([
      { from: `${RELINK_RECORD_PATH}.tmp`, to: RELINK_RECORD_PATH },
      { from: LINK_TMP_PATH, to: LINK_CONFIG_PATH },
    ]);
    expect(h.fs.removed).toEqual([MIRROR_DIR, RELINK_RECORD_PATH]);
    expect(h.fs.events).toEqual(["write", "rename", "write", "rename", "remove", "remove"]);
    expect(h.hostCalls).toHaveLength(1);
  });

  test("AC-19: --force on the project already linked succeeds and removes nothing", async () => {
    const h = makeLinkHarness({ projectConfig: LINKED_TO_SLUG });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(h.fs.writes.map((write) => write.path)).toEqual([LINK_TMP_PATH]);
    expect(h.fs.removed).toEqual([]);
    // — not a forced relink. The host is opened only to read the mirror's record, and finds none.
    expect(h.hostCalls).toHaveLength(1);
  });

  test("linking the same project again needs no --force and removes nothing", async () => {
    const h = makeLinkHarness({ projectConfig: LINKED_TO_SLUG });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(h.fs.writes.map((write) => write.path)).toEqual([LINK_TMP_PATH]);
    expect(h.fs.removed).toEqual([]);
  });

  test("--force on a project that names none is not a relink: no host, no removal", async () => {
    const h = makeLinkHarness();
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(h.hostCalls).toEqual([]);
    expect(h.fs.removed).toEqual([]);
  });

  test("a forced relink with memory disabled skips the undelivered check and the removal", async () => {
    const h = makeLinkHarness({ projectConfig: OTHER_LINKED, counts: { queued: 5, rejected: 0 }, host: null });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(h.fs.writes.map((write) => write.path)).toEqual([LINK_TMP_PATH]);
    expect(h.fs.removed).toEqual([]);
  });
});

// ─── a discard that fails ───────────────────────────────────────────────────

describe("nax memory link — a discard that fails", () => {
  test("F1: the config write is undone, and the relink stays recorded", async () => {
    const store = statefulFs(OTHER_LINKED, { failRemovals: 1 });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    // The discard fails after the config was written: the write is undone, so the repository is
    // left linking what it linked before rather than the new project on the old mirror.
    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(store.files.get(LINK_CONFIG_PATH)).toBe(OTHER_LINKED);
    expect(projectIn(store)).toBe(OTHER_PROJECT);
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR]);

    // The retry reads the old slug as the project being replaced, and discards again.
    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR, MIRROR_DIR]);
    expect(projectIn(store)).toBe(LINK_SLUG);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
  });

  test("F1: a rollback that fails leaves the relink recorded, so the retry discards the mirror", async () => {
    // The discard fails, and so does the write that would undo the config it followed.
    const store = statefulFs(OTHER_LINKED, {
      failRemovals: 1,
      failWritesTo: { path: LINK_TMP_PATH, after: 1, times: 1 },
    });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    // Nothing could undo the write: the file names the new project, and the mirror is the old one.
    expect(projectIn(store)).toBe(LINK_SLUG);
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR]);
    // The record written before the config changed is what makes this recoverable.
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(true);
    const line = h.err[0] ?? "";
    expect(line).toContain(MIRROR_DIR);
    expect(line).toContain(RELINK_RECORD_PATH);
    expect(line).toContain(`nax memory link ${LINK_SLUG}`);

    // A retry that reads as "already linked" — no --force — must still finish the discard.
    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR, MIRROR_DIR]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
    expect(projectIn(store)).toBe(LINK_SLUG);
  });

  /** A discard that deletes one entry of the mirror and then fails, with the undo failing too. */
  function partialDiscardStore(): StatefulFs {
    const store = statefulFs(OTHER_LINKED, {
      partialRemovals: 1,
      failWritesTo: { path: LINK_TMP_PATH, after: 1, times: 1 },
    });
    store.files.set(join(MIRROR_DIR, "notes.json"), "[]\n");
    return store;
  }

  test("F1: a record survives a discard that deletes part of the mirror", async () => {
    // The reported defect: a recursive delete walks the tree, so it can take an entry with it and
    // still fail on a busy one — and the record must not be one of the entries it can take.
    const store = partialDiscardStore();
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    // Half the mirror is gone and the undo failed, so the record is what a retry has to go on.
    expect(entriesUnder(store, MIRROR_DIR).length).toBeGreaterThan(0);
    expect(projectIn(store)).toBe(LINK_SLUG);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(true);
  });

  test("F1: a retry after a partially deleted mirror finishes the discard instead of reporting success", async () => {
    const store = partialDiscardStore();
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();
    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);

    // A retry that reads as "already linked" must not exit 0 with the old mirror still attached.
    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR, MIRROR_DIR]);
    expect(entriesUnder(store, MIRROR_DIR)).toEqual([]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
  });

  test("F1: a --force retry after a failed rollback finishes the discard too", async () => {
    const store = statefulFs(OTHER_LINKED, {
      failRemovals: 1,
      failWritesTo: { path: LINK_TMP_PATH, after: 1, times: 1 },
    });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR]);

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR, MIRROR_DIR]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
    expect(projectIn(store)).toBe(LINK_SLUG);
  });

  test("F1: the relink is recorded before the config changes", async () => {
    const store = statefulFs(OTHER_LINKED);
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(store.events).toEqual([
      `write ${RELINK_RECORD_PATH}.tmp`,
      `rename ${RELINK_RECORD_PATH}.tmp -> ${RELINK_RECORD_PATH}`,
      `write ${LINK_TMP_PATH}`,
      `rename ${LINK_TMP_PATH} -> ${LINK_CONFIG_PATH}`,
      `remove ${MIRROR_DIR}`,
      `remove ${RELINK_RECORD_PATH}`,
    ]);
  });

  test("a record that cannot be written aborts the link before anything changes", async () => {
    const store = statefulFs(OTHER_LINKED, { failWritesTo: { path: `${RELINK_RECORD_PATH}.tmp`, after: 0 } });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(h.err).toEqual([
      `Error: [memory] cannot record the relink in ${RELINK_RECORD_PATH}: ENOSPC: no space left on device; ` +
        "nothing was changed",
    ]);
    // Nothing but the failed staging happened: the config and the mirror are as they were.
    expect(store.files.get(LINK_CONFIG_PATH)).toBe(OTHER_LINKED);
    expect(store.removed).toEqual([]);
  });

  test("a config write that fails reports it, and discards no mirror", async () => {
    const store = statefulFs(OTHER_LINKED, { failWritesTo: { path: LINK_TMP_PATH, after: 0 } });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(h.err).toEqual([`Error: [memory] cannot write ${LINK_CONFIG_PATH}: ENOSPC: no space left on device`]);
    // The config still names the project the mirror belongs to, so the mirror must survive.
    expect(store.files.get(LINK_CONFIG_PATH)).toBe(OTHER_LINKED);
    expect(store.removed).toEqual([]);
    // The record outlives the failed write and is harmless: the retry is a relink again, which
    // overwrites it before reading it, and a link to the project the config names ignores it.
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(true);
  });
});

// ─── a record an earlier run left ───────────────────────────────────────────

describe("nax memory link — a recorded relink", () => {
  test("a record for another project is not a discard", async () => {
    const store = statefulFs(OTHER_LINKED);
    store.files.set(RELINK_RECORD_PATH, recordOf("third", OTHER_PROJECT));
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    // The config still links `other`, so the mirror is `other`'s: a record for a project this
    // run is not linking must not wipe it.
    expect(await runLink(h, OTHER_PROJECT)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([]);
    expect(projectIn(store)).toBe(OTHER_PROJECT);
  });

  test("a record naming no project, or no previous one, is refused too", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, `{ "project": "${LINK_SLUG}" }`);
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual([
      `[memory] cannot read the pending relink in ${RELINK_RECORD_PATH}: it is not a relink record`,
    ]);
    expect(store.removed).toEqual([]);
  });

  test("a record that cannot be read is refused", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, "{ broken");
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual([
      `[memory] cannot read the pending relink in ${RELINK_RECORD_PATH}: it is not a relink record`,
    ]);
    expect(mirrorDiscards(store)).toEqual([]);
    expect(projectIn(store)).toBe(LINK_SLUG);
  });

  test("finishing a recorded relink still refuses while writes are undelivered", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, recordOf(LINK_SLUG, OTHER_PROJECT));
    const h = makeLinkHarness({ fs: store.deps, counts: { queued: 0, rejected: 2 } });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual([
      "[memory] 2 writes are not delivered; run nax memory sync (or nax memory forget) before relinking",
    ]);
    expect(mirrorDiscards(store)).toEqual([]);
    expect(projectIn(store)).toBe(LINK_SLUG);
  });

  test("a record whose mirror is already gone is simply dropped", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, recordOf(LINK_SLUG, OTHER_PROJECT));
    for (const key of [...store.files.keys()]) {
      if (key.startsWith(`${MIRROR_DIR}/`)) store.files.delete(key);
    }
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    // Nothing is left to discard — an earlier run finished it — so the record goes and nothing else.
    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
  });

  test("a record that cannot be removed once the mirror is gone is reported", async () => {
    const store = statefulFs(LINKED_TO_SLUG, { failRemovalPaths: [RELINK_RECORD_PATH] });
    store.files.set(RELINK_RECORD_PATH, recordOf(LINK_SLUG, OTHER_PROJECT));
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(h.err).toEqual([
      `Error: [memory] the project mirror ${MIRROR_DIR} was discarded, but ${RELINK_RECORD_PATH} could not ` +
        "be removed: EACCES: " +
        `${RELINK_RECORD_PATH} is read-only; remove it before the next link`,
    ]);
    // The discard itself landed; only the record of it is left, and the message says so.
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR]);
  });

  test("a record for the project being linked is finished, and the mode is still printed", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, recordOf(LINK_SLUG, OTHER_PROJECT));
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([MIRROR_DIR]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
    expect(h.out).toEqual([`linked ${LINK_REPO} to koda project ${LINK_SLUG} (write mode: direct)`]);
    // The record was already there, so this run does not stage its own.
    expect(store.events).toEqual([
      `write ${LINK_TMP_PATH}`,
      `rename ${LINK_TMP_PATH} -> ${LINK_CONFIG_PATH}`,
      `remove ${MIRROR_DIR}`,
      `remove ${RELINK_RECORD_PATH}`,
    ]);
  });
});

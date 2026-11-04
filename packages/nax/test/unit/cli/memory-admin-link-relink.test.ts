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
  linkedHost,
  MIRROR_DIR,
  makeLinkHarness,
  mirrorDiscards,
  OTHER_LINKED,
  OTHER_PROJECT,
  projectIn,
  QUARANTINE_DIR,
  RELINK_RECORD_PATH,
  realAdminDeps,
  restoreSeams,
  runLink,
  type StatefulFs,
  saveSeams,
  statefulFs,
  withTempDir,
} from "@test/helpers";

/** The `direct` envelope the probe answers. */
function directProbe(): void {
  answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));
}

/** A record naming the project a relink was moving to, and the one it was moving from. */
function recordOf(project: string, from: string, phase = "attached"): string {
  return `${JSON.stringify({ project, from, phase })}\n`;
}

beforeEach(() => {
  saveSeams();
});

afterEach(() => {
  restoreSeams();
});

// ─── the successful transition ──────────────────────────────────────────────

describe("nax memory link — the mirror a relink discards", () => {
  test("AC-18: a forced relink writes the config then quarantines and removes the old mirror", async () => {
    const h = makeLinkHarness({ projectConfig: OTHER_LINKED });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    // The record is staged first, then the config write and its rename, and the discard last.
    expect(h.fs.writes.map((write) => write.path)).toEqual([
      `${RELINK_RECORD_PATH}.tmp`,
      LINK_TMP_PATH,
      `${RELINK_RECORD_PATH}.tmp`,
    ]);
    expect(h.fs.renames).toEqual([
      { from: `${RELINK_RECORD_PATH}.tmp`, to: RELINK_RECORD_PATH },
      { from: LINK_TMP_PATH, to: LINK_CONFIG_PATH },
      { from: MIRROR_DIR, to: QUARANTINE_DIR },
      { from: `${RELINK_RECORD_PATH}.tmp`, to: RELINK_RECORD_PATH },
    ]);
    expect(h.fs.removed).toEqual([QUARANTINE_DIR, RELINK_RECORD_PATH]);
    expect(h.fs.events).toEqual([
      "write",
      "rename",
      "write",
      "rename",
      "rename",
      "write",
      "rename",
      "remove",
      "remove",
    ]);
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
    const store = statefulFs(OTHER_LINKED, { failMirrorRenames: 1 });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    // Detaching fails after the config was written: the write is undone, so the repository is
    // left linking what it linked before rather than the new project on the old mirror.
    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(store.files.get(LINK_CONFIG_PATH)).toBe(OTHER_LINKED);
    expect(projectIn(store)).toBe(OTHER_PROJECT);
    expect(mirrorDiscards(store)).toEqual([]);

    // The retry reads the old slug as the project being replaced, and discards again.
    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(mirrorDiscards(store)).toEqual([QUARANTINE_DIR]);
    expect(projectIn(store)).toBe(LINK_SLUG);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
  });

  test("F1: a rollback that fails leaves the relink recorded, so the retry discards the mirror", async () => {
    // The atomic detach fails, and so does the config rollback.
    const store = statefulFs(OTHER_LINKED, {
      failMirrorRenames: 1,
      failWritesTo: { path: LINK_TMP_PATH, after: 1, times: 1 },
    });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    // Nothing could undo the write: the file names the new project, and the mirror is the old one.
    expect(projectIn(store)).toBe(LINK_SLUG);
    expect(mirrorDiscards(store)).toEqual([]);
    // The record written before the config changed is what makes this recoverable.
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(true);
    const line = h.err[0] ?? "";
    expect(line).toContain(MIRROR_DIR);
    expect(line).toContain(RELINK_RECORD_PATH);
    expect(line).toContain(`nax memory link ${LINK_SLUG}`);

    // A retry that reads as "already linked" — no --force — must still finish the discard.
    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([QUARANTINE_DIR]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
    expect(projectIn(store)).toBe(LINK_SLUG);
  });

  /** A recursive discard that partly deletes the quarantined generation and then fails. */
  function partialDiscardStore(): StatefulFs {
    const store = statefulFs(OTHER_LINKED, { partialRemovals: 1 });
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
    // Half the quarantined tree is gone; the detached record keeps cleanup off the live path.
    expect(entriesUnder(store, QUARANTINE_DIR).length).toBeGreaterThan(0);
    expect(entriesUnder(store, MIRROR_DIR)).toEqual([]);
    expect(projectIn(store)).toBe(LINK_SLUG);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(true);
  });

  test("F1: a retry after a partially deleted mirror finishes the discard instead of reporting success", async () => {
    const store = partialDiscardStore();
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();
    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);

    // A retry that reads as "already linked" must still finish deleting the quarantined generation.
    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([QUARANTINE_DIR, QUARANTINE_DIR]);
    expect(entriesUnder(store, MIRROR_DIR)).toEqual([]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
  });

  test("F1: a --force retry after a failed rollback finishes the discard too", async () => {
    const store = statefulFs(OTHER_LINKED, {
      failMirrorRenames: 1,
      failWritesTo: { path: LINK_TMP_PATH, after: 1, times: 1 },
    });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(mirrorDiscards(store)).toEqual([]);

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(mirrorDiscards(store)).toEqual([QUARANTINE_DIR]);
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
      `rename ${MIRROR_DIR} -> ${QUARANTINE_DIR}`,
      `write ${RELINK_RECORD_PATH}.tmp`,
      `rename ${RELINK_RECORD_PATH}.tmp -> ${RELINK_RECORD_PATH}`,
      `remove ${QUARANTINE_DIR}`,
      `remove ${RELINK_RECORD_PATH}`,
    ]);
  });

  test("a record that cannot be written aborts the link before anything changes", async () => {
    const store = statefulFs(OTHER_LINKED, { failWritesTo: { path: `${RELINK_RECORD_PATH}.tmp`, after: 0 } });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(h.err).toEqual([
      `Error: [memory] cannot record the relink in ${RELINK_RECORD_PATH}: ENOSPC: no space left on device`,
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
    // The record outlives the failed write: the retry reuses it, while linking the old project
    // abandons it without deleting the live mirror.
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

  test("an attached record whose mirror is gone establishes detachment evidence before cleanup", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, recordOf(LINK_SLUG, OTHER_PROJECT));
    for (const key of [...store.files.keys()]) {
      if (key.startsWith(`${MIRROR_DIR}/`)) store.files.delete(key);
    }
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    // Nothing is left to detach, but quarantine evidence must still precede the detached phase.
    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([QUARANTINE_DIR]);
    expect(store.events.indexOf(`rename ${QUARANTINE_DIR}.tmp -> ${QUARANTINE_DIR}`)).toBeLessThan(
      store.events.indexOf(`remove ${QUARANTINE_DIR}`),
    );
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
        `${RELINK_RECORD_PATH} is read-only; run \`nax memory link ${LINK_SLUG}\` again to finish cleanup`,
    ]);
    // The discard itself landed; only the record of it is left.
    expect(mirrorDiscards(store)).toEqual([QUARANTINE_DIR]);
  });

  test("F2: record-removal failure, mirror rebuild and same-project retry preserve new approvals", async () => {
    const store = statefulFs(OTHER_LINKED, { failRemovalPaths: [RELINK_RECORD_PATH] });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(entriesUnder(store, MIRROR_DIR)).toEqual([]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(true);
    const approvals = join(MIRROR_DIR, "koda-approvals.json");
    const cursor = join(MIRROR_DIR, "sync.json");
    store.files.set(approvals, '[{"approvalId":"new-project-approval"}]\n');
    store.files.set(cursor, '{"cursor":"new-project-cursor"}\n');
    // The first record removal failed; allow the retry to clear it.
    const remove = store.deps.removePath;
    const retry = makeLinkHarness({
      fs: {
        ...store.deps,
        removePath: async (path) => {
          if (path === RELINK_RECORD_PATH) store.files.delete(path);
          else await remove?.(path);
        },
      },
    });

    expect(await runLink(retry, LINK_SLUG)).toBe(0);
    expect(store.files.get(approvals)).toBe('[{"approvalId":"new-project-approval"}]\n');
    expect(store.files.get(cursor)).toBe('{"cursor":"new-project-cursor"}\n');
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
  });

  test("F2: real directory quarantine survives record-removal failure without deleting rebuilt approvals", async () => {
    await withTempDir(async (repo) => {
      const root = join(repo, "memory");
      const projectDir = join(root, "projects", "repo");
      const record = join(root, "relink", "repo.json");
      const config = join(repo, ".nax", "config.json");
      const approvals = join(projectDir, "koda-approvals.json");
      await realAdminDeps.writeText(config, OTHER_LINKED);
      await realAdminDeps.writeText(approvals, "old approvals");
      let failRecordRemoval = true;
      const h = makeLinkHarness({
        repo,
        host: {
          ...linkedHost({ queued: 0, rejected: 0 }),
          dirs: { root, projectDir, userDir: join(root, "user") },
        },
        fs: {
          ...realAdminDeps,
          removePath: async (path) => {
            if (path === record && failRecordRemoval) {
              failRecordRemoval = false;
              throw new Error("interrupted record removal");
            }
            await realAdminDeps.removePath(path);
          },
        },
      });
      directProbe();

      expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
      expect(await realAdminDeps.readText(approvals)).toBeNull();
      expect(JSON.parse((await realAdminDeps.readText(record)) ?? "{}").phase).toBe("detached");
      await realAdminDeps.writeText(approvals, "new approvals");
      expect(await runLink(h, LINK_SLUG)).toBe(0);
      expect(await realAdminDeps.readText(approvals)).toBe("new approvals");
      expect(await realAdminDeps.readText(record)).toBeNull();
    });
  });

  test("F2: an empty quarantine still proves the old generation was detached", async () => {
    await withTempDir(async (repo) => {
      const root = join(repo, "memory");
      const projectDir = join(root, "projects", "repo");
      const record = join(root, "relink", "repo.json");
      const emptyEntry = join(`${record}.mirror`, "sync.json");
      const approvals = join(projectDir, "koda-approvals.json");
      await realAdminDeps.writeText(join(repo, ".nax", "config.json"), LINKED_TO_SLUG);
      await realAdminDeps.writeText(record, recordOf(LINK_SLUG, OTHER_PROJECT));
      await realAdminDeps.writeText(emptyEntry, "old cursor");
      await realAdminDeps.removePath(emptyEntry);
      await realAdminDeps.writeText(approvals, "new approvals");
      const h = makeLinkHarness({
        repo,
        host: { ...linkedHost({ queued: 0, rejected: 0 }), dirs: { root, projectDir, userDir: join(root, "user") } },
        fs: realAdminDeps,
      });
      directProbe();

      expect(await runLink(h, LINK_SLUG)).toBe(0);
      expect(await realAdminDeps.readText(approvals)).toBe("new approvals");
      expect(await realAdminDeps.readText(record)).toBeNull();
    });
  });

  test.each(["write", "rename"] as const)(
    "F2: retry after the detached phase %s fails cleans quarantine, not a rebuilt mirror",
    async (failure) => {
      const store = statefulFs(OTHER_LINKED);
      let fail = true;
      const h = makeLinkHarness({
        fs: {
          ...store.deps,
          writeText: async (path, text) => {
            if (failure === "write" && path === `${RELINK_RECORD_PATH}.tmp` && text.includes('"detached"') && fail) {
              fail = false;
              throw new Error("interrupted detached write");
            }
            await store.deps.writeText?.(path, text);
          },
          rename: async (from, to) => {
            if (
              failure === "rename" &&
              from === `${RELINK_RECORD_PATH}.tmp` &&
              store.files.get(from)?.includes('"detached"') &&
              fail
            ) {
              fail = false;
              throw new Error("interrupted detached rename");
            }
            await store.deps.rename?.(from, to);
          },
        },
      });
      directProbe();

      expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
      expect(JSON.parse(store.files.get(RELINK_RECORD_PATH) ?? "{}").phase).toBe("attached");
      expect(entriesUnder(store, QUARANTINE_DIR).length).toBeGreaterThan(0);
      expect(store.removed).toEqual([]);
      const approvalPath = join(MIRROR_DIR, "koda-approvals.json");
      store.files.set(approvalPath, "new approvals");

      expect(await runLink(h, LINK_SLUG)).toBe(0);
      expect(store.files.get(approvalPath)).toBe("new approvals");
      expect(entriesUnder(store, QUARANTINE_DIR)).toEqual([]);
      expect(store.events.filter((event) => event.startsWith(`rename ${MIRROR_DIR} ->`))).toHaveLength(1);
      expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
    },
  );

  test.each([
    { mirror: "empty", failure: "write" },
    { mirror: "empty", failure: "rename" },
    { mirror: "absent", failure: "write" },
    { mirror: "absent", failure: "rename" },
  ] as const)(
    "F2: $mirror mirror preserves rebuilt approvals after detached phase $failure failure",
    async ({ mirror, failure }) => {
      await withTempDir(async (repo) => {
        const root = join(repo, "memory");
        const projectDir = join(root, "projects", "repo");
        const record = join(root, "relink", "repo.json");
        const quarantine = `${record}.mirror`;
        const approvals = join(projectDir, "koda-approvals.json");
        const cursor = join(projectDir, "sync.json");
        await realAdminDeps.writeText(join(repo, ".nax", "config.json"), OTHER_LINKED);
        if (mirror === "empty") {
          await realAdminDeps.writeText(cursor, "old cursor");
          await realAdminDeps.removePath(cursor);
        }
        let fail = true;
        const h = makeLinkHarness({
          repo,
          host: { ...linkedHost({ queued: 0, rejected: 0 }), dirs: { root, projectDir, userDir: join(root, "user") } },
          fs: {
            ...realAdminDeps,
            writeText: async (path, text) => {
              if (failure === "write" && path === `${record}.tmp` && text.includes('"detached"') && fail) {
                fail = false;
                throw new Error("interrupted detached write");
              }
              await realAdminDeps.writeText(path, text);
            },
            rename: async (from, to) => {
              if (failure === "rename" && from === `${record}.tmp` && fail) {
                const text = await realAdminDeps.readText(from);
                if (text?.includes('"detached"')) {
                  fail = false;
                  throw new Error("interrupted detached rename");
                }
              }
              await realAdminDeps.rename(from, to);
            },
          },
        });
        directProbe();

        expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
        expect(JSON.parse((await realAdminDeps.readText(record)) ?? "{}").phase).toBe("attached");
        const detachmentEvidence = (await realAdminDeps.listDir(join(root, "relink"))).includes("repo.json.mirror");
        await realAdminDeps.writeText(approvals, "new approvals");
        await realAdminDeps.writeText(cursor, "new cursor");

        expect(await runLink(h, LINK_SLUG)).toBe(0);
        expect(await realAdminDeps.readText(approvals)).toBe("new approvals");
        expect(await realAdminDeps.readText(cursor)).toBe("new cursor");
        expect(detachmentEvidence).toBe(true);
        expect(await realAdminDeps.readText(record)).toBeNull();
        expect(await realAdminDeps.listDir(quarantine)).toEqual([]);
        expect(await realAdminDeps.listDir(join(root, "relink"))).not.toContain("repo.json.mirror");
      });
    },
  );

  test.each(["write", "rename"] as const)(
    "empty-mirror evidence %s failure rolls back without false quarantine",
    async (failure) => {
      const store = statefulFs(OTHER_LINKED);
      store.files.delete(join(MIRROR_DIR, "sync.json"));
      let fail = true;
      const h = makeLinkHarness({
        fs: {
          ...store.deps,
          writeText: async (path, text) => {
            if (failure === "write" && path === `${QUARANTINE_DIR}.tmp` && fail) {
              fail = false;
              // Model a staging write that creates its file before failing.
              store.files.set(path, "");
              throw new Error("interrupted evidence write");
            }
            await store.deps.writeText?.(path, text);
          },
          rename: async (from, to) => {
            if (failure === "rename" && to === QUARANTINE_DIR && fail) {
              fail = false;
              throw new Error("interrupted evidence rename");
            }
            await store.deps.rename?.(from, to);
          },
        },
      });
      directProbe();

      expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
      expect(store.files.get(LINK_CONFIG_PATH)).toBe(OTHER_LINKED);
      expect(store.files.has(QUARANTINE_DIR)).toBe(false);
      expect(JSON.parse(store.files.get(RELINK_RECORD_PATH) ?? "{}").phase).toBe("attached");
      expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
      expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
      expect(store.files.has(`${QUARANTINE_DIR}.tmp`)).toBe(false);
    },
  );

  test("F2: a failed quarantine delete does not roll back the new project or endanger a rebuilt mirror", async () => {
    const store = statefulFs(OTHER_LINKED, { failRemovals: 1 });
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(1);
    expect(projectIn(store)).toBe(LINK_SLUG);
    expect(JSON.parse(store.files.get(RELINK_RECORD_PATH) ?? "{}").phase).toBe("detached");
    const approvalPath = join(MIRROR_DIR, "koda-approvals.json");
    store.files.set(approvalPath, "new approvals");

    expect(await runLink(h, LINK_SLUG, { force: true })).toBe(0);
    expect(store.files.get(approvalPath)).toBe("new approvals");
    expect(mirrorDiscards(store)).toEqual([QUARANTINE_DIR, QUARANTINE_DIR]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
  });

  test("a legacy record without generation state is refused rather than deleting a rebuilt mirror", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, JSON.stringify({ project: LINK_SLUG, from: OTHER_PROJECT }));
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(1);
    expect(store.removed).toEqual([]);
    expect(store.events).toEqual([]);
    expect(h.err[0]).toContain("not a relink record");
  });

  test("an unfinished relink cannot be overwritten by a forced link to a third project", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, recordOf(LINK_SLUG, OTHER_PROJECT, "detached"));
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, "third", { force: true })).toBe(1);
    expect(store.events).toEqual([]);
    expect(h.err[0]).toContain(`nax memory link ${LINK_SLUG}`);
  });

  test("a record for the project being linked is finished, and the mode is still printed", async () => {
    const store = statefulFs(LINKED_TO_SLUG);
    store.files.set(RELINK_RECORD_PATH, recordOf(LINK_SLUG, OTHER_PROJECT));
    const h = makeLinkHarness({ fs: store.deps });
    directProbe();

    expect(await runLink(h, LINK_SLUG)).toBe(0);
    expect(mirrorDiscards(store)).toEqual([QUARANTINE_DIR]);
    expect(store.files.has(RELINK_RECORD_PATH)).toBe(false);
    expect(h.out).toEqual([`linked ${LINK_REPO} to koda project ${LINK_SLUG} (write mode: direct)`]);
    // This run advances the existing intent to detached before deleting quarantine.
    expect(store.events).toEqual([
      `write ${LINK_TMP_PATH}`,
      `rename ${LINK_TMP_PATH} -> ${LINK_CONFIG_PATH}`,
      `rename ${MIRROR_DIR} -> ${QUARANTINE_DIR}`,
      `write ${RELINK_RECORD_PATH}.tmp`,
      `rename ${RELINK_RECORD_PATH}.tmp -> ${RELINK_RECORD_PATH}`,
      `remove ${QUARANTINE_DIR}`,
      `remove ${RELINK_RECORD_PATH}`,
    ]);
  });
});

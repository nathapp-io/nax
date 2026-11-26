/**
 * `lockMemoryMirror` — the mirror's own writer lock, taken by the one nax command that removes a
 * whole mirror (US-021 F1).
 *
 * The claims that matter are the protocol's, not this module's: a live holder keeps a prune out,
 * a dead one is taken over, and what is handed back removes the file it created. Every case uses a
 * real lock file in a real directory, because the point is which file a session's writer and this
 * command contend on — a stub would only restate the call.
 *
 * The last case is the one the prune actually needs: the caller removes the directory *while*
 * holding the lock, so the release runs against a mirror that is already gone.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { lockMemoryMirror } from "@/memory";

/** The instant every case's injected clock reports. */
const STAMP = "2026-11-25T10:15:00.000Z";

/** A pid no test process has: the holder another nax process would leave behind. */
const FOREIGN_PID = 8412;

/** The lock file's name inside the mirror it guards. */
const LOCK_FILE = "sync.lock";

/** A lock body as the protocol writes it. */
function lockBody(pid: number): string {
  return JSON.stringify({ pid, startedAt: STAMP, nonce: "c0ffee00", heartbeatAt: STAMP });
}

/** A fresh mirror directory, and its lock path. */
function mirror(): { root: string; dir: string; lock: string } {
  const root = makeTempDir("nax-mirror-lock-");
  const dir = join(root, "projects", "mirror");
  mkdirSync(dir, { recursive: true });
  return { root, dir, lock: join(dir, LOCK_FILE) };
}

describe("lockMemoryMirror", () => {
  test("takes the mirror's sync.lock and hands back a release that removes it", async () => {
    const { root, dir, lock } = mirror();
    try {
      const release = await lockMemoryMirror({
        dir,
        logger: makeLogger(),
        now: () => new Date(STAMP),
        isAlive: () => true,
      });

      expect(release).not.toBeNull();
      expect(existsSync(lock)).toBe(true);
      expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);

      await release?.();
      expect(existsSync(lock)).toBe(false);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("answers null while another live process holds the mirror", async () => {
    const { root, dir, lock } = mirror();
    try {
      writeFileSync(lock, lockBody(FOREIGN_PID));

      const release = await lockMemoryMirror({
        dir,
        logger: makeLogger(),
        now: () => new Date(STAMP),
        isAlive: (pid) => pid === FOREIGN_PID,
      });

      expect(release).toBeNull();
      // The holder's file is untouched: this command did not take the mirror over.
      expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(FOREIGN_PID);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("takes over a lock whose holder is gone, as any writer of the mirror would", async () => {
    const { root, dir, lock } = mirror();
    try {
      writeFileSync(lock, lockBody(FOREIGN_PID));

      const release = await lockMemoryMirror({
        dir,
        logger: makeLogger(),
        now: () => new Date(STAMP),
        isAlive: () => false,
      });

      expect(release).not.toBeNull();
      expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
      await release?.();
    } finally {
      cleanupTempDir(root);
    }
  });

  test("creates the mirror directory the lock lives in", async () => {
    const parent = makeTempDir("nax-mirror-lock-parent-");
    const dir = join(parent, "projects", "api-01234567");
    try {
      const release = await lockMemoryMirror({ dir, logger: makeLogger(), now: () => new Date(STAMP) });

      expect(release).not.toBeNull();
      expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
      await release?.();
    } finally {
      cleanupTempDir(parent);
    }
  });

  test("the release resolves after the mirror is gone, warning instead of throwing", async () => {
    const { root, dir, lock } = mirror();
    try {
      const logger = makeLogger();
      const release = await lockMemoryMirror({ dir, logger, now: () => new Date(STAMP) });
      expect(release).not.toBeNull();
      mkdirSync(join(dir, "notes"), { recursive: true });

      // Exactly what a prune does: the directory goes while the lock that guards it is still held.
      await rm(dir, { recursive: true, force: true });

      expect(existsSync(lock)).toBe(false);
      await expect(release?.()).resolves.toBeUndefined();
      // The protocol really did fail to find its lock again — the warning is the swallow, not a
      // release that quietly succeeded.
      expect(logger.calls.some((call) => call.level === "warn")).toBe(true);
    } finally {
      cleanupTempDir(root);
    }
  });
});

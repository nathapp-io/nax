import { describe, expect, test } from "bun:test";
import { readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryOutbox, type MemoryWriteRequest } from "@nathapp/nax-agent";
import { _fileLockDeps } from "#src/internal/file-lock";
import { _memoryStoreDeps } from "#src/memory/store";
import { waitForCondition, withDepsRestore, withTempDir } from "#test/helpers/index";

const REQUEST: MemoryWriteRequest = {
  kind: "forget",
  clientId: "client-retry",
  scope: "project",
  slug: "old-budget",
  writeMode: "direct",
  reason: "superseded by the new budget",
};
const NAME = "00000001-client-retry.json";

describe("memory outbox: claim recovery", () => {
  withDepsRestore(_memoryStoreDeps);
  withDepsRestore(_fileLockDeps);

  test("restart recovers a requeued write interrupted after the removal claim rename", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir });
      const queued = await outbox.enqueue(REQUEST);
      await outbox.markRejected(REQUEST.clientId, "try again");
      await outbox.requeue(REQUEST.clientId);
      const realRename = _memoryStoreDeps.rename;
      const interrupted = new Error("process stopped before restoring its claim");
      _memoryStoreDeps.rename = async (from, to) => {
        if (from.endsWith(".json.claim")) throw interrupted;
        await realRename(from, to);
      };
      await expect(outbox.removeIfRejected(REQUEST.clientId)).rejects.toBe(interrupted);
      expect(await readdir(dir)).toContain(`${NAME}.claim`);
      _memoryStoreDeps.rename = realRename;
      // A real process exit also leaves its lock behind. Prove the shared protocol takes
      // over that dead holder before restoring the queue, without sending any real signals.
      await writeFile(join(dir, ".outbox.lock"), "2147483647\n");
      const realIsAlive = _fileLockDeps.isPidAlive;
      _fileLockDeps.isPidAlive = (pid) => (pid === 2147483647 ? false : realIsAlive(pid));

      const reopened = createMemoryOutbox({ dir });
      expect(await reopened.list()).toEqual([queued]);
      expect(await reopened.held(REQUEST.clientId)).toEqual(queued);
      expect(await reopened.heldKeys("forget")).toEqual(new Set(["project/old-budget"]));
      expect(await reopened.listInvalid()).toEqual([]);
      expect(await readdir(dir)).toEqual([NAME]);
      expect((await reopened.enqueue({ ...REQUEST, clientId: "next-client" })).seq).toBe(2);
    });
  });

  test("held and listInvalid recover claims even without a preceding list", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir });
      const queued = await outbox.enqueue(REQUEST);
      await rename(join(dir, NAME), join(dir, `${NAME}.claim`));
      expect(await createMemoryOutbox({ dir }).held(REQUEST.clientId)).toEqual(queued);
      await writeFile(join(dir, NAME), "not JSON");
      await rename(join(dir, NAME), join(dir, `${NAME}.claim`));
      expect(await createMemoryOutbox({ dir }).listInvalid()).toEqual([NAME]);
    });
  });

  test("recovery never overwrites an entry when both names exist", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir });
      const entry = await outbox.enqueue(REQUEST);
      const claimBytes = JSON.stringify({ ...entry, state: "rejected" });
      await writeFile(join(dir, `${NAME}.claim`), claimBytes);
      await expect(createMemoryOutbox({ dir }).list()).rejects.toMatchObject({
        code: "MEMORY_OUTBOX_CLAIM_CONFLICT",
        context: { entryPath: join(dir, NAME), claimPath: join(dir, `${NAME}.claim`) },
      });
      expect(await Bun.file(join(dir, NAME)).json()).toEqual(entry);
      expect(await Bun.file(join(dir, `${NAME}.claim`)).text()).toBe(claimBytes);
    });
  });

  test("a second instance waits for a live removal instead of stealing its claim", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir });
      const queued = await outbox.enqueue(REQUEST);
      const realRename = _memoryStoreDeps.rename;
      const gate = Promise.withResolvers<void>();
      let claimed = false;
      let recoveryStarted = false;
      _memoryStoreDeps.rename = async (from, to) => {
        if (from.endsWith(".json.claim")) recoveryStarted = true;
        await realRename(from, to);
        if (to.endsWith(".json.claim")) {
          claimed = true;
          await gate.promise;
        }
      };
      const removing = outbox.removeIfRejected(REQUEST.clientId);
      await waitForCondition(() => claimed);
      const other = createMemoryOutbox({ dir });
      const realIsAlive = _fileLockDeps.isPidAlive;
      let waiterObservedLock = false;
      _fileLockDeps.isPidAlive = (pid) => {
        waiterObservedLock = true;
        return realIsAlive(pid);
      };
      const listing = other.list();
      try {
        await waitForCondition(() => waiterObservedLock);
        expect(recoveryStarted).toBe(false);
      } finally {
        gate.resolve();
        await removing;
      }
      expect(await listing).toEqual([queued]);
      expect(await readdir(dir)).toEqual([NAME]);
    });
  });

  test("an interrupted rejected removal is recovered, not silently discarded", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir });
      await outbox.enqueue(REQUEST);
      await outbox.markRejected(REQUEST.clientId, "permanent refusal");
      await rename(join(dir, NAME), join(dir, `${NAME}.claim`));
      const reopened = createMemoryOutbox({ dir });
      expect(await reopened.held(REQUEST.clientId)).toMatchObject({ state: "rejected", reason: "permanent refusal" });
      expect(await reopened.removeIfRejected(REQUEST.clientId)).toBe(true);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});

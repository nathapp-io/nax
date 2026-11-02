import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync } from "node:fs";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { openPinnedStage, pinnedOperation, withPinnedDirectory } from "#src/internal/pinned-directory";
import { getAgentRuntime, nodeRuntime, setAgentRuntime } from "#src/runtime/index";
import { withTempDir } from "#test/helpers/index";

const installed = getAgentRuntime();
afterEach(() => setAgentRuntime(installed));

async function pin<T>(path: string, action: () => Promise<T>): Promise<T> {
  return withPinnedDirectory(
    { path, identity: await stat(path), changed: () => new Error("directory replaced") },
    action,
  );
}

describe("withPinnedDirectory", () => {
  test("refuses a replacement selected during spawn before sending a mutation", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "notes");
      await mkdir(path);
      setAgentRuntime({
        ...nodeRuntime,
        spawn: (cmd, options) => {
          renameSync(path, join(dir, "aside"));
          mkdirSync(path);
          return nodeRuntime.spawn(cmd, options);
        },
      });
      let ran = false;
      await expect(
        pin(path, async () => {
          ran = true;
        }),
      ).rejects.toThrow("directory replaced");
      expect(ran).toBe(false);
    });
  });

  test("concurrent contexts keep their parents and binary content isolated", async () => {
    await withTempDir(async (dir) => {
      const parents = [join(dir, "first"), join(dir, "second")];
      await Promise.all(parents.map((path) => mkdir(path)));
      await Promise.all(
        parents.map((path, i) =>
          pin(path, async () => {
            await rename(path, `${path}-aside`);
            await mkdir(path);
            await writeFileAtomic(join(path, "note"), new Uint8Array([0, 255, i]), { mode: 0o600 });
          }),
        ),
      );
      for (const [i, path] of parents.entries()) {
        expect(await readFile(join(`${path}-aside`, "note"))).toEqual(Buffer.from([0, 255, i]));
        expect((await stat(join(`${path}-aside`, "note"))).mode & 0o777).toBe(0o600);
      }
    });
  });

  test("refuses operands and rename destinations outside its pinned parent", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "notes");
      await mkdir(path);
      await pin(path, async () => {
        expect(() => pinnedOperation(join(dir, "foreign"), "rm")).toThrow("not in the pinned directory");
        expect(() => pinnedOperation(join(path, "note"), "rename", [join(dir, "foreign")])).toThrow("leaves");
      });
    });
  });

  test("worker filesystem errors keep their codes and do not poison later requests", async () => {
    await withTempDir(async (dir) => {
      await pin(dir, async () => {
        await expect(pinnedOperation(join(dir, "missing"), "stat")).rejects.toMatchObject({ code: "ENOENT" });
        await writeFileAtomic(join(dir, "present"), "ready");
      });
      expect(await readFile(join(dir, "present"), "utf8")).toBe("ready");
    });
  });

  test("reports an early worker exit instead of sending unpinned operations", async () => {
    await withTempDir(async (dir) => {
      setAgentRuntime({
        ...nodeRuntime,
        spawn: (_cmd, options) =>
          nodeRuntime.spawn([process.execPath, "-e", 'process.stderr.write("worker failed")'], options),
      });
      await expect(pin(dir, async () => undefined)).rejects.toThrow("worker failed");
    });
  });

  test("outside a pinned context, callers retain their ordinary filesystem implementation", async () => {
    expect(pinnedOperation("/unused", "stat")).toBeNull();
    expect(await openPinnedStage("/unused", 0, 0)).toBeNull();
  });
});

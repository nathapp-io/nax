import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _atomicWriteDeps, writeFileAtomic } from "#src/internal/atomic-write";
import { withPinnedDirectory } from "#src/internal/pinned-directory";
import { withDepsRestore } from "#test/helpers/index";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-atomic-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  withDepsRestore(_atomicWriteDeps);

  test("writes the content and leaves no staging file behind", async () => {
    const path = join(dir, "doc.json");
    await writeFileAtomic(path, '{"v":1}');
    expect(await readFile(path, "utf8")).toBe('{"v":1}');
    expect(await readdir(dir)).toEqual(["doc.json"]);
  });

  test("a write that dies part-way leaves previous content intact and retains the stage", async () => {
    const path = join(dir, "doc.json");
    await writeFile(path, '{"v":1}');
    const realOpen = _atomicWriteDeps.open;
    _atomicWriteDeps.open = async (staged, flags, mode) => {
      const stage = await realOpen(staged, flags, mode);
      return {
        ...stage,
        write: async (content) => {
          await stage.write(typeof content === "string" ? content.slice(0, 3) : content);
          throw new Error("ENOSPC: no space left on device");
        },
      };
    };

    await expect(writeFileAtomic(path, '{"v":2,"long":"payload"}')).rejects.toThrow("ENOSPC");
    expect(await readFile(path, "utf8")).toBe('{"v":1}');
    const stages = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(stages).toHaveLength(1);
    expect(await readFile(join(dir, stages[0] ?? "", "stage"), "utf8")).toBe('{"v');
  });

  test("applies the requested file mode", async () => {
    const path = join(dir, "secret.json");
    await writeFileAtomic(path, "{}", { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("runs the caller's check after staging and before the rename", async () => {
    const path = join(dir, "doc.json");
    const order: string[] = [];
    const realOpen = _atomicWriteDeps.open;
    const realRename = _atomicWriteDeps.rename;
    _atomicWriteDeps.open = async (staged, flags, mode) => {
      const stage = await realOpen(staged, flags, mode);
      return {
        ...stage,
        write: async (content) => {
          order.push("stage");
          await stage.write(content);
        },
      };
    };
    _atomicWriteDeps.rename = async (from, to) => {
      order.push("rename");
      await realRename(from, to);
    };

    await writeFileAtomic(path, '{"v":2}', {
      beforePublish: async () => {
        order.push("check");
      },
    });

    expect(order).toEqual(["stage", "check", "rename"]);
  });

  test("a refused publish leaves previous content intact and retains its staged payload", async () => {
    const path = join(dir, "doc.json");
    await writeFile(path, '{"v":1}');
    const refusal = new Error("destination moved");

    await expect(
      writeFileAtomic(path, '{"v":2}', {
        beforePublish: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(await readFile(path, "utf8")).toBe('{"v":1}');
    const stages = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(stages).toHaveLength(1);
    expect(await readFile(join(dir, stages[0] ?? "", "stage"), "utf8")).toBe('{"v":2}');
  });

  test("a failure never removes a file this write did not stage", async () => {
    const path = join(dir, "doc.json");
    const realOpen = _atomicWriteDeps.open;
    let takenOver = "";
    _atomicWriteDeps.open = async (staged, flags, mode) => {
      const stage = await realOpen(staged, flags, mode);
      return {
        ...stage,
        write: async (content) => {
          await stage.write(content);
          // The stage directory this call created is taken away and someone else's file
          // appears under its name in the shared directory.
          takenOver = staged.replace(/\/[^/]+$/, "");
          await rm(takenOver, { recursive: true, force: true });
          await writeFile(takenOver, "someone else's file\n");
        },
      };
    };

    await expect(
      writeFileAtomic(path, "ours", {
        beforePublish: async () => {
          throw new Error("destination moved");
        },
      }),
    ).rejects.toThrow("destination moved");

    // `rmdir` clears a directory only when it is empty, and this name is not one any more.
    expect(await readFile(takenOver, "utf8")).toBe("someone else's file\n");
    expect(existsSync(path)).toBe(false);
  });

  test("a failed write preserves a replacement at the staging name", async () => {
    const realOpen = _atomicWriteDeps.open;
    const failure = new Error("write failed after replacement");
    let stageDir = "";
    _atomicWriteDeps.open = async (path, flags, mode) => {
      const stage = await realOpen(path, flags, mode);
      stageDir = path.replace(/\/[^/]+$/, "");
      return {
        ...stage,
        write: async () => {
          // The payload's name is taken over inside the namespace this call created.
          await rm(path);
          await writeFile(path, "not our stage");
          throw failure;
        },
      };
    };

    await expect(writeFileAtomic(join(dir, "doc.json"), "ours")).rejects.toBe(failure);
    // No pathname unlink can prove ownership of the replacement: retain it.
    expect(await readFile(join(stageDir, "stage"), "utf8")).toBe("not our stage");
    expect(await readdir(dir)).toEqual([stageDir.slice(dir.length + 1)]);
  });

  test("a stage this call could not create is never removed", async () => {
    let taken = "";
    _atomicWriteDeps.stage = async (path) => {
      taken = path;
      // The name is already someone else's file: the exclusive creation refuses, and nothing
      // this call does may reach what is already there.
      await writeFile(path, "not our stage");
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    };
    await expect(writeFileAtomic(join(dir, "doc.json"), "ours")).rejects.toThrow("EEXIST");
    expect(await readFile(taken, "utf8")).toBe("not our stage");
  });

  test("[B5] cleanup retains a stage containing foreign entries", async () => {
    const path = join(dir, "doc.json");
    const realDiscard = _atomicWriteDeps.discard;
    let stageDir = "";
    // A foreign entry appears while the write is failing. Cleanup only attempts rmdir:
    // neither our remaining payload nor the foreign entry may be unlinked by pathname.
    _atomicWriteDeps.discard = async (entry) => {
      stageDir = entry;
      await writeFile(join(entry, "foreign"), "not ours\n");
      await realDiscard(entry);
    };

    await expect(
      writeFileAtomic(path, "ours", {
        beforePublish: async () => {
          throw new Error("destination moved");
        },
      }),
    ).rejects.toThrow("destination moved");

    expect(stageDir.endsWith(".tmp")).toBe(true);
    expect((await stat(stageDir)).isDirectory()).toBe(true);
    expect((await stat(stageDir)).mode & 0o777).toBe(0o700);
    // The foreign entry survived, and so did the namespace holding it.
    expect(await readFile(join(stageDir, "foreign"), "utf8")).toBe("not ours\n");
    expect(existsSync(path)).toBe(false);
  });

  test("an identity failure never writes and retains the unverified payload", async () => {
    const realOpen = _atomicWriteDeps.open;
    const failure = new Error("fstat failed");
    let writes = 0;
    _atomicWriteDeps.open = async (path, flags, mode) => {
      const stage = await realOpen(path, flags, mode);
      return {
        ...stage,
        identity: async () => {
          throw failure;
        },
        write: async (content) => {
          writes++;
          await stage.write(content);
        },
      };
    };

    await expect(writeFileAtomic(join(dir, "doc.json"), "ours")).rejects.toBe(failure);
    expect(writes).toBe(0);
    const stages = await readdir(dir);
    expect(stages).toHaveLength(1);
    expect(await readFile(join(dir, stages[0] ?? "", "stage"), "utf8")).toBe("");
  });

  test.each([false, true])(
    "[B5] cleanup preserves a foreign payload after stage replacement (pinned=%s)",
    async (pinned) => {
      const parent = realpathSync(dir);
      const foreign = join(parent, "foreign");
      await mkdir(foreign);
      await writeFile(join(foreign, "stage"), "foreign payload");
      const realDiscard = _atomicWriteDeps.discard;
      let swapped = false;
      _atomicWriteDeps.discard = async (stageDir) => {
        await rename(stageDir, `${stageDir}.aside`);
        await symlink(foreign, stageDir);
        swapped = true;
        await realDiscard(stageDir);
      };
      const failure = new Error("publish refused");
      const action = () =>
        writeFileAtomic(join(parent, "doc.json"), "ours", {
          beforePublish: async () => {
            throw failure;
          },
        });

      await expect(
        pinned
          ? withPinnedDirectory(
              {
                path: parent,
                identity: await stat(parent),
                changed: () => new Error("parent moved"),
              },
              action,
            )
          : action(),
      ).rejects.toBe(failure);

      expect(swapped).toBe(true);
      expect(await readFile(join(foreign, "stage"), "utf8")).toBe("foreign payload");
    },
  );

  test("hands the published file's identity to the caller after the rename", async () => {
    const path = join(dir, "doc.json");
    const published: { dev: number; ino: number }[] = [];

    await writeFileAtomic(path, "ours", {
      afterPublish: async (stage) => {
        published.push(stage);
      },
    });

    const written = await stat(path);
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({ dev: written.dev, ino: written.ino });
  });
});

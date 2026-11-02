import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _atomicWriteDeps, writeFileAtomic } from "#src/internal/atomic-write";
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

  test("a write that dies part-way leaves the previous content intact and cleans up", async () => {
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
    expect(await readdir(dir)).toEqual(["doc.json"]);
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

  test("a refused publish leaves the previous content intact and no staging file behind", async () => {
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
    expect(await readdir(dir)).toEqual(["doc.json"]);
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
    // The stage went, and the entry that took its place went with it: nothing this call did
    // not create is left to identify, and the removal is scoped to its own namespace.
    expect(existsSync(stageDir)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
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

  test("[B5] the stage is an exclusively created namespace, and the cleanup is scoped to it", async () => {
    const path = join(dir, "doc.json");
    const realDiscard = _atomicWriteDeps.discard;
    let stageDir = "";
    // An entry that is not this call's appears inside the namespace while the write is
    // failing. The removal is one `rmdir` of a directory the call created exclusively, which
    // clears it only while it is empty — so what is left is retained, never swept by a stat.
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

  test("an identity failure neither writes nor leaves its stage behind", async () => {
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
    // The namespace is this call's whether or not a descriptor could be identified, so it goes.
    expect(await readdir(dir)).toEqual([]);
  });

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

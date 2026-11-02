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
    _atomicWriteDeps.open = async (staged, flags, mode) => {
      const stage = await realOpen(staged, flags, mode);
      return {
        ...stage,
        write: async (content) => {
          await stage.write(content);
          // The staged file is taken away and someone else's file appears under its name.
          await rm(staged);
          await writeFile(staged, "someone else's file\n");
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

    const staged = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(staged).toHaveLength(1);
    expect(await readFile(join(dir, staged[0] ?? ""), "utf8")).toBe("someone else's file\n");
    expect(existsSync(path)).toBe(false);
  });

  test("a failed write preserves a replacement at the staging name", async () => {
    const realOpen = _atomicWriteDeps.open;
    const failure = new Error("write failed after replacement");
    let replacement = "";
    _atomicWriteDeps.open = async (path, flags, mode) => {
      const stage = await realOpen(path, flags, mode);
      replacement = path;
      return {
        ...stage,
        write: async () => {
          await rm(path);
          await writeFile(path, "not our stage");
          throw failure;
        },
      };
    };

    await expect(writeFileAtomic(join(dir, "doc.json"), "ours")).rejects.toBe(failure);
    expect(await readFile(replacement, "utf8")).toBe("not our stage");
  });

  test("an open failure never removes an unowned staging entry", async () => {
    let replacement = "";
    _atomicWriteDeps.open = async (path) => {
      replacement = path;
      await writeFile(path, "not our stage");
      throw new Error("exclusive open refused");
    };
    await expect(writeFileAtomic(join(dir, "doc.json"), "ours")).rejects.toThrow("exclusive open refused");
    expect(await readFile(replacement, "utf8")).toBe("not our stage");
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

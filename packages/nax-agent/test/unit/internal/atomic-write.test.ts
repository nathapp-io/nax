import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    const realWrite = _atomicWriteDeps.writeFile;
    _atomicWriteDeps.writeFile = async (target, content, options) => {
      await realWrite(target, content.slice(0, 3), options);
      throw new Error("ENOSPC: no space left on device");
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
    const realWrite = _atomicWriteDeps.writeFile;
    const realRename = _atomicWriteDeps.rename;
    _atomicWriteDeps.writeFile = async (target, content, options) => {
      order.push("stage");
      await realWrite(target, content, options);
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
});

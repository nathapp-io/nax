import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { type PinnedWorkerFs, pinnedDirectoryWorker } from "#src/internal/pinned-directory-worker";
import { withTempDir } from "#test/helpers/index";

/** The flags every stage payload is created with: exclusive, and never through a link at it. */
const STAGE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

async function run(
  commands: { op: string; args: unknown[] }[],
  options: { anchor?: string | null; fs?: PinnedWorkerFs } = {},
): Promise<{ value?: unknown; code?: string; error?: string }[]> {
  const input = new PassThrough();
  const replies: { value?: unknown; code?: string; error?: string }[] = [];
  const work = pinnedDirectoryWorker(options.fs ?? fs, {
    input,
    createInterface,
    write: (text) => replies.push(JSON.parse(text)),
    ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
  });
  input.end(commands.map((command) => `${JSON.stringify(command)}\n`).join(""));
  await work;
  return replies;
}

describe("pinnedDirectoryWorker", () => {
  test("executes descriptor operations, publication and cleanup and reports filesystem errors", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "stage");
      const target = join(dir, "note");
      const replies = await run([
        { op: "directory", args: [] },
        { op: "open", args: [source, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600] },
        { op: "identity", args: [1] },
        { op: "write", args: [1, Buffer.from("payload").toString("base64")] },
        { op: "close", args: [1] },
        { op: "rename", args: [source, target] },
        { op: "stat", args: [target] },
        { op: "rm", args: [target] },
        { op: "stat", args: [target] },
        { op: "identity", args: [1] },
        { op: "invalid", args: [] },
      ]);
      expect(replies[0]?.value).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
      expect(replies[1]?.value).toBe(1);
      expect(replies[2]?.value).toEqual(replies[6]?.value);
      expect(replies[8]?.code).toBe("ENOENT");
      expect(replies[9]?.error).toContain("Unknown pinned descriptor");
      expect(replies[10]?.error).toContain("Unknown pinned operation");
      expect(await fs.readdir(dir)).toEqual([]);
    });
  });

  test("closes descriptors still open at EOF", async () => {
    await withTempDir(async (dir) => {
      const replies = await run([
        { op: "open", args: [join(dir, "stage"), constants.O_CREAT | constants.O_WRONLY, 0o600] },
      ]);
      expect(replies).toEqual([{ value: 1 }]);
    });
  });

  test("resolves an entry against the pinned cwd and reads it through its descriptor", async () => {
    await withTempDir(async (dir) => {
      const note = join(dir, "note");
      await fs.writeFile(note, "payload");

      const replies = await run([
        { op: "resolve", args: [note] },
        { op: "open", args: [note, constants.O_RDONLY | constants.O_NOFOLLOW, 0o666] },
        { op: "read", args: [1] },
        { op: "close", args: [1] },
        { op: "resolve", args: [join(dir, "missing")] },
      ]);

      expect(replies[0]?.value).toBe(await fs.realpath(note));
      expect(replies[1]?.value).toBe(1);
      expect(replies[2]?.value).toBe("payload");
      expect(replies[4]?.code).toBe("ENOENT");
    });
  });

  test("[B5] stage is exclusive and discard only removes an empty namespace", async () => {
    await withTempDir(async (dir) => {
      const stage = join(dir, "note.tmp");
      const replies = await run([
        { op: "stage", args: [stage, 0o700] },
        { op: "open", args: [join(stage, "stage"), STAGE_FLAGS, 0o600] },
        { op: "write", args: [1, Buffer.from("payload").toString("base64")] },
        { op: "close", args: [1] },
        { op: "discard", args: [stage, "stage"] },
      ]);

      expect(replies[1]?.value).toBe(1);
      // Nonempty stages are retained; exclusive creation does not establish ongoing ownership.
      expect(replies[4]?.code).toBe("ENOTEMPTY");
      expect(await fs.readFile(join(stage, "stage"), "utf8")).toBe("payload");
      const again = await run([{ op: "stage", args: [stage, 0o700] }]);
      expect(again[0]?.code).toBe("EEXIST");
      await fs.unlink(join(stage, "stage"));
      const emptied = await run([{ op: "discard", args: [stage] }]);
      expect(emptied[0]?.error).toBeUndefined();
      expect(await fs.readdir(dir)).toEqual([]);
    });
  });

  test("[B5] discard retains a namespace that still holds something", async () => {
    await withTempDir(async (dir) => {
      const stage = join(dir, "note.tmp");
      await fs.mkdir(stage);
      await fs.writeFile(join(stage, "foreign"), "not ours");

      const replies = await run([{ op: "discard", args: [stage, "stage"] }]);

      // `rmdir` clears a directory only when it is empty, so what is left is retained — and the
      // failure is reported rather than swallowed, which is what the caller's cleanup reads.
      expect(replies[0]?.code).toBe("ENOTEMPTY");
      expect(await fs.readFile(join(stage, "foreign"), "utf8")).toBe("not ours");
    });
  });

  test("[C1] resolve is spelled through the cwd anchor, not through a cwd the runtime spells", async () => {
    const pinnedIdentity = { dev: 7, ino: 11 };
    const asked: string[] = [];
    const anchoredFs: PinnedWorkerFs = {
      ...fs,
      // The anchor names this worker's own directory: the same inode as `.`.
      stat: async (path: string) => (path === "/pinned-anchor" || path === "." ? pinnedIdentity : fs.stat(path)),
      realpath: async (path: string) => {
        asked.push(path);
        return `/resolved/${path.slice("/pinned-anchor/".length)}`;
      },
    };

    const replies = await run([{ op: "resolve", args: ["note"] }], { anchor: "/pinned-anchor", fs: anchoredFs });

    // A relative realpath asks the runtime to spell the name, and a runtime that spells it from
    // a cached cwd resolves the name the directory left behind. The anchor is answered by the
    // kernel from the inode, so the entry still describes the directory the worker pinned.
    expect(asked).toEqual(["/pinned-anchor/note"]);
    expect(replies[0]?.value).toBe("/resolved/note");
  });

  test("[C1] an anchor that does not name the pinned directory is ignored", async () => {
    const asked: string[] = [];
    const foreignFs: PinnedWorkerFs = {
      ...fs,
      stat: async (path: string) => (path === "." ? { dev: 1, ino: 2 } : { dev: 3, ino: 4 }),
      realpath: async (path: string) => {
        asked.push(path);
        return "/resolved/note";
      },
    };

    await run([{ op: "resolve", args: ["note"] }], { anchor: "/another-directory", fs: foreignFs });

    // Verifying the anchor is what keeps a stale or wrong anchor from deciding the answer.
    expect(asked).toEqual(["note"]);
  });

  test("[C1] an anchor this host does not have falls back to the relative name", async () => {
    await withTempDir(async (dir) => {
      const note = join(dir, "note");
      await fs.writeFile(note, "payload");

      const replies = await run([{ op: "resolve", args: [note] }], { anchor: join(dir, "missing-anchor") });

      expect(replies[0]?.value).toBe(await fs.realpath(note));
    });
  });
});

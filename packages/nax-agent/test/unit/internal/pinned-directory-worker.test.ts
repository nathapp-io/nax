import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pinnedDirectoryWorker } from "#src/internal/pinned-directory-worker";
import { withTempDir } from "#test/helpers/index";

async function run(
  commands: { op: string; args: unknown[] }[],
): Promise<{ value?: unknown; code?: string; error?: string }[]> {
  const input = new PassThrough();
  const replies: { value?: unknown; code?: string; error?: string }[] = [];
  const work = pinnedDirectoryWorker(fs, {
    input,
    createInterface,
    write: (text) => replies.push(JSON.parse(text)),
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
});

/**
 * Runs in a dedicated process whose cwd pins a directory inode on POSIX, including
 * macOS (where /dev/fd/<dirfd>/name is not traversable). Never chdir in the caller:
 * its cwd is process-global. Keep this function self-contained for `node -e`.
 */
export async function pinnedDirectoryWorker(
  fs: typeof import("node:fs/promises"),
  io: {
    input: NodeJS.ReadableStream;
    write(text: string): unknown;
    createInterface: typeof import("node:readline").createInterface;
  },
): Promise<void> {
  const files = new Map<number, Awaited<ReturnType<typeof fs.open>>>();
  let next = 0;
  const identity = (info: { dev: number; ino: number }) => ({ dev: info.dev, ino: info.ino });
  const fileAt = (id: string) => {
    const file = files.get(Number(id));
    if (!file) throw new Error(`Unknown pinned descriptor: ${id}`); // nax-lint-allow: plain-error — isolated wire protocol, reconstructed as NaxError by caller
    return file;
  };
  const lines = io.createInterface({ input: io.input });
  for await (const line of lines) {
    try {
      const { op, args } = JSON.parse(line) as { op: string; args: [string, string, number] };
      let value: unknown;
      switch (op) {
        case "directory":
          value = identity(await fs.stat("."));
          break;
        case "open": {
          const handle = await fs.open(args[0], Number(args[1]), args[2]);
          files.set(++next, handle);
          value = next;
          break;
        }
        case "write":
          await fileAt(args[0]).writeFile(Buffer.from(args[1], "base64"));
          break;
        case "identity":
          value = identity(await fileAt(args[0]).stat());
          break;
        case "close": {
          await fileAt(args[0]).close();
          files.delete(Number(args[0]));
          break;
        }
        case "stat":
          value = identity(await fs.lstat(args[0]));
          break;
        case "rename":
          await fs.rename(args[0], args[1]);
          break;
        case "rm":
          await fs.rm(args[0], { force: true });
          break;
        default:
          throw new Error(`Unknown pinned operation: ${op}`); // nax-lint-allow: plain-error — isolated wire protocol, reconstructed as NaxError by caller
      }
      io.write(`${JSON.stringify({ value })}\n`);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      io.write(`${JSON.stringify({ error: failure.message, code: failure.code })}\n`);
    }
  }
  await Promise.all([...files.values()].map((file) => file.close()));
}

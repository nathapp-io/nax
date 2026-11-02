/**
 * The filesystem surface the worker drives: one member per operation it serves.
 *
 * Named rather than `typeof import("node:fs/promises")` so a test can answer a single
 * operation (the real module still satisfies it structurally, so the caller passes it as is).
 */
export interface PinnedWorkerFs {
  stat(path: string): Promise<{ readonly dev: number; readonly ino: number }>;
  lstat(path: string): Promise<{ readonly dev: number; readonly ino: number }>;
  open(
    path: string,
    flags: number,
    mode: number,
  ): Promise<{
    readFile(options: { encoding: "utf8" }): Promise<string>;
    writeFile(content: Uint8Array): Promise<void>;
    stat(): Promise<{ readonly dev: number; readonly ino: number }>;
    close(): Promise<void>;
  }>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options: { readonly mode: number }): Promise<string | undefined>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

/**
 * Runs in a dedicated process whose cwd pins a directory inode on POSIX, including
 * macOS (where /dev/fd/<dirfd>/name is not traversable). Never chdir in the caller:
 * its cwd is process-global. Keep this function self-contained for `node -e`.
 */
export async function pinnedDirectoryWorker(
  fs: PinnedWorkerFs,
  io: {
    input: NodeJS.ReadableStream;
    write(text: string): unknown;
    createInterface: typeof import("node:readline").createInterface;
    /**
     * An absolute path that names this worker's cwd *by inode* (Linux: `/proc/self/cwd`),
     * or null where the platform has none. See `anchored` below for what it buys.
     */
    anchor?: string | null;
  },
): Promise<void> {
  /**
   * Absolute spellings, for the one operation that cannot be spelled relatively.
   *
   * Every other operation hands the kernel a relative name, which it resolves against the
   * cwd inode: renaming the directory afterwards cannot redirect `open`, `rename` or `stat`.
   * `realpath` is the exception — it takes an absolute path, and a runtime that builds one
   * from a *cached* cwd string (Bun on Linux caches the spelling, not the inode) hands the
   * kernel the name the directory used to have, which a replacement can own. The anchor is
   * a magic link the kernel resolves to the inode itself, so the answer still describes the
   * directory this worker pinned.
   *
   * The anchor is checked against `.` before first use: an anchor the host does not have
   * (no `/proc`, or a foreign one) is dropped and the bare name used instead.
   */
  let anchor: string | null = io.anchor ?? null;
  if (anchor !== null) {
    try {
      const [at, dot] = [await fs.stat(anchor), await fs.stat(".")];
      if (at.dev !== dot.dev || at.ino !== dot.ino) anchor = null;
    } catch {
      // This host offers no such anchor; the relative name is all there is.
      anchor = null;
    }
  }
  const anchored = (name: string) => (anchor === null ? name : `${anchor}/${name}`);
  const files = new Map<number, Awaited<ReturnType<PinnedWorkerFs["open"]>>>();
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
        case "read":
          value = await fileAt(args[0]).readFile({ encoding: "utf8" });
          break;
        case "write":
          await fileAt(args[0]).writeFile(Buffer.from(args[1], "base64"));
          break;
        case "identity":
          value = identity(await fileAt(args[0]).stat());
          break;
        case "resolve":
          value = await fs.realpath(anchored(args[0]));
          break;
        case "stage":
          await fs.mkdir(args[0], { mode: Number(args[1]) });
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
        case "discard": {
          // The pinned parent does not pin a stage's own namespace: a writer of that
          // parent can replace it. Never unlink through it. rmdir removes only empty
          // directories and refuses final symlinks; nonempty stages are retained.
          await fs.rmdir(args[0]);
          break;
        }
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

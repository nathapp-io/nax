/** Injectable filesystem operations shared by the mirror and its archives. */
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { openPinnedRead, pinnedOperation, withPinnedDirectory } from "#src/internal/pinned-directory";
export interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** One open file: read through its descriptor, never through its path. */
export interface OpenedFile {
  readText(): Promise<string>;
  close(): Promise<void>;
}

/** Open one file for reading without following a link at it. */
type OpenFile = (path: string, flags: number) => Promise<OpenedFile>;
type StatPath = (path: string) => Promise<Identity>;
type MakeDir = (path: string, options: { recursive: true }) => Promise<string | undefined>;
/** Directory entries carry their type, so a listing never has to open a path to learn what it is. */
type ReadDirEntries = (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
type RemoveFile = (path: string, options: { force: true }) => Promise<void>;

function identityOf(info: { dev: number; ino: number }): Identity {
  return { dev: info.dev, ino: info.ino };
}

/** I/O seam: reads run under the pinned parent; deletes use the active one; `pin` takes it. */
export const _memoryStoreDeps: {
  open: OpenFile;
  stat: StatPath;
  lstat: StatPath;
  mkdir: MakeDir;
  readdir: ReadDirEntries;
  rm: RemoveFile;
  pin: typeof withPinnedDirectory;
} = {
  open: async (path, flags) => {
    const pinned = await openPinnedRead(path, flags);
    if (pinned !== null) return pinned;
    const handle = await open(path, flags);
    return {
      stat: async () => identityOf(await handle.stat()),
      readText: () => handle.readFile({ encoding: "utf8" }),
      close: () => handle.close(),
    };
  },
  stat: async (path) => identityOf(await stat(path)),
  lstat: async (path) => identityOf(await lstat(path)),
  mkdir: (path, options) => mkdir(path, options),
  readdir: (path, options) => readdir(path, options),
  rm: (path, options) => pinnedOperation<void>(path, "rm") ?? rm(path, options),
  pin: withPinnedDirectory,
};

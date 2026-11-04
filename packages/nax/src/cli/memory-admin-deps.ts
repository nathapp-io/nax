/**
 * The plumbing the two admin subcommands — `nax memory link` and `nax memory reset` — act
 * through: the filesystem seam, and the one shape a refusal takes.
 *
 * It lives here rather than in `memory-admin.ts` for the reason `memory-cli-deps.ts` lives beside
 * `memory.ts`: the registrar imports the modules that register their own subcommands, so the
 * seam and the error contract they share are not the registrar's to own, and a sibling that
 * needed `linkRefusal` would otherwise import it back and close a runtime cycle.
 *
 * Each seam member is a whole filesystem concept rather than one call: the text of a file that
 * may not exist (`null` rather than a throw), a write that creates its parent directories, a
 * rename, a directory listing that answers `[]` for an absent directory, and a recursive removal
 * that tolerates a missing path. A test overrides members to record a write, or to drive the
 * failure of one, without a mirror on disk.
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { NaxError } from "@/errors";

/** The `[stage]` label every line these commands print carries. */
export const STAGE = "memory";
/** The label a message starts with, so a quoted reason does not repeat it. */
export const STAGE_LABEL = "[memory] ";
/** The error code a refusal — a line, not a failure — is carried by. */
export const MEMORY_LINK_REFUSED = "MEMORY_LINK_REFUSED";
/** The code a reset's refusal is carried by: its own, so the two commands stay tellable apart. */
export const MEMORY_RESET_REFUSED = "MEMORY_RESET_REFUSED";

export const _memoryAdminDeps: {
  /** The file's text, or `null` when it does not exist. */
  readText(path: string): Promise<string | null>;
  /** Write `text` to `path`, creating the parent directories. */
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Entry names, or `[]` when the directory does not exist. */
  listDir(path: string): Promise<readonly string[]>;
  /** Remove `path` and everything under it; a missing path is not an error. */
  removePath(path: string): Promise<void>;
} = {
  readText: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  },
  writeText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, text);
  },
  rename: (from, to) => rename(from, to),
  listDir: readDirNames,
  removePath: (path) => rm(path, { recursive: true, force: true }),
};

/** The refusal a link answers with: a `[memory] …` line, exit 1, nothing written. */
export function linkRefusal(message: string, data: Record<string, unknown> = {}): NaxError {
  return new NaxError(`${STAGE_LABEL}${message}`, MEMORY_LINK_REFUSED, { stage: STAGE, ...data });
}

/**
 * The refusal a reset answers with: a `[memory] …` line, exit 1, nothing removed.
 *
 * Its own code rather than the link's, so a test and an operator can tell which of the two
 * commands refused without reading the message it printed.
 */
export function resetRefusal(message: string, data: Record<string, unknown> = {}): NaxError {
  return new NaxError(`${STAGE_LABEL}${message}`, MEMORY_RESET_REFUSED, { stage: STAGE, ...data });
}

/** One directory's entry names, or `[]` when it does not exist. */
async function readDirNames(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (cause) {
    if (isMissingPath(cause)) return [];
    throw cause;
  }
}

/** True when `cause` is the filesystem's own "no such file or directory". */
function isMissingPath(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

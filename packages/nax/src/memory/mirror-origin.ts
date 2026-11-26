/**
 * The mirror's record of the repository it belongs to.
 *
 * A mirror lives in the global nax directory under a name that is a segment plus a hash of
 * its canonical repository root, so nothing inside it says which checkout it mirrors. This
 * file says: `origin.json`, holding the realpath of the repository root and the project key
 * of the mirror. It is machine-local by design — the mirror directory itself never travels,
 * so neither does the root it names, and a mirror of a checkout that no longer exists is
 * reported as such rather than silently mistaken for another project's.
 *
 * The write is best effort. Origin is an inventory aid for `nax memory mirrors`; no session
 * reads it, so a mirror on a read-only or full disk still yields a working host. A failure
 * costs one warn and nothing else, and host composition carries on.
 *
 * An origin the mirror already holds is never rewritten. The repository root a mirror was
 * first opened from is the fact worth keeping: a later session may open the same mirror
 * through a different path (a symlink, a moved checkout) and must not overwrite the record
 * with its own.
 */
import type { Stats } from "node:fs";
import { link, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getProjectKey, type NaxConfig } from "@/config";
import type { MemoryLogger } from "./paths";

/** Stage every origin log line is written under. */
const LOG_STAGE = "memory";

/** The file, beside `notes/`, that names the repository this mirror belongs to. */
export const ORIGIN_FILE = "origin.json";

/**
 * Filesystem seam for tests: the four calls an origin write makes.
 *
 * `lstat`, not `stat`: presence is what decides whether the file is written, and a dangling
 * link at the origin's name is a file that is there.
 */
export const _mirrorOriginDeps: {
  realpath: (path: string) => Promise<string>;
  lstat: (path: string) => Promise<Stats>;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, text: string) => Promise<void>;
} = {
  realpath: (path: string): Promise<string> => realpath(path),
  lstat: (path: string): Promise<Stats> => lstat(path),
  mkdir: async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, text) => {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(tmp, text);
      try {
        await link(tmp, path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    } finally {
      await unlink(tmp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  },
};

/** Whether the mirror already records its origin. */
async function originPresent(path: string): Promise<boolean> {
  try {
    await _mirrorOriginDeps.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Record which repository a mirror belongs to, once.
 *
 * Nothing is written when the mirror already holds an origin, and a failure to write is a
 * warn rather than a rejection: the host that calls this must open whatever the disk does.
 *
 * @param input.projectDir - The mirror's own directory (created when it does not exist yet)
 * @param input.repoRoot - The repository root as the caller has it; stored as its realpath
 * @param input.config - Loaded nax config (only `name` is read, for the project key)
 * @param input.logger - Logger the one failure warn goes through
 */
export async function ensureMirrorOrigin(input: {
  readonly projectDir: string;
  readonly repoRoot: string;
  readonly config: Partial<Pick<NaxConfig, "name">>;
  readonly logger: MemoryLogger;
}): Promise<void> {
  const path = join(input.projectDir, ORIGIN_FILE);
  try {
    if (await originPresent(path)) return;
    const root = await _mirrorOriginDeps.realpath(input.repoRoot);
    const name = getProjectKey({ name: input.config.name ?? "" }, root);
    await _mirrorOriginDeps.mkdir(input.projectDir);
    await _mirrorOriginDeps.writeFile(path, `${JSON.stringify({ root, name }, null, 2)}\n`);
  } catch (error) {
    input.logger.warn(LOG_STAGE, "memory mirror origin not written", { path, error: errorMessage(error) });
  }
}

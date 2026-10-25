/**
 * Session files beside the S3 transcript (S5 spec §5.1): `<id>.session.json`
 * metadata, written as a temp file then renamed, and `<id>.lock`, created
 * exclusively. Nonce-owned locks use heartbeats to detect stale live pids;
 * legacy locks remain pid-based. Listing scans the metadata files.
 * Files that cannot be read are never rewritten or deleted here.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { acquireSessionLock, type SessionStorageDeps } from "./session-lock.ts";
import { MetaSchema, type SessionMeta } from "./session-meta.ts";

export type { SessionStorageDeps } from "./session-lock.ts";

export { LOCK_HEARTBEAT_MS, LOCK_STALE_MS } from "./session-lock.ts";

export const LIST_PAGE_SIZE = 50;
const META_SUFFIX = ".session.json";

export interface SessionListEntry {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly updatedAt: string;
}
export interface SessionListPage {
  sessions: SessionListEntry[];
  nextCursor?: string;
}

export interface SessionStorage {
  readonly dir: string;
  readMeta(sessionId: string): Promise<SessionMeta | null>;
  writeMeta(meta: SessionMeta): Promise<void>;
  hasMeta(sessionId: string): Promise<boolean>;
  removeMeta(sessionId: string): Promise<void>;
  /** Resolves to the release function; refuses with SESSION_LOCKED when another live process holds it. */
  acquireLock(sessionId: string): Promise<() => Promise<void>>;
  list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<SessionListPage>;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Signal 0 checks existence only. EPERM means the process exists under another user. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

function unreadable(sessionId: string, reason: string): NaxError {
  return new NaxError(`session metadata for "${sessionId}" is unreadable: ${reason}`, "SESSION_META_UNREADABLE", {
    stage: "session-store",
    sessionId,
  });
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const text = Buffer.from(cursor, "base64").toString("utf8");
  const offset = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(offset))
    throw new NaxError("invalid cursor", "SESSION_LIST_CURSOR_INVALID", { stage: "session-store" });
  return offset;
}

const sortKey = (meta: SessionMeta): string => meta.updatedAt ?? meta.createdAt;

function infoOf(meta: SessionMeta): SessionListEntry {
  return { sessionId: meta.sessionId, cwd: meta.cwd, title: meta.title, updatedAt: sortKey(meta) };
}

export function createSessionStorage(deps: SessionStorageDeps): SessionStorage {
  const isAlive = deps.isAlive ?? processAlive;
  const metaPath = (id: string): string => join(deps.dir, `${id}${META_SUFFIX}`);
  const lockPath = (id: string): string => join(deps.dir, `${id}.lock`);

  async function readMeta(sessionId: string): Promise<SessionMeta | null> {
    let text: string;
    try {
      text = await readFile(metaPath(sessionId), "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw unreadable(sessionId, errorMessage(error));
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw unreadable(sessionId, "invalid JSON");
    }
    const version: unknown =
      typeof json === "object" && json !== null && "schemaVersion" in json ? json.schemaVersion : undefined;
    if (version !== 1) throw unreadable(sessionId, `schemaVersion ${String(version)}; this build reads 1`);
    const parsed = MetaSchema.safeParse(json);
    if (!parsed.success) throw unreadable(sessionId, parsed.error.issues[0]?.message ?? "bad shape");
    return parsed.data;
  }

  async function acquireLock(sessionId: string): Promise<() => Promise<void>> {
    await mkdir(deps.dir, { recursive: true });
    return acquireSessionLock(lockPath(sessionId), deps, isAlive);
  }

  async function list(query: {
    readonly cwd?: string | null;
    readonly cursor?: string | null;
  }): Promise<SessionListPage> {
    const offset = decodeCursor(query.cursor);
    let names: string[];
    try {
      names = await readdir(deps.dir);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return { sessions: [] };
      throw error;
    }
    const metas: SessionMeta[] = [];
    for (const name of names.filter((n) => n.endsWith(META_SUFFIX))) {
      try {
        const meta = await readMeta(name.slice(0, -META_SUFFIX.length));
        if (meta !== null) metas.push(meta);
      } catch (error) {
        deps.logger.warn("session", "skipping unreadable session metadata", { file: name, error: errorMessage(error) });
      }
    }
    const matching = metas
      .filter((meta) => query.cwd === undefined || query.cwd === null || meta.cwd === query.cwd)
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    const end = offset + LIST_PAGE_SIZE;
    return {
      sessions: matching.slice(offset, end).map(infoOf),
      ...(end < matching.length ? { nextCursor: encodeCursor(end) } : {}),
    };
  }

  return {
    dir: deps.dir,
    readMeta,
    async writeMeta(meta) {
      await mkdir(deps.dir, { recursive: true });
      const path = metaPath(meta.sessionId);
      const temp = `${path}.${deps.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`);
      await rename(temp, path);
    },
    async hasMeta(sessionId) {
      try {
        await stat(metaPath(sessionId));
        return true;
      } catch {
        return false;
      }
    },
    async removeMeta(sessionId) {
      await rm(metaPath(sessionId), { force: true });
    },
    acquireLock,
    list,
  };
}

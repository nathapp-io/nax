/**
 * Session files beside the S3 transcript (S5 spec §5.1): `<id>.session.json`
 * metadata, written as a temp file then renamed, and `<id>.lock`, created
 * exclusively. A lock whose pid is dead, or that cannot be read, is stale and
 * taken over; a live one refuses the open. Listing scans the metadata files.
 * Files that cannot be read are never rewritten or deleted here.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ListSessionsResponse, RequestError, type SessionInfo } from "@agentclientprotocol/sdk";
import { type AgentLogger, NaxError } from "@nathapp/nax-agent";
import { z } from "zod";
import { invalidParams, messageOf } from "#src/server/errors";
import { BASH_APPROVALS, MODES } from "#src/server/nax-config";

export const LIST_PAGE_SIZE = 50;
const META_SUFFIX = ".session.json";

const MetaSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  mode: z.enum(MODES),
  model: z.string().min(1),
  bashApproval: z.enum(BASH_APPROVALS),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type SessionMeta = Readonly<z.infer<typeof MetaSchema>>;

const LockSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string() });

export interface SessionStorage {
  readonly dir: string;
  readMeta(sessionId: string): Promise<SessionMeta | null>;
  writeMeta(meta: SessionMeta): Promise<void>;
  hasMeta(sessionId: string): Promise<boolean>;
  removeMeta(sessionId: string): Promise<void>;
  /** Resolves to the release function; refuses with invalid_request when another live process holds it. */
  acquireLock(sessionId: string): Promise<() => Promise<void>>;
  list(query: { readonly cwd?: string | null; readonly cursor?: string | null }): Promise<ListSessionsResponse>;
}

export interface StorageDeps {
  readonly dir: string;
  readonly pid: number;
  readonly now: () => Date;
  readonly logger: AgentLogger;
  readonly isAlive?: (pid: number) => boolean;
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
    stage: "agent-server",
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
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(offset)) throw invalidParams("invalid cursor");
  return offset;
}

const sortKey = (meta: SessionMeta): string => meta.updatedAt ?? meta.createdAt;

function infoOf(meta: SessionMeta): SessionInfo {
  return { sessionId: meta.sessionId, cwd: meta.cwd, title: meta.title, updatedAt: sortKey(meta) };
}

export function createSessionStorage(deps: StorageDeps): SessionStorage {
  const isAlive = deps.isAlive ?? processAlive;
  const metaPath = (id: string): string => join(deps.dir, `${id}${META_SUFFIX}`);
  const lockPath = (id: string): string => join(deps.dir, `${id}.lock`);

  async function readMeta(sessionId: string): Promise<SessionMeta | null> {
    let text: string;
    try {
      text = await readFile(metaPath(sessionId), "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw unreadable(sessionId, messageOf(error));
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

  /** The pid holding the lock, or undefined when the lock cannot be read (stale). */
  async function lockHolder(path: string): Promise<number | undefined> {
    try {
      const parsed = LockSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      return parsed.success ? parsed.data.pid : undefined;
    } catch {
      return undefined;
    }
  }

  async function tryLock(path: string): Promise<boolean> {
    const body = JSON.stringify({ pid: deps.pid, startedAt: deps.now().toISOString() });
    try {
      await writeFile(path, body, { flag: "wx" });
      return true;
    } catch (error) {
      if (codeOf(error) === "EEXIST") return false;
      throw error;
    }
  }

  async function acquireLock(sessionId: string): Promise<() => Promise<void>> {
    await mkdir(deps.dir, { recursive: true });
    const path = lockPath(sessionId);
    const release = async (): Promise<void> => {
      await rm(path, { force: true });
    };
    if (await tryLock(path)) return release;
    const holder = await lockHolder(path);
    if (holder !== undefined && holder !== deps.pid && isAlive(holder)) {
      throw RequestError.invalidRequest(undefined, `session in use by pid ${holder}`);
    }
    deps.logger.info("session", "taking over a stale session lock", { sessionId, pid: holder });
    await rm(path, { force: true });
    if (await tryLock(path)) return release;
    throw RequestError.invalidRequest(undefined, "session in use by another process");
  }

  async function list(query: {
    readonly cwd?: string | null;
    readonly cursor?: string | null;
  }): Promise<ListSessionsResponse> {
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
        deps.logger.warn("session", "skipping unreadable session metadata", { file: name, error: messageOf(error) });
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

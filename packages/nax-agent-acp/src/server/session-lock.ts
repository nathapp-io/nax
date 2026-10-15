/** Local-filesystem ownership protocol. Critical check/mutate sequences do not yield. */
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { StorageDeps } from "#src/server/storage";

export const LOCK_HEARTBEAT_MS = 30_000;
export const LOCK_STALE_MS = 120_000;
const LockSchema = z.union([
  z.object({
    pid: z.number().int().positive(),
    startedAt: z.string(),
    nonce: z.string(),
    heartbeatAt: z.string().datetime(),
  }),
  z.object({
    pid: z.number().int().positive(),
    startedAt: z.string(),
    nonce: z.undefined(),
    heartbeatAt: z.undefined(),
  }),
]);
type Body = z.infer<typeof LockSchema>;
export const _lockDeps = { rename: renameSync, link: linkSync };

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
function read(path: string): { text?: string; body?: Body } {
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
    const parsed = LockSchema.safeParse(JSON.parse(text));
    return parsed.success ? { text, body: parsed.data } : { text };
  } catch {
    return text === undefined ? {} : { text };
  }
}
function same(a: ReturnType<typeof read>, b: ReturnType<typeof read>): boolean {
  if (a.body?.nonce !== undefined) return a.body.nonce === b.body?.nonce;
  if (a.body !== undefined)
    return b.body?.nonce === undefined && a.body.pid === b.body?.pid && a.body.startedAt === b.body.startedAt;
  return a.text === b.text;
}
const refused = (pid?: number) =>
  RequestError.invalidRequest(undefined, `session in use by ${pid === undefined ? "another process" : `pid ${pid}`}`);

function create(path: string, body: Body): boolean {
  const temp = `${path}.${body.nonce}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(body), { flag: "wx" });
    _lockDeps.link(temp, path);
    return true;
  } catch (error) {
    if (codeOf(error) === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

function takeover(path: string, body: Body, deps: StorageDeps, isAlive: (pid: number) => boolean): void {
  const old = read(path);
  const holder = old.body;
  const fresh =
    holder !== undefined &&
    holder.pid !== deps.pid &&
    isAlive(holder.pid) &&
    (holder.heartbeatAt === undefined || deps.now().getTime() - Date.parse(holder.heartbeatAt) <= LOCK_STALE_MS);
  if (fresh) throw refused(holder.pid);
  const stale = `${path}.${body.nonce}.stale`;
  try {
    _lockDeps.rename(path, stale);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
    // A failed rename is not permission to overwrite the winner.
    const raced = read(path);
    if (raced.body !== undefined || !create(path, body)) throw refused(raced.body?.pid);
    return;
  }
  if (!same(old, read(stale))) {
    // Never discard another owner's renamed file if restoration is blocked.
    try {
      _lockDeps.link(stale, path);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      throw refused();
    }
    rmSync(stale, { force: true });
    throw refused();
  }
  try {
    deps.logger.info("session", "taking over a stale session lock", { pid: holder?.pid });
    if (!create(path, body)) throw refused();
  } finally {
    rmSync(stale, { force: true });
  }
}

export function acquireSessionLock(
  path: string,
  deps: StorageDeps,
  isAlive: (pid: number) => boolean,
): () => Promise<void> {
  const stamp = deps.now().toISOString();
  const body = { pid: deps.pid, startedAt: stamp, nonce: randomUUID(), heartbeatAt: stamp };
  if (!create(path, body)) takeover(path, body, deps, isAlive);
  const timer = (deps.setInterval ?? setInterval)(() => {
    const temp = `${path}.${body.nonce}.tmp`;
    try {
      if (read(path).body?.nonce !== body.nonce) {
        clearInterval(timer);
        return;
      }
      body.heartbeatAt = deps.now().toISOString();
      writeFileSync(temp, JSON.stringify(body));
      if (read(path).body?.nonce === body.nonce) _lockDeps.rename(temp, path);
      else clearInterval(timer);
    } catch (error) {
      deps.logger.warn("session", "lock heartbeat failed", { path, error: String(error) });
    } finally {
      rmSync(temp, { force: true });
    }
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    if (read(path).body?.nonce === body.nonce) rmSync(path, { force: true });
  };
}

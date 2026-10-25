/** Local-filesystem ownership protocol. All lock mutations share an exclusive directory guard. */
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { AgentLogger } from "#src/infra/index";
import { NaxError } from "#src/infra/nax-error";
import { withSessionLockGuard as guarded, SessionLockGuardBusy } from "./session-lock-guard.ts";

export interface SessionStorageDeps {
  readonly dir: string;
  readonly pid: number;
  readonly now: () => Date;
  readonly logger: AgentLogger;
  readonly setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly isAlive?: (pid: number) => boolean;
}
export type SessionLockHolderState = "live" | "stale" | "own";

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
export const _lockDeps = { rename: renameSync, link: linkSync, remove: rmSync };

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
const refused = (pid?: number): NaxError =>
  new NaxError(`session in use by ${pid === undefined ? "another process" : `pid ${pid}`}`, "SESSION_LOCKED", {
    stage: "session-store",
    ...(pid !== undefined ? { pid } : {}),
  });

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

/** Shared snapshot classification; ownership takes precedence over liveness. */
export function holderState(
  body: Body,
  deps: SessionStorageDeps,
  isAlive: (pid: number) => boolean,
): SessionLockHolderState {
  if (body.pid === deps.pid) return "own";
  if (
    isAlive(body.pid) &&
    (body.heartbeatAt === undefined || deps.now().getTime() - Date.parse(body.heartbeatAt) <= LOCK_STALE_MS)
  ) {
    return "live";
  }
  return "stale";
}

function takeover(path: string, body: Body, deps: SessionStorageDeps, isAlive: (pid: number) => boolean): void {
  const old = read(path);
  const holder = old.body;
  if (holder !== undefined && holderState(holder, deps, isAlive) === "live") throw refused(holder.pid);
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

async function releaseOwnedLock(path: string, nonce: string): Promise<void> {
  for (;;) {
    try {
      guarded(path, () => {
        if (read(path).body?.nonce === nonce) _lockDeps.remove(path, { force: true });
      });
      return;
    } catch (error) {
      if (!(error instanceof SessionLockGuardBusy)) throw error;
      // Release owns cleanup until it can check the nonce under the guard.
      // Yield to the holder rather than abandoning a fresh lock on contention.
      // Unref'd: a deferred release after bounded shutdown never keeps the process alive.
      await sleep(10, undefined, { ref: false });
    }
  }
}

export function acquireSessionLock(
  path: string,
  deps: SessionStorageDeps,
  isAlive: (pid: number) => boolean,
): () => Promise<void> {
  const stamp = deps.now().toISOString();
  const body = { pid: deps.pid, startedAt: stamp, nonce: randomUUID(), heartbeatAt: stamp };
  guarded(path, () => {
    if (!create(path, body)) takeover(path, body, deps, isAlive);
  });
  const timer = (deps.setInterval ?? setInterval)(() => {
    const temp = `${path}.${body.nonce}.tmp`;
    try {
      guarded(path, () => {
        if (read(path).body?.nonce !== body.nonce) {
          clearInterval(timer);
          return;
        }
        body.heartbeatAt = deps.now().toISOString();
        writeFileSync(temp, JSON.stringify(body));
        _lockDeps.rename(temp, path);
      });
    } catch (error) {
      deps.logger.warn("session", "lock heartbeat failed", { path, error: String(error) });
    } finally {
      rmSync(temp, { force: true });
    }
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return async () => {
    try {
      // The heartbeat stays live while release waits out contention.
      await releaseOwnedLock(path, body.nonce);
    } finally {
      // A terminal release failure must let the lock age into stale recovery.
      clearInterval(timer);
    }
  };
}

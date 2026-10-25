/**
 * Pinning for discovered MCP tool sets — `.nax/mcp-lock.json`.
 *
 * Without it, attaching a server grants whatever that server advertises TODAY:
 * a server upgrade silently widens the grant. codebase-memory-mcp ships
 * `delete_project`, `index_repository` and `manage_adr`, so this is a real
 * capability risk rather than a theoretical one.
 *
 * Same posture as `bun.lock`: drift is visible and refreshing it is deliberate
 * (`nax mcp lock`). A tool that appears later, or whose input schema changes,
 * is withheld until a human re-locks.
 *
 * The lock has two homes. The project's `<root>/.nax/mcp-lock.json` wins
 * outright; when a project has none, `resolveMcpLock` falls back to the global
 * `<globalDir>/mcp-lock.json` that `nax mcp lock --global` writes, so an
 * operator who configures servers once does not have to lock in every project.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import type { McpToolDescriptor } from "./types";

export interface McpLockFile {
  readonly version: 1;
  /** server id -> tool name -> input-schema hash */
  readonly servers: Record<string, Record<string, string>>;
  /**
   * server id -> tool names an operator vouches are read-only. A server's own
   * `readOnlyHint` is untrusted; it takes effect only for a tool listed here.
   * A malformed value reads as none.
   */
  readonly readOnly?: Record<string, string[]>;
}

/**
 * A lock plus the file it was read from. `source` is a read-side annotation
 * only — `writeMcpLockAt` serialises `version` and `servers`, never this.
 */
export interface ResolvedMcpLock extends McpLockFile {
  /** Which file the lock was read from. Never written to disk. */
  readonly source: "project" | "global";
}

export const MCP_LOCK_FILENAME = "mcp-lock.json";
export const MCP_LOCK_REFRESH_COMMAND = "nax mcp lock";

export function mcpLockPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_NAX_DIR, MCP_LOCK_FILENAME);
}

/** The global lock lives beside `config.json`, not inside a project. */
export function globalMcpLockPath(globalDir?: string): string {
  return join(globalDir ?? globalConfigDir(), MCP_LOCK_FILENAME);
}

/** Key-sorted JSON, so a hash depends on the schema's content and not its serialisation order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
}

export function schemaHash(schema: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(schema) ?? null))
    .digest("hex")
    .slice(0, 16);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * The `readOnly` map when it is wholly `Record<string, string[]>`; anything else
 * (a string, an array, one bad entry) is none. Fail closed: a read-only grant
 * exists to skip an approval, so a file that is half wrong grants nothing.
 */
function wellFormedReadOnly(value: unknown): Record<string, string[]> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || !entries.every((entry) => isStringArray(entry[1]))) return undefined;
  return value as Record<string, string[]>;
}

/** Tool names the lock lists as read-only for `serverId`; empty for a missing or malformed entry. */
export function lockedReadOnlyTools(lock: McpLockFile | undefined, serverId: string): ReadonlySet<string> {
  const map = wellFormedReadOnly(lock?.readOnly);
  return new Set(map?.[serverId] ?? []);
}

/**
 * Parse a lock file. Missing and malformed both read as "nothing is pinned",
 * which withholds every tool. Failing closed is the point; a throw here would
 * abort a run over a file the operator may simply not have created yet.
 */
async function parseLockFile(path: string): Promise<McpLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as McpLockFile;
    if (parsed?.version !== 1 || typeof parsed.servers !== "object" || parsed.servers === null) return undefined;
    const { readOnly: rawReadOnly, ...rest } = parsed;
    const readOnly = wellFormedReadOnly(rawReadOnly);
    return readOnly === undefined ? rest : { ...rest, readOnly };
  } catch {
    return undefined;
  }
}

export async function readMcpLock(projectRoot: string): Promise<McpLockFile | undefined> {
  return parseLockFile(mcpLockPath(projectRoot));
}

/**
 * What a probe of the project lock path can conclude:
 * `present` (an entry is there, whatever it is), `absent` (`ENOENT` — nothing is
 * there), or `unreadable` (any other lookup error).
 */
type LockPresence = "present" | "absent" | "unreadable";

/** `ENOENT` — the only code that licenses "no project lock; consult the global one". */
const MISSING_CODE = "ENOENT";

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
}

/**
 * Is there an entry at `path`? `lstat`, not `stat`: a dangling symlink at the
 * project lock path is an entry — the operator's intent to have a project lock,
 * and the reason `nax mcp lock` will write there — while `stat` reports `ENOENT`
 * for it and would fall through to the global lock.
 *
 * Only `ENOENT` reads as absence. Every other error (`EACCES` on a parent
 * directory, `ELOOP` from a symlink loop) is `unreadable`, and `resolveMcpLock`
 * fails closed on it: withholding every tool is a visible failure, whereas
 * falling through to a broader global grant is a silent widening.
 */
async function lockPresence(path: string): Promise<LockPresence> {
  try {
    await lstat(path);
    return "present";
  } catch (err) {
    return errorCode(err) === MISSING_CODE ? "absent" : "unreadable";
  }
}

/**
 * Resolve the lock that governs `projectRoot`: a present project lock fully
 * overrides the global one.
 *
 * Existence is checked separately from parsing, and deliberately so: a
 * MALFORMED project lock fails closed rather than falling through to the global
 * lock, so a typo in the project file cannot silently swap in a wider grant.
 * The same applies to a project lock that cannot be looked up at all (B1) — the
 * global lock is consulted only on a confirmed absence.
 */
export async function resolveMcpLock(projectRoot: string, globalDir?: string): Promise<ResolvedMcpLock | undefined> {
  const projectPath = mcpLockPath(projectRoot);
  const presence = await lockPresence(projectPath);
  if (presence === "unreadable") return undefined;
  if (presence === "present") {
    const projectLock = await parseLockFile(projectPath);
    return projectLock === undefined ? undefined : { ...projectLock, source: "project" };
  }
  const globalLock = await parseLockFile(globalMcpLockPath(globalDir));
  return globalLock === undefined ? undefined : { ...globalLock, source: "global" };
}

/** Serialise a lock at an explicit path — the destination is the caller's choice. */
export async function writeMcpLockAt(path: string, lock: McpLockFile): Promise<void> {
  const servers = Object.fromEntries(
    Object.entries(lock.servers)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, tools]) => [
        id,
        Object.fromEntries(Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      ]),
  );
  await mkdir(dirname(path), { recursive: true });
  const readOnly = wellFormedReadOnly(lock.readOnly);
  const sortedReadOnly =
    readOnly === undefined
      ? {}
      : {
          readOnly: Object.fromEntries(
            Object.entries(readOnly)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([id, names]) => [id, [...names].sort()]),
          ),
        };
  await writeFile(path, `${JSON.stringify({ version: 1, servers, ...sortedReadOnly }, null, 2)}\n`);
}

export async function writeMcpLock(projectRoot: string, lock: McpLockFile): Promise<void> {
  await writeMcpLockAt(mcpLockPath(projectRoot), lock);
}

export interface WithheldTool {
  readonly name: string;
  readonly reason: "absent-from-lock" | "schema-changed";
}

export function applyLock(
  locked: Record<string, string> | undefined,
  discovered: readonly McpToolDescriptor[],
): { admitted: readonly McpToolDescriptor[]; withheld: readonly WithheldTool[] } {
  const admitted: McpToolDescriptor[] = [];
  const withheld: WithheldTool[] = [];
  for (const tool of discovered) {
    const pinned = locked?.[tool.name];
    if (pinned === undefined) withheld.push({ name: tool.name, reason: "absent-from-lock" });
    else if (pinned !== schemaHash(tool.inputSchema)) withheld.push({ name: tool.name, reason: "schema-changed" });
    else admitted.push(tool);
  }
  return { admitted, withheld };
}

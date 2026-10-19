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
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import type { McpToolDescriptor } from "./types";

export interface McpLockFile {
  readonly version: 1;
  /** server id -> tool name -> input-schema hash */
  readonly servers: Record<string, Record<string, string>>;
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

/**
 * Parse a lock file. Missing and malformed both read as "nothing is pinned",
 * which withholds every tool. Failing closed is the point; a throw here would
 * abort a run over a file the operator may simply not have created yet.
 */
async function parseLockFile(path: string): Promise<McpLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as McpLockFile;
    if (parsed?.version !== 1 || typeof parsed.servers !== "object" || parsed.servers === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function readMcpLock(projectRoot: string): Promise<McpLockFile | undefined> {
  return parseLockFile(mcpLockPath(projectRoot));
}

/**
 * True for ANY filesystem entry at `path`, file or not. `Bun.file(path).exists()`
 * is false for a directory, which would let a stray directory at the project
 * lock path fall through to the global lock — the one outcome AC-3 forbids.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the lock that governs `projectRoot`: a present project lock fully
 * overrides the global one.
 *
 * Existence is checked separately from parsing, and deliberately so: a
 * MALFORMED project lock fails closed rather than falling through to the global
 * lock, so a typo in the project file cannot silently swap in a wider grant.
 */
export async function resolveMcpLock(projectRoot: string, globalDir?: string): Promise<ResolvedMcpLock | undefined> {
  const projectPath = mcpLockPath(projectRoot);
  if (await pathExists(projectPath)) {
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
  await writeFile(path, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`);
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

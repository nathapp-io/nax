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
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_NAX_DIR } from "@/config";
import type { McpToolDescriptor } from "./types";

export interface McpLockFile {
  readonly version: 1;
  /** server id -> tool name -> input-schema hash */
  readonly servers: Record<string, Record<string, string>>;
}

export const MCP_LOCK_FILENAME = "mcp-lock.json";
export const MCP_LOCK_REFRESH_COMMAND = "nax mcp lock";

export function mcpLockPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_NAX_DIR, MCP_LOCK_FILENAME);
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

export async function readMcpLock(projectRoot: string): Promise<McpLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(mcpLockPath(projectRoot), "utf8")) as McpLockFile;
    if (parsed?.version !== 1 || typeof parsed.servers !== "object" || parsed.servers === null) return undefined;
    return parsed;
  } catch {
    // Missing or malformed both mean "nothing is pinned", which withholds every
    // tool. Failing closed is the point; a throw here would abort a run over a
    // file the operator may simply not have created yet.
    return undefined;
  }
}

export async function writeMcpLock(projectRoot: string, lock: McpLockFile): Promise<void> {
  const servers = Object.fromEntries(
    Object.entries(lock.servers)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, tools]) => [
        id,
        Object.fromEntries(Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      ]),
  );
  await mkdir(join(projectRoot, PROJECT_NAX_DIR), { recursive: true });
  await writeFile(mcpLockPath(projectRoot), `${JSON.stringify({ version: 1, servers }, null, 2)}\n`);
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

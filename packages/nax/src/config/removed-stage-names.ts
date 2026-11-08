/**
 * Removed stage names — warn-and-strip compatibility for the stages no
 * operation runs in since pipeline mode was removed.
 *
 * `rectification`, `regression` and `acceptance` are still registry members
 * here (US-006 contracts the enums); this module is the compatibility layer
 * that keeps an existing config loading while its author migrates. Two
 * surfaces carry those names:
 *
 *   - `mcp.servers.<id>.stages` — the stages an MCP server attaches to. A
 *     removed name is dropped from the list. A server whose list becomes empty
 *     STAYS: an empty list attaches the server to no stage
 *     (`providerAttachesTo`, packages/nax-agent/src/tools/provider-types.ts),
 *     which is what the removed stage did to it as well.
 *   - `execution.permissions.<stage>` — a per-stage permission block. A block
 *     another block INHERITS is kept: dropping it would leave the inheriting
 *     block pointing at a block that is not there. The inheritance is judged
 *     against the INPUT, before any block is dropped, so a template whose only
 *     user is itself removed stays — no transitive removal.
 *
 * This is prerequisite behaviour, not a schema relaxation: a stage name no
 * registry member covers is still a schema error once the existing schemas
 * run.
 *
 * The strip mirrors `stripRemovedNoOpKeys` (config-guards.ts): it rebuilds the
 * objects above the change instead of mutating them, and tolerates missing and
 * non-object intermediates.
 */

import { stripRemovedNoOpKeys } from "./config-guards";

/** Stage names no operation runs in since pipeline mode was removed. */
export const REMOVED_STAGE_NAMES: readonly string[] = ["rectification", "regression", "acceptance"];

const REMOVED_STAGE_HINT = "no nax operation runs in this stage since pipeline mode was removed";

/** Membership lookup for the removed names — read once per stage-list element. */
const REMOVED_STAGE_SET: ReadonlySet<string> = new Set(REMOVED_STAGE_NAMES);

/** The sink every strip in this module writes its warnings to. */
type WarnSink = (msg: string) => void;

/** A plain object — not null, not an array. Every level below must be one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop the removed stage names from one server's `stages` list.
 *
 * Returns the server unchanged when nothing was dropped, so the caller can
 * rebuild only the objects that actually changed.
 */
function stripServerStages(serverId: string, server: unknown, warn?: WarnSink): unknown {
  if (!isRecord(server)) return server;
  const stages = server.stages;
  if (!Array.isArray(stages)) return server;

  const kept = stages.filter((stage) => {
    if (typeof stage !== "string" || !REMOVED_STAGE_SET.has(stage)) return true;
    warn?.(
      `Config value "${stage}" in mcp.servers.${serverId}.stages has been removed — ${REMOVED_STAGE_HINT}. Remove it from your config.`,
    );
    return false;
  });
  if (kept.length === stages.length) return server;
  return { ...server, stages: kept };
}

/**
 * Drop the removed stage names from every `mcp.servers.<id>.stages` list.
 *
 * Returns null when no server carried one, so the caller keeps the config it
 * was given rather than rebuilding an identical one.
 */
function stripMcpStageNames(conf: Record<string, unknown>, warn?: WarnSink): Record<string, unknown> | null {
  const mcp = conf.mcp;
  if (!isRecord(mcp)) return null;
  const servers = mcp.servers;
  if (!isRecord(servers)) return null;

  let changed = false;
  const entries: [string, unknown][] = [];
  for (const [serverId, server] of Object.entries(servers)) {
    const stripped = stripServerStages(serverId, server, warn);
    if (stripped !== server) changed = true;
    entries.push([serverId, stripped]);
  }
  if (!changed) return null;
  // `Object.fromEntries` defines each key as an own data property, so a server
  // id of "__proto__" cannot reach the prototype setter the way a plain
  // assignment would.
  return { ...conf, mcp: { ...mcp, servers: Object.fromEntries(entries) } };
}

/**
 * Whether a block OTHER than `name` inherits it.
 *
 * A sibling that is null, or holds any other non-object shape, names no
 * inherit target and is skipped by the scan.
 */
function isInheritedBySibling(permissions: Record<string, unknown>, name: string): boolean {
  for (const [key, block] of Object.entries(permissions)) {
    if (key === name) continue;
    if (!isRecord(block)) continue;
    if (block.inherit === name) return true;
  }
  return false;
}

/**
 * Drop the `execution.permissions.<removed>` blocks that nothing inherits.
 *
 * Returns null when no removed block is present. The inheritance scan runs
 * against the blocks as they arrived, so a removed template that a removed
 * block inherited stays — dropping it would be a transitive removal.
 */
function stripRemovedPermissionBlocks(conf: Record<string, unknown>, warn?: WarnSink): Record<string, unknown> | null {
  const execution = conf.execution;
  if (!isRecord(execution)) return null;
  const permissions = execution.permissions;
  if (!isRecord(permissions)) return null;

  const dropped = new Set<string>();
  for (const name of REMOVED_STAGE_NAMES) {
    if (!Object.hasOwn(permissions, name)) continue;
    if (isInheritedBySibling(permissions, name)) continue;
    dropped.add(name);
  }
  if (dropped.size === 0) return null;

  for (const name of dropped) {
    warn?.(
      `Config key "execution.permissions.${name}" has been removed — ${REMOVED_STAGE_HINT}. Remove it from your config.`,
    );
  }
  const nextPermissions = Object.fromEntries(Object.entries(permissions).filter(([key]) => !dropped.has(key)));
  return { ...conf, execution: { ...execution, permissions: nextPermissions } };
}

/**
 * Drop removed stage names from `mcp.servers.<id>.stages` and drop
 * un-inherited `execution.permissions.<removed>` blocks, warning once per
 * dropped item.
 *
 * @param conf - Raw config object (post-merge, pre-`safeParse`).
 * @param warn - Optional sink; called once per dropped item.
 * @returns A new object with the removed names stripped. The input is never
 *   mutated.
 */
export function stripRemovedStageNames(
  conf: Record<string, unknown>,
  warn?: (msg: string) => void,
): Record<string, unknown> {
  const withoutMcp = stripMcpStageNames(conf, warn) ?? conf;
  const result = stripRemovedPermissionBlocks(withoutMcp, warn) ?? withoutMcp;
  // Return a new top-level object even when no name matched, so callers can
  // treat the result as owned (mirrors stripRemovedNoOpKeys).
  return result === conf ? { ...conf } : result;
}

/**
 * `stripRemovedNoOpKeys`, then `stripRemovedStageNames`, with one sink.
 *
 * The loader calls this at every site that used to strip the removed no-op
 * keys alone, so a config that names BOTH a retired no-op key and a removed
 * stage is reported once per item, in one pass.
 */
export function stripRemovedConfig(
  conf: Record<string, unknown>,
  warn?: (msg: string) => void,
): Record<string, unknown> {
  return stripRemovedStageNames(stripRemovedNoOpKeys(conf, warn), warn);
}

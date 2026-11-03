/**
 * mcp-provider.ts — a MemoryProvider over one configured MCP memory server.
 *
 * The mirror stays the store every surface reads; this provider only hands saves
 * to the server's add tool, answers `search` from its search tool and, when a
 * forget tool is configured, deletes the remote copies a save recorded in the
 * id map. It never pulls: an MCP memory tool exposes no change cursor.
 *
 * Refusals: a configured tool the connected server does not list is permanent
 * (`MEMORY_PUSH_REJECTED`). A server that lists no tools (not connected) is
 * `MEMORY_MCP_UNAVAILABLE`, and a tool that answers `isError` is
 * `MEMORY_MCP_CALL_FAILED`; both are retryable, so the outbox keeps the write.
 */

import type { MemoryHit, MemoryPage, MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { MemoryMcpConfig } from "@/config";
import { NaxError } from "@/errors";
import type { McpPool } from "@/mcp";
import type { McpIdMap } from "./mcp-id-map";
import { mcpHitOf, parseMcpMemoryIds, parseMcpMemoryItems } from "./mcp-results";
import type { MemoryLogger } from "./paths";

/** The prefix of an MCP provider's id: `mcp:<server>`. */
export const MEMORY_MCP_PROVIDER_PREFIX = "mcp:";
/** The byte cap on one tool answer read from a memory server. */
export const MCP_MEMORY_RESULT_MAX_BYTES = 65_536;

const STAGE = "memory";

export interface CreateMcpMemoryProviderInput {
  readonly pool: Pick<McpPool, "listTools" | "call">;
  readonly serverId: string;
  readonly workdir: string;
  readonly mcp: MemoryMcpConfig;
  readonly idMap: McpIdMap;
  readonly logger: MemoryLogger;
  readonly callTimeoutMs: number;
}

function pushRejected(message: string): NaxError {
  return new NaxError(message, "MEMORY_PUSH_REJECTED", { stage: STAGE });
}

/**
 * Create the provider for one memory server.
 *
 * @param input - The pool, the server's id, the memory.mcp tool/argument names and the id map
 */
export function createMcpMemoryProvider(input: CreateMcpMemoryProviderInput): MemoryProvider {
  const { pool, serverId, workdir, mcp, idMap, logger, callTimeoutMs } = input;
  const callOpts = { timeoutMs: callTimeoutMs, maxBytes: MCP_MEMORY_RESULT_MAX_BYTES };

  /** The server's tool names; a server that lists none, or whose listing fails, is unavailable. */
  async function listedTools(): Promise<ReadonlySet<string>> {
    let names: ReadonlySet<string> | undefined;
    let cause: unknown;
    try {
      names = new Set((await pool.listTools(serverId, workdir)).map((tool) => tool.name));
    } catch (error) {
      cause = error;
    }
    if (names === undefined || names.size === 0) {
      const detail = cause === undefined ? "it lists no tools" : errorMessage(cause);
      throw new NaxError(
        `[memory] MCP memory server "${serverId}" is unavailable: ${detail}`,
        "MEMORY_MCP_UNAVAILABLE",
        {
          stage: STAGE,
          serverId,
          retryable: true,
          ...(cause === undefined ? {} : { cause }),
        },
      );
    }
    return names;
  }

  /** Check a connected server lists `tool`; a missing one is a permanent refusal. */
  async function requireTool(tool: string): Promise<void> {
    if (!(await listedTools()).has(tool)) {
      throw pushRejected(`[memory] MCP memory server "${serverId}" has no tool "${tool}"`);
    }
  }

  function callFailed(tool: string, content: string): NaxError {
    return new NaxError(
      `[memory] MCP memory server "${serverId}" tool "${tool}" failed: ${content}`,
      "MEMORY_MCP_CALL_FAILED",
      { stage: STAGE, serverId, tool, retryable: true },
    );
  }

  async function save(request: MemoryWriteRequest): Promise<MemoryPushResult> {
    const note = request.note;
    if (note === undefined) throw pushRejected(`memory save for "${request.slug}" carries no note`);
    const tool = mcp.tools.add;
    await requireTool(tool);
    const text = `${note.slug}: ${note.description}\n\n${note.body}`;
    const result = await pool.call(serverId, workdir, tool, { [mcp.args.text]: text }, callOpts);
    if (result.isError) throw callFailed(tool, result.content);
    const ids = parseMcpMemoryIds(result.content);
    if (ids.length > 0) await idMap.add(request.scope, request.slug, ids);
    return { id: note.id, status: "active" };
  }

  async function forgetRemote(tool: string, idArg: string, id: string): Promise<void> {
    try {
      const result = await pool.call(serverId, workdir, tool, { [idArg]: id }, callOpts);
      if (result.isError) {
        logger.warn(STAGE, "memory mcp forget failed", { server: serverId, id, error: result.content });
      }
    } catch (error) {
      logger.warn(STAGE, "memory mcp forget failed", { server: serverId, id, error: errorMessage(error) });
    }
  }

  async function forget(request: MemoryWriteRequest): Promise<MemoryPushResult> {
    const deleted: MemoryPushResult = { id: request.clientId, status: "deleted" };
    const tool = mcp.tools.forget;
    if (tool === undefined) {
      await idMap.drop(request.scope, request.slug);
      return deleted;
    }
    const ids = await idMap.ids(request.scope, request.slug);
    if (ids.length === 0) return deleted;
    const idArg = mcp.args.id;
    if (idArg === undefined) throw pushRejected(`[memory] memory.mcp.args.id is required with memory.mcp.tools.forget`);
    await requireTool(tool);
    for (const id of ids) await forgetRemote(tool, idArg, id);
    await idMap.drop(request.scope, request.slug);
    return deleted;
  }

  return {
    id: `${MEMORY_MCP_PROVIDER_PREFIX}${serverId}`,
    // An MCP memory tool exposes no change cursor: nothing is pulled and nothing is faked.
    pull: async (): Promise<MemoryPage> => ({ notes: [], done: true }),
    push: (request) => (request.kind === "save" ? save(request) : forget(request)),
    async search({ scope, text, limit }): Promise<readonly MemoryHit[]> {
      const tool = mcp.tools.search;
      const result = await pool.call(serverId, workdir, tool, { [mcp.args.query]: text }, callOpts);
      if (result.isError) throw callFailed(tool, result.content);
      return parseMcpMemoryItems(result.content)
        .map((item, index) => mcpHitOf(item, index, scope))
        .slice(0, Math.max(0, limit));
    },
    async reachable(): Promise<boolean> {
      try {
        return (await pool.listTools(serverId, workdir)).length > 0;
      } catch {
        // A rejection (an untrusted repository, a pool failure) is the same fact as no tools: not reachable.
        return false;
      }
    },
  };
}

/**
 * mcp-provider.ts — a MemoryProvider over one configured MCP memory server.
 *
 * The mirror stays the store every surface reads; this provider only hands saves
 * to the server's add tool, answers `search` from its search tool and, when a
 * forget tool is configured, deletes the remote copies a save recorded in the
 * id map. It never pulls: an MCP memory tool exposes no change cursor.
 *
 * The add is a NON-REPLAYABLE write (`replay`, US-001's contract): the server
 * takes the note's text, not an idempotency key, so an add whose reply was lost
 * may have been applied, and sending it again makes a second note. Everything
 * that decides what a failed add means is therefore the caller's, not this
 * file's — the operations layer and the drain hold such a write as an unknown
 * outcome, with its client id, instead of dispatching it again. The add is also
 * dispatched `at-most-once` through the pool, so a lost connection does not buy
 * a second attempt either. `timeoutAftermath` is `"late"`: the pool's deadline
 * abandons the wait, not the request, so an add that outlives it may still
 * arrive.
 *
 * A delete names a remote id, so repeating it cannot resurrect or duplicate a
 * note: `forget` and the search lookup stay replay-safe, and an interrupted one
 * keeps the pool's bounded retry.
 *
 * A server with no delete tool cannot delete a copy it still holds. Such a
 * forget hides the copy instead: its id moves to the id map's `hidden` list and
 * the search drops every item whose id is hidden, so nax no longer shows a note
 * it forgot. The copy itself stays on the server, where every other client of
 * that server still sees it.
 *
 * Refusals: a configured tool the connected server does not list is permanent
 * (`MEMORY_PUSH_REJECTED`). A server that lists no tools (not connected) is
 * `MEMORY_MCP_UNAVAILABLE`, and a tool that answers `isError` is
 * `MEMORY_MCP_CALL_FAILED`; both are retryable, so the outbox keeps the write —
 * unless the write is the non-replayable add, which is held instead (above).
 *
 * A forget whose remote delete failed refuses with `MEMORY_MCP_CALL_FAILED` when
 * the call threw and `MEMORY_MCP_FORGET_BAD_RESPONSE` when the server answered
 * `isError`. The first is an outage: the entry waits for the server. The second
 * repeats the same way every time, so the drain counts it and parks the forget
 * rather than letting it block the outbox for good.
 */

import {
  type MemoryHit,
  type MemoryPage,
  type MemoryProvider,
  type MemoryPushResult,
  type MemoryWriteRequest,
  markUndispatched,
} from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { MemoryMcpConfig } from "@/config";
import { NaxError } from "@/errors";
import type { McpCallResult, McpPool, McpReplaySafety } from "@/mcp";
import type { McpIdMap } from "./mcp-id-map";
import { type McpMemoryItem, mcpHitOf, parseMcpMemoryIds, parseMcpMemoryItems } from "./mcp-results";
import type { MemoryLogger } from "./paths";

/** The prefix of an MCP provider's id: `mcp:<server>`. */
export const MEMORY_MCP_PROVIDER_PREFIX = "mcp:";
/** The byte cap on one tool answer read from a memory server. */
export const MCP_MEMORY_RESULT_MAX_BYTES = 65_536;

/**
 * What the add is dispatched as: a write nax never sends twice.
 *
 * The server's add tool takes the note's text and no idempotency key, so a second dispatch is a
 * second note. Declared here, at the call, because the pool must not infer it from the tool's
 * name — a name says nothing about what the server does with a repeat.
 */
const ADD_REPLAY_SAFETY: McpReplaySafety = "at-most-once";

/** A delete names its remote id, and a search reads: both may be repeated after an interruption. */
const REPLAY_SAFE: McpReplaySafety = "replay-safe";

/**
 * What this provider declares about repeating a write, as US-001's contract takes it.
 *
 * Only the save is withheld: a dispatched add that left no answer may have been applied. The
 * forget is not listed because it cannot duplicate anything — it deletes the ids the id map
 * records, and an id it already deleted simply answers that it is gone.
 */
const MEMORY_MCP_REPLAY = { nonReplayable: ["save"], timeoutAftermath: "late" } as const;

const STAGE = "memory";

/** The codes a failed MCP tool call refuses with. */
type ToolFailureCode = "MEMORY_MCP_CALL_FAILED" | "MEMORY_MCP_FORGET_BAD_RESPONSE";

/** One failed remote delete: the server answered `isError`, or the transport threw. */
interface ForgetFailure {
  readonly kind: "answered" | "threw";
  readonly text: string;
}

/** One item of a search answer, with the position it had in that answer. */
interface PositionedItem {
  readonly item: McpMemoryItem;
  readonly index: number;
}

/**
 * The items of a search answer nax still shows, each with the position it had in the answer.
 *
 * A hidden id is a copy the server still holds after nax forgot the note, so it is dropped
 * before the limit is cut: the limit counts the hits that are shown. The position is the
 * item's own, so an item with no id keeps the slug it had in the answer.
 */
function visibleItems(items: readonly McpMemoryItem[], hidden: ReadonlySet<string>): readonly PositionedItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.id === undefined || !hidden.has(item.id));
}

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

  /**
   * The discovery the add needs, with its failure marked as one that preceded any dispatch.
   *
   * Finding the tool (`requireTool`) comes before the call, so a listing that fails there cannot
   * have sent an add: the write is a definite unsent one and the next sync may deliver it. A
   * probe that answers first is no proof of anything — reachability asks the same server a
   * moment earlier, and the listing this call needs can still fail (B2). The permanent case stays
   * as it is: a server that lists a different set of tools has refused the write for good, and
   * `MEMORY_PUSH_REJECTED` is what says so. Anything that is not one of this file's own errors is
   * rethrown unmarked, which keeps it on the unknown-delivery side rather than claiming it never
   * left the process.
   */
  async function discoverAddTool(tool: string): Promise<void> {
    try {
      await requireTool(tool);
    } catch (error) {
      if (error instanceof NaxError && error.code !== "MEMORY_PUSH_REJECTED") throw markUndispatched(error);
      throw error;
    }
  }

  /** A tool call that failed: the server and the tool named, and the answer's own text. */
  function callFailed(tool: string, content: string, code: ToolFailureCode): NaxError {
    return new NaxError(`[memory] MCP memory server "${serverId}" tool "${tool}" failed: ${content}`, code, {
      stage: STAGE,
      serverId,
      tool,
      retryable: true,
    });
  }

  async function save(request: MemoryWriteRequest): Promise<MemoryPushResult> {
    const note = request.note;
    if (note === undefined) throw pushRejected(`memory save for "${request.slug}" carries no note`);
    const tool = mcp.tools.add;
    await discoverAddTool(tool);
    const text = `${note.slug}: ${note.description}\n\n${note.body}`;
    const result = await pool.call(
      serverId,
      workdir,
      tool,
      { [mcp.args.text]: text },
      {
        ...callOpts,
        replaySafety: ADD_REPLAY_SAFETY,
      },
    );
    if (result.isError) throw addFailure(tool, result);
    const ids = parseMcpMemoryIds(result.content);
    if (ids.length > 0) await idMap.add(request.scope, request.slug, ids);
    return { id: note.id, status: "active" };
  }

  /**
   * A failed add: the pool's own answer, marked when the pool says no connection could take the
   * call (`dispatch: "never"`). The add is the one write nax may not repeat, so the difference
   * between "may have committed" and "was certainly never sent" decides whether the note waits in
   * the outbox for the next sync or is parked as an unknown delivery nobody can resolve.
   */
  function addFailure(tool: string, result: McpCallResult): NaxError {
    const failed = callFailed(tool, result.content, "MEMORY_MCP_CALL_FAILED");
    return result.dispatch === "never" ? markUndispatched(failed) : failed;
  }

  /**
   * Delete one remote id.
   *
   * A delete that went through answers `undefined`; a failure answers what went wrong: the
   * server's own text for an `isError` answer, the transport's message for a throw. The warn
   * stays, so a failing delete is still visible in the log under the id it failed for.
   */
  async function forgetRemote(tool: string, idArg: string, id: string): Promise<ForgetFailure | undefined> {
    try {
      const result = await pool.call(
        serverId,
        workdir,
        tool,
        { [idArg]: id },
        { ...callOpts, replaySafety: REPLAY_SAFE },
      );
      if (!result.isError) return undefined;
      logger.warn(STAGE, "memory mcp forget failed", { server: serverId, id, error: result.content });
      return { kind: "answered", text: result.content };
    } catch (error) {
      const text = errorMessage(error);
      logger.warn(STAGE, "memory mcp forget failed", { server: serverId, id, error: text });
      return { kind: "threw", text };
    }
  }

  /** Delete every recorded id, in order: the ones that went, and the ones that failed. */
  async function deleteEach(
    tool: string,
    idArg: string,
    ids: readonly string[],
  ): Promise<{ readonly confirmed: readonly string[]; readonly failures: readonly ForgetFailure[] }> {
    const confirmed: string[] = [];
    const failures: ForgetFailure[] = [];
    for (const id of ids) {
      const failure = await forgetRemote(tool, idArg, id);
      if (failure === undefined) confirmed.push(id);
      else failures.push(failure);
    }
    return { confirmed, failures };
  }

  /**
   * The refusal a failed delete leaves behind.
   *
   * A delete that threw is the provider's own transport failing, so the code is
   * `MEMORY_MCP_CALL_FAILED` and the outbox keeps the entry for the next attempt. A delete
   * the server answered `isError` answers the same way every time, so the code ends in
   * `_BAD_RESPONSE`: the drain counts it and parks the forget instead of blocking on it for
   * good. The message names the first failure, whatever the others answered.
   */
  function forgetFailed(tool: string, failures: readonly ForgetFailure[]): NaxError {
    const text = failures[0]?.text ?? "";
    const code: ToolFailureCode = failures.some((failure) => failure.kind === "threw")
      ? "MEMORY_MCP_CALL_FAILED"
      : "MEMORY_MCP_FORGET_BAD_RESPONSE";
    return callFailed(tool, text, code);
  }

  /**
   * The remote ids nax has hidden, in both scopes.
   *
   * One MCP server holds the saves of both scopes, and the host asks the provider
   * for project memories whatever the query's scope, so a copy hidden in either
   * scope must not come back.
   */
  async function hiddenIds(): Promise<ReadonlySet<string>> {
    const [project, user] = await Promise.all([idMap.hiddenIds("project"), idMap.hiddenIds("user")]);
    return new Set([...project, ...user]);
  }

  async function forget(request: MemoryWriteRequest): Promise<MemoryPushResult> {
    const deleted: MemoryPushResult = { id: request.clientId, status: "deleted" };
    const tool = mcp.tools.forget;
    if (tool === undefined) {
      // No delete tool: the server keeps its copy, so nax hides it and drops it from its own search.
      const hidden = await idMap.hide(request.scope, request.slug);
      if (hidden.length > 0) {
        logger.warn(STAGE, "memory mcp forget kept the server copy", {
          server: serverId,
          slug: request.slug,
          ids: hidden.length,
        });
      }
      return deleted;
    }
    const ids = await idMap.ids(request.scope, request.slug);
    if (ids.length === 0) return deleted;
    const idArg = mcp.args.id;
    if (idArg === undefined) throw pushRejected(`[memory] memory.mcp.args.id is required with memory.mcp.tools.forget`);
    await requireTool(tool);
    const { confirmed, failures } = await deleteEach(tool, idArg, ids);
    // Drop only the ids this forget deleted: a delete that failed keeps its id, so the next
    // attempt tries it again, and so does a save recorded while the forget was in flight (the
    // operations layer may have timed it out and moved on).
    if (confirmed.length > 0) await idMap.drop(request.scope, request.slug, confirmed);
    if (failures.length > 0) throw forgetFailed(tool, failures);
    return deleted;
  }

  return {
    id: `${MEMORY_MCP_PROVIDER_PREFIX}${serverId}`,
    // The add may already have been applied when its reply was lost; nothing resends it.
    replay: MEMORY_MCP_REPLAY,
    // An MCP memory tool exposes no change cursor: nothing is pulled and nothing is faked.
    pull: async (): Promise<MemoryPage> => ({ notes: [], done: true }),
    push: (request) => (request.kind === "save" ? save(request) : forget(request)),
    async search({ scope, text, limit }): Promise<readonly MemoryHit[]> {
      const tool = mcp.tools.search;
      // The hidden ids are read before the server is asked: a copy nax hid must not be
      // shown, and an id map that cannot be read is a refusal, not an empty list.
      const hidden = await hiddenIds();
      const result = await pool.call(
        serverId,
        workdir,
        tool,
        { [mcp.args.query]: text },
        { ...callOpts, replaySafety: REPLAY_SAFE },
      );
      if (result.isError) throw callFailed(tool, result.content, "MEMORY_MCP_CALL_FAILED");
      return visibleItems(parseMcpMemoryItems(result.content), hidden)
        .map(({ item, index }) => mcpHitOf(item, index, scope))
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

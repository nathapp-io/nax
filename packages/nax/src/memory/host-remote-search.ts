/**
 * host-remote-search.ts — the remote half of `host.search`.
 *
 * A provider that implements the seam's optional `search` is asked for project
 * memories ahead of the local notes. The ask is bounded: it is raced against a
 * cancellable deadline, and a throw or a timeout is one warn and no remote hits,
 * so a slow or broken memory server can never fail a search the mirror can answer.
 */
import type { MemoryHit, MemoryProvider } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { cancellableDelay } from "@/utils/bun-deps";
import type { MemorySearchInput } from "./host";
import type { MemoryLogger } from "./paths";

const STAGE = "memory";

/** What one remote search is given. */
export interface RemoteSearchInput {
  readonly provider: MemoryProvider;
  readonly query: MemorySearchInput;
  readonly timeoutMs: number;
  readonly logger: MemoryLogger;
}

/** A remote search runs for project-scope and unscoped queries only: an MCP search tool takes no scope. */
function asksRemote(provider: MemoryProvider, query: MemorySearchInput): boolean {
  return provider.search !== undefined && (query.scope === undefined || query.scope === "project");
}

/**
 * The provider's hits for a query, or `[]` when it has no search, the query is
 * user-scoped, the search throws or the deadline passes first.
 *
 * The deadline's timer is cancelled in `finally` whichever side of the race wins,
 * and its abort rejection is consumed so nothing is left unhandled.
 */
export async function searchRemote(input: RemoteSearchInput): Promise<readonly MemoryHit[]> {
  const { provider, query, timeoutMs, logger } = input;
  if (!asksRemote(provider, query)) return [];
  const cancel = new AbortController();
  // `cancellableDelay` rejects when cancelled; the expiry branch is the only one that throws.
  const expired = cancellableDelay(timeoutMs, cancel.signal).then(() => {
    throw new NaxError(`[memory] remote search timed out after ${timeoutMs}ms`, "MEMORY_REMOTE_SEARCH_TIMEOUT", {
      stage: STAGE,
      provider: provider.id,
    });
  });
  expired.catch(() => {});
  try {
    return await Promise.race([
      provider.search?.({ scope: "project", text: query.text, limit: query.limit }),
      expired,
    ]).then((hits) => hits ?? []);
  } catch (error) {
    logger.warn(STAGE, "memory remote search failed", { provider: provider.id, error: errorMessage(error) });
    return [];
  } finally {
    cancel.abort();
  }
}

/** The remote hits, then the local hits no remote hit shares a slug with, cut to the query's limit. */
export function mergeRemoteFirst(
  remote: readonly MemoryHit[],
  local: readonly MemoryHit[],
  limit: number,
): readonly MemoryHit[] {
  if (remote.length === 0) return local;
  const held = new Set(remote.map((hit) => hit.slug));
  return [...remote, ...local.filter((hit) => !held.has(hit.slug))].slice(0, Math.max(0, limit));
}

/**
 * Run discovery for replay — registry scan + prefix match.
 *
 * Mirrors `resolveRunFileFromRegistry` (`src/commands/logs-reader.ts`) but
 * returns `{ meta, jsonlPath }` rather than just a path string, and uses
 * explicit `NaxError` codes for missing/ambiguous runs so callers can render
 * structured error UI.
 *
 * Discovery is I/O-bound, so `getRunsDir()` is exposed through `_deps` for
 * hermetic tests.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "../errors";
import type { MetaJson } from "../pipeline/subscribers/registry";
import { getRunsDir } from "../utils/paths";

/** Resolved pair for a discovered run: registry metadata + backing JSONL path. */
export interface DiscoveredRun {
  meta: MetaJson;
  jsonlPath: string;
}

/** Swappable dependencies for testing. */
export const _discoveryDeps = {
  getRunsDir,
};

async function loadMetas(runsDir: string): Promise<MetaJson[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }

  const metas: MetaJson[] = [];
  for (const entry of entries) {
    try {
      const meta = (await Bun.file(join(runsDir, entry, "meta.json")).json()) as MetaJson;
      metas.push(meta);
    } catch {
      // skip unreadable meta.json entries
    }
  }
  return metas;
}

function matches(meta: MetaJson, query: string): boolean {
  return meta.runId === query || meta.runId.startsWith(query);
}

/**
 * Resolve a run query to registry metadata + the backing JSONL path.
 *
 * - When `query` is omitted/empty, returns the entry with the lexicographically
 *   greatest `runId` (operator-friendly "latest" default).
 * - When `query` is provided, returns the single entry whose `runId` equals
 *   or starts with the query.
 *
 * Throws a `NaxError` with code `RUN_NOT_FOUND` when no entry matches or
 * when more than one entry matches a supplied prefix.
 */
export async function discoverRun(
  query?: string,
  depsArg: { getRunsDir: () => string } = _discoveryDeps,
): Promise<DiscoveredRun> {
  const runsDir = depsArg.getRunsDir();
  const metas = await loadMetas(runsDir);

  if (!query) {
    if (metas.length === 0) {
      throw new NaxError("No runs registered", "RUN_NOT_FOUND", { runsDir });
    }
    const latest = metas.reduce((acc, m) => (m.runId > acc.runId ? m : acc));
    return { meta: latest, jsonlPath: join(latest.eventsDir, `${latest.runId}.jsonl`) };
  }

  const matched = metas.filter((m) => matches(m, query));
  if (matched.length === 0) {
    throw new NaxError(`Run not found in registry: ${query}`, "RUN_NOT_FOUND", {
      query,
      runsDir,
    });
  }
  if (matched.length > 1) {
    throw new NaxError(`Ambiguous run prefix: ${query} matches ${matched.length} runs`, "RUN_NOT_FOUND", {
      query,
      runsDir,
      matchedRunIds: matched.map((m) => m.runId),
    });
  }

  // biome-ignore lint/style/noNonNullAssertion: length-1 invariant above guarantees matched[0] is defined
  const meta = matched[0]!;
  return { meta, jsonlPath: join(meta.eventsDir, `${meta.runId}.jsonl`) };
}

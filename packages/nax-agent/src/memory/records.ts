/**
 * The two record files the mirror keeps beside its notes, decoded.
 *
 * `decisions.jsonl` is one `MemoryDecision` per line and `sync.json` is one
 * `MemorySyncState`: both are written whole by this store and read back by it, so what
 * makes a line a decision — and what makes a file a state — is a schema rather than a
 * cast. Keeping the schemas here leaves the store to decide what a refused line *means*
 * (skipped with a warning) and this module to decide what counts as one.
 */
import { z } from "zod";
import { MEMORY_DECISION_STATUSES, type MemoryDecision } from "./types.ts";

/** A decision as one mirror line; the shape is what makes a line a decision. */
const DecisionSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  updatedAt: z.string().min(1),
  status: z.enum(MEMORY_DECISION_STATUSES),
});

const SyncStateSchema = z.object({
  provider: z.string().nullable(),
  cursor: z.object({ project: z.string().nullable(), user: z.string().nullable() }),
  lastPullAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

/** What `sync.json` holds: the shape the store's `MemorySyncState` is read back as. */
export type ParsedSyncState = z.infer<typeof SyncStateSchema>;

/** The state of a store that has never synced. */
export function defaultSyncState(): ParsedSyncState {
  return { provider: null, cursor: { project: null, user: null }, lastPullAt: null, lastError: null };
}

/** One decoded JSON value, or `null` when the text is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller decides whether that is a skipped line or a defaulted state.
    return null;
  }
}

/** One mirror line as a decision, or `null` when the line is not one. */
export function parseDecisionLine(line: string): MemoryDecision | null {
  const parsed = DecisionSchema.safeParse(parseJson(line));
  return parsed.success ? parsed.data : null;
}

/** The whole `sync.json` text as a state, or `null` when it does not hold one. */
export function parseSyncStateText(text: string): ParsedSyncState | null {
  const parsed = SyncStateSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}

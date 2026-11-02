/**
 * The memory note model — the shapes and limits shared by the note codec, the
 * mirror store, the index renderer, the providers and the sync loop.
 *
 * A note is one Markdown file with frontmatter (`note.ts` writes and reads it);
 * a decision is one line of the mirror's read-only `decisions.jsonl`; a hit is
 * one keyword-search result; a timers object is the race seam the sync loop
 * injects in tests.
 */

export const MEMORY_NOTE_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryNoteType = (typeof MEMORY_NOTE_TYPES)[number];

export const MEMORY_SCOPES = ["project", "user"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_NOTE_STATUSES = ["active", "pending", "superseded", "rejected", "deleted"] as const;
export type MemoryNoteStatus = (typeof MEMORY_NOTE_STATUSES)[number];

export const MEMORY_DECISION_STATUSES = ["active", "superseded", "rejected"] as const;
export type MemoryDecisionStatus = (typeof MEMORY_DECISION_STATUSES)[number];

export interface MemoryNote {
  readonly id: string; // provider id, or the clientId of the write until synced
  readonly slug: string; // MEMORY_SLUG_RE
  readonly type: MemoryNoteType;
  readonly scope: MemoryScope;
  readonly description: string; // one line, <= MEMORY_DESCRIPTION_MAX_CHARS
  readonly source: string; // one line, <= MEMORY_SOURCE_MAX_CHARS: "nax-chat" | "nax-run" | ... | any label
  readonly updatedAt: string; // ISO 8601
  readonly status: MemoryNoteStatus;
  readonly body: string; // Markdown, <= MEMORY_NOTE_BODY_MAX_BYTES (UTF-8)
}

export interface MemoryDecision {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly updatedAt: string;
  readonly status: MemoryDecisionStatus;
}

export interface MemoryHit {
  readonly slug: string;
  readonly scope: MemoryScope;
  readonly type: MemoryNoteType;
  readonly description: string;
  readonly status: MemoryNoteStatus;
  readonly score: number;
  readonly snippet: string;
}

export interface MemoryNoteWrite {
  readonly slug: string;
  readonly type: MemoryNoteType;
  readonly scope: MemoryScope;
  readonly description: string;
  readonly body: string;
}

export interface MemoryWriteRefusal {
  readonly field: "slug" | "type" | "description" | "body" | "source";
  readonly reason: string;
}

export interface MemoryTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** A note slug: 1-64 characters, lower-case alphanumerics and interior `-`. */
export const MEMORY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** An outbox client id: 1-128 letters, digits, `_` or `-`. */
export const MEMORY_CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const MEMORY_NOTE_BODY_MAX_BYTES = 8192;
export const MEMORY_DESCRIPTION_MAX_CHARS = 200;
export const MEMORY_SOURCE_MAX_CHARS = 64;
export const MEMORY_INDEX_MAX_BYTES = 24_576;
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MIN_LINES = 16;
export const MEMORY_INDEX_MIN_BYTES = 512;
export const MEMORY_PROBE_TIMEOUT_MS = 2000;
export const MEMORY_OP_TIMEOUT_MS = 10_000;
export const MEMORY_PULL_PAGE_SIZE = 200;
export const MEMORY_PULL_MAX_PAGES = 50;

/**
 * The key a note is addressed by wherever the mirror and the queue meet: `<scope>/<slug>`.
 *
 * The outbox holds writes by this key and a save asks the outbox whether the key it is
 * about to write is already held, so the two spellings have to be one: a save that asks
 * with a different key would never see the entry it must queue behind.
 */
export function memoryNoteKey(scope: MemoryScope, slug: string): string {
  return `${scope}/${slug}`;
}

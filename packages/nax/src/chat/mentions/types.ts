/**
 * Shared mention vocabulary: the record/status model the message envelope carries, the
 * grammar's token shape, and the limits that bound attached content.
 *
 * The limits are fixed by design (user-confirmed defaults), not config: they bound content
 * size and cache age, never a timeout.
 */

/** How a resolved mention travelled inside the message envelope. */
export type MentionStatus = "attached" | "cut" | "folder" | "path-only" | "refused";

/** One mentioned path and the content nax attached for it. */
export interface MentionRecord {
  /** The path as typed, without "@" or quotes. */
  readonly path: string;
  readonly status: MentionStatus;
  /** The short note the transcript shows beside the path, e.g. "12 lines". */
  readonly note: string;
  /** File text, cut prefix, or folder listing; "" for path-only and refused. */
  readonly body: string;
}

/** A textual `@path` occurrence in a typed message. */
export interface MentionToken {
  /** Index of the "@". */
  readonly start: number;
  /** Index just after the token. */
  readonly end: number;
  /** The path without "@" and without quotes. */
  readonly path: string;
  readonly quoted: boolean;
}

/** A sent message split back into the typed text and the records nax attached. */
export interface ParsedMentionMessage {
  /** What the user typed. */
  readonly text: string;
  readonly records: readonly MentionRecord[];
}

/** The expanded message a host receives, plus the records it carries. */
export interface ExpandedMentions {
  /** What `host.send` receives. */
  readonly message: string;
  readonly records: readonly MentionRecord[];
}

/** One row of the mention picker's file list; folder paths end with "/". */
export interface MentionFileRow {
  readonly path: string;
  readonly folder: boolean;
}

/** The picker's file list, flagged with whether git produced it. */
export interface MentionFileList {
  readonly git: boolean;
  readonly rows: readonly MentionFileRow[];
}

/** A lazily refreshed file list for the mention picker. */
export interface MentionFileIndex {
  get(): Promise<MentionFileList>;
}

/** Largest file body a single mention may attach, in characters. */
export const MENTION_FILE_MAX_CHARS = 100_000;
/** Largest sum of record bodies one message may carry, in characters. */
export const MENTION_TOTAL_MAX_CHARS = 400_000;
/** Largest file a mention may read at all, in bytes. */
export const MENTION_READ_MAX_BYTES = 8 * 1024 * 1024;
/** How many leading bytes are probed for a NUL byte to classify a file as binary. */
export const MENTION_BINARY_PROBE_BYTES = 8_000;
/** How long the picker's file index may be reused, in milliseconds. */
export const MENTION_FILE_INDEX_MAX_AGE_MS = 5_000;

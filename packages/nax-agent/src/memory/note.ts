/**
 * The note codec: one Markdown file per note, frontmatter between two `---`
 * lines (one `key: value` per line, single-line plain scalars, unknown keys
 * ignored), then one blank line, then the body.
 *
 * `parseMemoryNote` validates the frontmatter with a zod schema and reports the
 * first bad key as `MEMORY_NOTE_INVALID`; `parseMemoryNoteRecord` is the same
 * validation over an already-decoded object, so a provider pull validates a
 * note exactly as a mirror read does.
 */
import { z } from "zod";
import { NaxError } from "#src/infra/nax-error";
import { MEMORY_NOTE_STATUSES, MEMORY_NOTE_TYPES, MEMORY_SCOPES, MEMORY_SLUG_RE, type MemoryNote } from "./types.ts";

const ERROR_STAGE = "memory";
const FRONTMATTER_FENCE = "---";
const FENCE_LINE = /^---[ \t]*$/;
const BLANK_LINE = /^[ \t]*$/;
const LINE_BREAK = /[\r\n]/;

/** The frontmatter keys a note carries, in the order `serializeMemoryNote` writes them. */
const NOTE_KEYS = ["id", "slug", "type", "scope", "description", "source", "updatedAt", "status"] as const;
const NOTE_KEY_SET: ReadonlySet<string> = new Set(NOTE_KEYS);

function singleLine(minMessage: string) {
  return z
    .string()
    .min(1, minMessage)
    .refine((value) => !LINE_BREAK.test(value), "must be a single line");
}

const NoteSchema = z.object({
  id: singleLine("must not be empty"),
  slug: singleLine("must not be empty").regex(MEMORY_SLUG_RE, "must be a slug (lower-case letters, digits and '-')"),
  type: z.enum(MEMORY_NOTE_TYPES),
  scope: z.enum(MEMORY_SCOPES),
  description: singleLine("must not be empty"),
  source: singleLine("must not be empty"),
  updatedAt: singleLine("must not be empty"),
  status: z.enum(MEMORY_NOTE_STATUSES),
  body: z.string(),
});

function invalidNote(message: string, key?: string): NaxError {
  return new NaxError(
    `memory note invalid: ${message}`,
    "MEMORY_NOTE_INVALID",
    key === undefined ? { stage: ERROR_STAGE } : { stage: ERROR_STAGE, key },
  );
}

function stripLineBreak(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isNoteKey(key: string): boolean {
  return NOTE_KEY_SET.has(key);
}

/** Split one `key: value` line; the value is everything after the first `: `. */
function splitField(line: string): { key: string; value: string } | null {
  const separator = line.indexOf(": ");
  if (separator !== -1) return { key: line.slice(0, separator), value: line.slice(separator + 2) };
  if (line.endsWith(":")) return { key: line.slice(0, -1), value: "" };
  return null;
}

/** The lines between the fences, plus the body after the blank separator line. */
function splitNoteText(text: string): { fields: Record<string, string>; body: string } {
  const lines = text.split("\n").map(stripLineBreak);
  const [first] = lines;
  if (first === undefined || !FENCE_LINE.test(first)) throw invalidNote("frontmatter must start with a --- line");
  const close = lines.findIndex((line, index) => index > 0 && FENCE_LINE.test(line));
  if (close === -1) throw invalidNote("frontmatter has no closing --- line");
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const field = splitField(line);
    if (field !== null && isNoteKey(field.key)) fields[field.key] = field.value;
  }
  const rest = lines.slice(close + 1);
  const bodyLines = rest[0] !== undefined && BLANK_LINE.test(rest[0]) ? rest.slice(1) : rest;
  return { fields, body: bodyLines.join("\n") };
}

/**
 * Validate an already-decoded note-shaped object (the shared shape validation a
 * provider pull reuses). Throws `MEMORY_NOTE_INVALID` naming the first bad key.
 */
export function parseMemoryNoteRecord(record: unknown): MemoryNote {
  const parsed = NoteSchema.safeParse(record);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const key = issue?.path[0] === undefined ? null : String(issue.path[0]);
  if (key === null) throw invalidNote(issue?.message ?? "invalid note");
  throw invalidNote(`${key}: ${issue?.message ?? "invalid"}`, key);
}

/** Decode one note file. Throws `MEMORY_NOTE_INVALID` naming the first bad key. */
export function parseMemoryNote(text: string): MemoryNote {
  const { fields, body } = splitNoteText(text);
  return parseMemoryNoteRecord({ ...fields, body });
}

/** Encode one note as a file: the keys in `NOTE_KEYS` order, then a blank line, then the body. */
export function serializeMemoryNote(note: MemoryNote): string {
  const frontmatter = NOTE_KEYS.map((key) => `${key}: ${note[key]}`).join("\n");
  const head = `${FRONTMATTER_FENCE}\n${frontmatter}\n${FRONTMATTER_FENCE}\n`;
  return note.body === "" ? head : `${head}\n${note.body}`;
}

/**
 * Whether a provider refused a write for a reason retrying cannot fix. Every
 * other throw (and a timeout) is transient.
 */
export function isMemoryPushRejected(error: unknown): boolean {
  return error instanceof NaxError && error.code === "MEMORY_PUSH_REJECTED";
}

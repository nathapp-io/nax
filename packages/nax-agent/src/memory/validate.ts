/**
 * Write validation — the check a save runs before anything is persisted.
 *
 * `validateMemoryNoteWrite` answers one question for the save path
 * (`operations.ts`): may this note be stored at all? It returns `null` when it
 * may, or the first `MemoryWriteRefusal` it found, checking in the design's
 * order: slug, type, description, source, body size, then secrets.
 *
 * `findSecret` is the secret half on its own: it runs the logger's
 * `SECRET_VALUE_PATTERNS` over free text and reports the kind of the first
 * accepted match. Both functions are pure — no file, no logger, no I/O — so the
 * refusal text is all the caller has to work with, and it never contains the
 * matched text.
 */
import { SECRET_VALUE_PATTERNS } from "#src/internal/redact";
import {
  MEMORY_DESCRIPTION_MAX_CHARS,
  MEMORY_FORGET_REASON_MAX_CHARS,
  MEMORY_NOTE_BODY_MAX_BYTES,
  MEMORY_NOTE_TYPES,
  MEMORY_SLUG_RE,
  MEMORY_SOURCE_MAX_CHARS,
  type MemoryNoteType,
  type MemoryNoteWrite,
  type MemoryWriteRefusal,
} from "./types.ts";

/**
 * The write as received. `type` stays `string` because the value arrives from
 * an agent tool call: narrowing it in the type system would leave the runtime
 * check unreachable without a cast in the very test that has to exercise it.
 */
export type MemoryNoteWriteInput = Omit<MemoryNoteWrite, "type"> & { readonly type: string };

/** A one-line field may carry no line break and no ASCII control character (a tab or DEL included). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point of this check
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f]/;

/** One field the refusal names, and the longest one-line value it accepts. */
type LineField = "description" | "source" | "reason";

function isMemoryNoteType(value: string): value is MemoryNoteType {
  return MEMORY_NOTE_TYPES.some((type) => type === value);
}

function slugRefusal(slug: string): MemoryWriteRefusal | null {
  if (MEMORY_SLUG_RE.test(slug)) return null;
  return { field: "slug", reason: 'slug must be 1-64 lower-case letters, digits or "-"' };
}

function typeRefusal(type: string): MemoryWriteRefusal | null {
  if (isMemoryNoteType(type)) return null;
  return { field: "type", reason: `type must be one of ${MEMORY_NOTE_TYPES.join(", ")}` };
}

/** The shared check for `description` and `source`: non-empty, one line, at most `maxChars`. */
function lineRefusal(field: LineField, text: string, maxChars: number): MemoryWriteRefusal | null {
  if (text === "") return { field, reason: `${field} must not be empty` };
  if (CONTROL_OR_LINE_BREAK.test(text)) {
    return { field, reason: `${field} must not contain a line break or control character` };
  }
  if (text.length > maxChars) return { field, reason: `${field} must be at most ${maxChars} characters` };
  return null;
}

/** The body cap counts UTF-8 bytes, so a multi-byte body can fail below the character limit. */
function bodyRefusal(body: string): MemoryWriteRefusal | null {
  if (Buffer.byteLength(body, "utf8") <= MEMORY_NOTE_BODY_MAX_BYTES) return null;
  return { field: "body", reason: `body must be at most ${MEMORY_NOTE_BODY_MAX_BYTES} bytes` };
}

/**
 * A refusal when `text` carries a secret. The reason names the pattern's kind
 * and never the matched text: a refusal is shown to the agent and logged.
 */
function secretRefusal(field: "description" | "body", text: string): MemoryWriteRefusal | null {
  const secret = findSecret(text);
  return secret === null ? null : { field, reason: `secret (${secret.kind}) must not be stored` };
}

/**
 * The first secret-shaped run in `text`, as its pattern's `kind` label. Every
 * pattern carries the `/g` flag (the logger needs it for `replace`), so
 * `lastIndex` is reset before each scan — otherwise a second call would resume
 * where the first stopped and skip a match.
 */
export function findSecret(text: string): { readonly kind: string } | null {
  for (const { kind, re, acceptMatch } of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match !== null) {
      const matched = match[0];
      // A zero-length match would leave `lastIndex` unchanged and spin forever.
      if (matched === "") {
        re.lastIndex += 1;
      } else if (acceptMatch === undefined || acceptMatch(matched)) {
        return { kind };
      }
      match = re.exec(text);
    }
  }
  return null;
}

/**
 * The refusal for a forget's reason, or `null` when it may be recorded.
 *
 * A reason is what a later session reads to know why a note went, so it is held to the same
 * one-line, non-empty, length-capped rule as a note's description: it is persisted on the
 * request and inside a queued entry, and neither of those is a place to keep an essay.
 */
export function forgetReasonRefusal(reason: string): MemoryWriteRefusal | null {
  return lineRefusal("reason", reason, MEMORY_FORGET_REASON_MAX_CHARS);
}

/**
 * The refusal for a note write, or `null` when it may be stored. Stops at the
 * first problem, in the design's order, so the caller reports one reason.
 */
export function validateMemoryNoteWrite(write: MemoryNoteWriteInput, source: string): MemoryWriteRefusal | null {
  return (
    slugRefusal(write.slug) ??
    typeRefusal(write.type) ??
    lineRefusal("description", write.description, MEMORY_DESCRIPTION_MAX_CHARS) ??
    lineRefusal("source", source, MEMORY_SOURCE_MAX_CHARS) ??
    bodyRefusal(write.body) ??
    secretRefusal("description", write.description) ??
    secretRefusal("body", write.body)
  );
}

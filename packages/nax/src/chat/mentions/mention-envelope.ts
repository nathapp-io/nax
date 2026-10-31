import type { MentionRecord, MentionStatus, ParsedMentionMessage } from "./types";

const ENVELOPE_OPEN = "<nax-mentions>\n";
const ENVELOPE_MARKER = "</nax-mentions";
const BLOCK_LEAD = "\n\n";
const MENTION_CLOSE = "\n</mention>\n";

/**
 * Attribute escaping, applied in order. "&" must come first so the entities written by the
 * remaining rules are not escaped a second time.
 */
const ATTRIBUTE_ESCAPES: readonly (readonly [string, string])[] = [
  ["&", "&amp;"],
  ['"', "&quot;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ["\n", "&#10;"],
];

const ATTRIBUTE_UNESCAPES: readonly (readonly [string, string])[] = [
  ["&quot;", '"'],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&#10;", "\n"],
  ["&amp;", "&"],
];

const MENTION_STATUSES: ReadonlySet<string> = new Set(["attached", "cut", "folder", "path-only", "refused"]);

const TRAILER_LINE = /^<\/nax-mentions length="(\d+)">$/;
const RECORD_HEADER = /^<mention path="([^"]*)" status="([^"]*)" note="([^"]*)" length="(\d+)">\n/;

/**
 * Append the mention envelope to the typed text.
 *
 * With no records this returns the text unchanged, unless the text already holds a mention
 * trailer: a pasted expanded message still gets an (empty) block, so text the user typed can
 * never parse back as records nax did not make.
 */
export function formatMentionMessage(text: string, records: readonly MentionRecord[]): string {
  if (records.length === 0 && !text.includes(ENVELOPE_MARKER)) return text;
  const block = ENVELOPE_OPEN + records.map(formatRecord).join("");
  return `${text}${BLOCK_LEAD}${block}</nax-mentions length="${block.length}">`;
}

/**
 * Split a sent message back into the typed text and the records it carries.
 *
 * The trailer is located from the end and every body is read by its declared length, so file
 * contents (even ones holding the envelope's own markers) never affect parsing. Anything that
 * does not match exactly returns undefined.
 */
export function parseMentionMessage(message: string): ParsedMentionMessage | undefined {
  const trailerStart = message.lastIndexOf("\n") + 1;
  const blockLength = trailerLength(message.slice(trailerStart));
  if (blockLength === undefined) return undefined;
  const blockStart = trailerStart - blockLength;
  if (blockStart < BLOCK_LEAD.length) return undefined;
  if (message.slice(blockStart - BLOCK_LEAD.length, blockStart) !== BLOCK_LEAD) return undefined;
  const block = message.slice(blockStart, trailerStart);
  if (!block.startsWith(ENVELOPE_OPEN)) return undefined;
  const records = readRecords(block.slice(ENVELOPE_OPEN.length));
  if (records === undefined) return undefined;
  return { text: message.slice(0, blockStart - BLOCK_LEAD.length), records };
}

function formatRecord(record: MentionRecord): string {
  const path = escapeAttribute(record.path);
  const note = escapeAttribute(record.note);
  const header = `<mention path="${path}" status="${record.status}" note="${note}" length="${record.body.length}">`;
  return `${header}\n${record.body}${MENTION_CLOSE}`;
}

function escapeAttribute(value: string): string {
  return ATTRIBUTE_ESCAPES.reduce((escaped, [raw, entity]) => escaped.replaceAll(raw, entity), value);
}

function unescapeAttribute(value: string): string {
  return ATTRIBUTE_UNESCAPES.reduce((raw, [entity, original]) => raw.replaceAll(entity, original), value);
}

function trailerLength(line: string): number | undefined {
  const match = TRAILER_LINE.exec(line);
  return match === null ? undefined : Number(match[1]);
}

/** Read headers and length-addressed bodies until the block is consumed; leftover is a failure. */
function readRecords(block: string): readonly MentionRecord[] | undefined {
  const records: MentionRecord[] = [];
  let offset = 0;
  while (offset < block.length) {
    const match = RECORD_HEADER.exec(block.slice(offset));
    if (match === null) return undefined;
    const bodyStart = offset + match[0].length;
    const record = readRecord(block, bodyStart, match);
    if (record === undefined) return undefined;
    records.push(record);
    offset = bodyStart + record.body.length + MENTION_CLOSE.length;
  }
  return records;
}

function readRecord(block: string, bodyStart: number, match: RegExpExecArray): MentionRecord | undefined {
  const status = match[2];
  if (!isMentionStatus(status)) return undefined;
  const bodyEnd = bodyStart + Number(match[4]);
  if (block.slice(bodyEnd, bodyEnd + MENTION_CLOSE.length) !== MENTION_CLOSE) return undefined;
  return {
    path: unescapeAttribute(match[1]),
    status,
    note: unescapeAttribute(match[3]),
    body: block.slice(bodyStart, bodyEnd),
  };
}

function isMentionStatus(value: string): value is MentionStatus {
  return MENTION_STATUSES.has(value);
}

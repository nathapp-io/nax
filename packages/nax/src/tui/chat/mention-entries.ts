/**
 * Mention entries — what one expanded message becomes in the transcript.
 *
 * A sent message that nax expanded carries the typed text plus one record per mention
 * (`ParsedMentionMessage`). The transcript shows that as the user's own message, with the
 * paths that travelled listed on it so the view can highlight them, and then one attachment
 * row per record in the order the user typed them. A `refused` record is named by its row
 * but is not a mention: nothing travelled with the message, so it never appears in the
 * highlighted paths.
 *
 * Every attachment row is created collapsed — no `open` — so the body ctrl+o reveals stays
 * hidden until the user asks for it (or expanded the whole transcript).
 */
import type { MentionRecord, ParsedMentionMessage } from "@/chat/mentions";
import type { TranscriptEntry } from "./transcript-model";

/** A record that travelled with the message: every status but a refusal carries content. */
function isMentioned(record: MentionRecord): boolean {
  return record.status !== "refused";
}

/** One record as its transcript row: the body travels with it, collapsed. */
function attachmentEntry(record: MentionRecord): TranscriptEntry {
  return { kind: "attachment", path: record.path, status: record.status, note: record.note, body: record.body };
}

/** The user's message with its mentions highlighted, then one row per record, in order. */
export function mentionTranscriptEntries(parsed: ParsedMentionMessage): readonly TranscriptEntry[] {
  const mentions = parsed.records.filter(isMentioned).map((record) => record.path);
  return [{ kind: "user", text: parsed.text, mentions }, ...parsed.records.map(attachmentEntry)];
}

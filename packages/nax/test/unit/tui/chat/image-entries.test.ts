/**
 * Image note rows: what a sent image looks like in the transcript, drawn by the layout, and
 * how a stored message replays them — including feature 1's `[image missing]` load note.
 */
import { describe, expect, test } from "bun:test";
import type { ImageAttachment } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { formatMentionMessage, imageNoteLabel, type MentionRecord, parseMentionMessage } from "@/chat";
import { replayHistory } from "@/tui/chat/history-replay";
import { layoutTranscript } from "@/tui/chat/layout";
import { mentionTranscriptEntries } from "@/tui/chat/mention-entries";
import { sentEntries } from "@/tui/chat/mention-send";
import { plainText } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
const WIDTH = 60;

/** The label a 2×3 PNG pasted from the clipboard earns: its four-character payload, three bytes. */
const LABEL = "image 1 · png · 2×3 · 3 B · clipboard";
/** The `[image missing]` note feature 1's load writes when a stored image cannot be read. */
const MISSING = "[image missing]";

/** A pasted 2×3 PNG: a four-character base64 payload, so three raw bytes. */
function image(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return { mimeType: "image/png", data: "AAAA", width: 2, height: 3, source: "clipboard", ...overrides };
}

/** Two pasted PNGs whose bytes and pixels differ, so no two of their labels can be confused. */
const A = image();
const B = image({ data: "AAAB", width: 4, height: 5 });

/** The plain text of every row the layout draws for `entries`. */
function rowsOf(entries: readonly TranscriptEntry[], expanded = false): readonly string[] {
  return layoutTranscript(entries, { width: WIDTH, theme, expanded }).map(plainText);
}

/** A mention record for an image the expander attached. */
const IMAGE_RECORD: MentionRecord = { path: "shot.png", status: "image", note: "image · png · 2×3 · 1 KB", body: "" };

/** The entries an expanded message with `records` replays as, parsed straight out of its envelope. */
function mentionEntries(content: string): readonly TranscriptEntry[] {
  const parsed = parseMentionMessage(content);
  assertDefined(parsed, "the expanded message parses");
  return mentionTranscriptEntries(parsed);
}

describe("layoutTranscript: image rows", () => {
  test("AC-1 draws one muted row holding the label behind the result prefix", () => {
    const lines = layoutTranscript([{ kind: "image", label: LABEL }], { width: WIDTH, theme, expanded: false });
    expect(lines).toHaveLength(1);
    expect(plainText(lines[0])).toBe(`  ${theme.glyphs.result}  ${LABEL}`);
    for (const span of lines[0]) expect(span.color).toBe("muted");
  });

  test("never expands: the row is its label however the transcript is expanded", () => {
    expect(rowsOf([{ kind: "image", label: LABEL }], true)).toEqual([`  ${theme.glyphs.result}  ${LABEL}`]);
  });

  test("wraps a label wider than the layout instead of overflowing it", () => {
    const lines = layoutTranscript([{ kind: "image", label: LABEL }], { width: 20, theme, expanded: false });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(plainText(line).length).toBeLessThanOrEqual(20);
  });
});

describe("sentEntries: image rows", () => {
  test("AC-2 appends the image's note row after the user's message", () => {
    expect(sentEntries("look [Image #1]", [image()])).toEqual([
      { kind: "user", text: "look [Image #1]" },
      { kind: "image", label: LABEL },
    ]);
  });

  test("AC-3 returns today's entries for a message with no images", () => {
    expect(sentEntries("look")).toEqual([{ kind: "user", text: "look" }]);
    expect(sentEntries("look", [])).toEqual(sentEntries("look"));
  });

  test("AC-4 counts only the images a mention envelope does not already row", () => {
    const content = formatMentionMessage("see @shot.png", [IMAGE_RECORD]);
    const mentioned = image({ mimeType: "image/png", data: "AAAB", source: "shot.png" });
    const entries = sentEntries(content, [image(), mentioned]);
    expect(entries).toEqual([...mentionEntries(content), { kind: "image", label: LABEL }]);
  });

  test("AC-11 draws no image row when every image travelled as a mention", () => {
    const content = formatMentionMessage("see @a.png @b.png", [
      { ...IMAGE_RECORD, path: "a.png" },
      { ...IMAGE_RECORD, path: "b.png" },
    ]);
    expect(sentEntries(content, [image()])).toEqual(mentionEntries(content));
  });

  test("numbers several pasted images from one, in the order they were sent", () => {
    const second = image({ data: "AAAB", width: 4, height: 5 });
    expect(sentEntries("look", [image(), second])).toEqual([
      { kind: "user", text: "look" },
      { kind: "image", label: LABEL },
      { kind: "image", label: "image 2 · png · 4×5 · 3 B · clipboard" },
    ]);
  });

  test("US-004 AC-7: puts a lost image's row back between the images around it", () => {
    expect(sentEntries("look", [A, B], [2])).toEqual([
      { kind: "user", text: "look" },
      { kind: "image", label: imageNoteLabel(1, A) },
      { kind: "image", label: "image 2 · missing" },
      { kind: "image", label: imageNoteLabel(3, B) },
    ]);
  });

  test("US-004 AC-8: numbers the rows the same way when nothing was lost", () => {
    expect(sentEntries("look", [A])).toEqual(sentEntries("look", [A], []));
    expect(sentEntries("look", [A])).toEqual([
      { kind: "user", text: "look" },
      { kind: "image", label: imageNoteLabel(1, A) },
    ]);
  });
});

describe("replayHistory: stored image rows", () => {
  test("AC-5 replays a stored message's images as the rows a live send drew", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "look [Image #1]", images: [image()] }] })).toEqual(
      sentEntries("look [Image #1]", [image()]),
    );
  });

  test("AC-6 strips the trailing missing-image note and rows it", () => {
    expect(replayHistory({ messages: [{ role: "user", content: `look\n${MISSING}` }] })).toEqual([
      { kind: "user", text: "look" },
      { kind: "image", label: "image · missing" },
    ]);
  });

  test("AC-7 rows one missing-image line per note the content carried", () => {
    expect(replayHistory({ messages: [{ role: "user", content: `look\n${MISSING}\n${MISSING}` }] })).toEqual([
      { kind: "user", text: "look" },
      { kind: "image", label: "image · missing" },
      { kind: "image", label: "image · missing" },
    ]);
  });

  test("AC-8 rows the stripped note after a stored mention message's own entries", () => {
    const content = formatMentionMessage("see @shot.png", [IMAGE_RECORD]);
    expect(replayHistory({ messages: [{ role: "user", content: `${content}\n${MISSING}` }] })).toEqual([
      ...mentionEntries(content),
      { kind: "image", label: "image · missing" },
    ]);
  });

  test("AC-9 draws only the missing row when the note was the whole message", () => {
    expect(replayHistory({ messages: [{ role: "user", content: MISSING }] })).toEqual([
      { kind: "image", label: "image · missing" },
    ]);
  });

  test("AC-10 keeps a note that is not a whole trailing line as plain user text", () => {
    expect(replayHistory({ messages: [{ role: "user", content: `see ${MISSING} here` }] })).toEqual([
      { kind: "user", text: `see ${MISSING} here` },
    ]);
  });

  test("keeps a note in the middle of the content as text", () => {
    expect(replayHistory({ messages: [{ role: "user", content: `look\n${MISSING}\nthere` }] })).toEqual([
      { kind: "user", text: `look\n${MISSING}\nthere` },
    ]);
  });

  test("rows the image that survived and the one that did not", () => {
    expect(replayHistory({ messages: [{ role: "user", content: `look\n${MISSING}`, images: [image()] }] })).toEqual([
      { kind: "user", text: "look" },
      { kind: "image", label: LABEL },
      { kind: "image", label: "image · missing" },
    ]);
  });

  test("keeps an empty stored message as no entries at all", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "" }] })).toEqual([]);
  });

  test("US-004 AC-1: replays the lost first image at its number, ahead of the one that survived", () => {
    const content = "[Image #1] then [Image #2]\n[image missing #1]";
    expect(replayHistory({ messages: [{ role: "user", content, images: [A] }] })).toEqual([
      { kind: "user", text: "[Image #1] then [Image #2]" },
      { kind: "image", label: "image 1 · missing" },
      { kind: "image", label: imageNoteLabel(2, A) },
    ]);
  });

  test("US-004 AC-2: replays a lost second image after the one that survived", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "x\n[image missing #2]", images: [A] }] })).toEqual([
      { kind: "user", text: "x" },
      { kind: "image", label: imageNoteLabel(1, A) },
      { kind: "image", label: "image 2 · missing" },
    ]);
  });

  test("US-004 AC-3: keeps an older build's bare note as the unnumbered row", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "x\n[image missing]", images: [A] }] })).toEqual([
      { kind: "user", text: "x" },
      { kind: "image", label: imageNoteLabel(1, A) },
      { kind: "image", label: "image · missing" },
    ]);
  });

  test("US-004 AC-4: falls back to the unnumbered row for a position beyond the slot count", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "x\n[image missing #5]", images: [A] }] })).toEqual([
      { kind: "user", text: "x" },
      { kind: "image", label: imageNoteLabel(1, A) },
      { kind: "image", label: "image · missing" },
    ]);
  });

  test("US-004 AC-5: rows a numbered note that is the whole message", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "[image missing #1]" }] })).toEqual([
      { kind: "image", label: "image 1 · missing" },
    ]);
  });

  test("US-004 AC-6: reads a note-only message's number against the image that survived it", () => {
    expect(replayHistory({ messages: [{ role: "user", content: "[image missing #1]", images: [B] }] })).toEqual([
      { kind: "image", label: "image 1 · missing" },
      { kind: "image", label: imageNoteLabel(2, B) },
    ]);
  });

  test("US-004 AC-9: draws no row for a lost image the mention envelope already names", () => {
    const envelope = formatMentionMessage("see @shot.png", [IMAGE_RECORD]);
    expect(replayHistory({ messages: [{ role: "user", content: `${envelope}\n[image missing #1]` }] })).toEqual(
      mentionEntries(envelope),
    );
  });
});

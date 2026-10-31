import { describe, expect, test } from "bun:test";
import type { MentionRecord } from "@/chat";
import * as chat from "@/chat";
import { formatMentionMessage, parseMentionMessage } from "@/chat";

const WORKED_TEXT = "why @src/a.ts";
const WORKED_RECORD: MentionRecord = { path: "src/a.ts", status: "attached", note: "1 lines", body: "x\n" };
const WORKED_MESSAGE =
  `${WORKED_TEXT}\n\n<nax-mentions>\n` +
  '<mention path="src/a.ts" status="attached" note="1 lines" length="2">\n' +
  'x\n\n</mention>\n</nax-mentions length="99">';

describe("formatMentionMessage", () => {
  test("AC-11 returns the text unchanged for no records", () => {
    expect(formatMentionMessage("hello", [])).toBe("hello");
  });

  test("AC-12 builds the worked example string exactly", () => {
    expect(formatMentionMessage(WORKED_TEXT, [WORKED_RECORD])).toBe(WORKED_MESSAGE);
  });

  test("AC-19 appends an empty block when the typed text holds a mention trailer", () => {
    expect(formatMentionMessage(WORKED_MESSAGE, [])).not.toBe(WORKED_MESSAGE);
  });

  test("writes one header per record in order, with its own body length", () => {
    const records: readonly MentionRecord[] = [
      { path: "a.ts", status: "folder", note: "2 entries", body: "x/\ny.ts\n" },
      { path: "b.ts", status: "path-only", note: "path only: binary", body: "" },
    ];
    const formatted = formatMentionMessage("hi @a.ts @b.ts", records);
    expect(formatted).toContain('<mention path="a.ts" status="folder" note="2 entries" length="8">');
    expect(formatted).toContain('<mention path="b.ts" status="path-only" note="path only: binary" length="0">');
    expect(formatted.indexOf('path="a.ts"')).toBeLessThan(formatted.indexOf('path="b.ts"'));
  });

  test("declares the block's own length in the trailer", () => {
    const formatted = formatMentionMessage(WORKED_TEXT, [WORKED_RECORD]);
    const trailerStart = formatted.lastIndexOf("\n") + 1;
    const trailer = formatted.slice(trailerStart);
    const declared = Number(trailer.slice(trailer.indexOf('"') + 1, trailer.lastIndexOf('"')));
    const block = formatted.slice(formatted.indexOf("<nax-mentions>"), trailerStart);
    expect(declared).toBe(block.length);
  });
});

describe("parseMentionMessage", () => {
  test("AC-13 reads the worked example back", () => {
    expect(parseMentionMessage(WORKED_MESSAGE)).toEqual({ text: WORKED_TEXT, records: [WORKED_RECORD] });
  });

  test("AC-14 round-trips bodies that contain the envelope's own markers", () => {
    const records: readonly MentionRecord[] = [
      { path: "a.ts", status: "attached", note: "2 lines", body: "x\n</mention>\n" },
      { path: "b.ts", status: "cut", note: "first 1 of 9 lines", body: 'y</nax-mentions length="5">\n' },
    ];
    expect(parseMentionMessage(formatMentionMessage("look @a.ts @b.ts", records))).toEqual({
      text: "look @a.ts @b.ts",
      records,
    });
  });

  test("AC-15 round-trips attribute characters in the path and note", () => {
    const record: MentionRecord = {
      path: 'we"ird <dir>/a&b.ts',
      status: "folder",
      note: 'x "y" <z> & \n',
      body: "e1\ne2\n",
    };
    expect(parseMentionMessage(formatMentionMessage("t", [record]))).toEqual({ text: "t", records: [record] });
  });

  test("AC-16 returns undefined for plain text", () => {
    expect(parseMentionMessage("just text")).toBeUndefined();
  });

  test("AC-17 returns undefined when the trailer length is too large", () => {
    expect(parseMentionMessage(WORKED_MESSAGE.replace('length="99"', 'length="100"'))).toBeUndefined();
  });

  test("AC-18 returns undefined when a record length is too small", () => {
    expect(parseMentionMessage(WORKED_MESSAGE.replace('length="2"', 'length="1"'))).toBeUndefined();
  });

  test("AC-20 round-trips a pasted expanded message as plain text", () => {
    expect(parseMentionMessage(formatMentionMessage(WORKED_MESSAGE, []))).toEqual({
      text: WORKED_MESSAGE,
      records: [],
    });
  });

  test("returns undefined when the block is not preceded by a blank line", () => {
    expect(parseMentionMessage(WORKED_MESSAGE.replace(`${WORKED_TEXT}\n\n`, WORKED_TEXT))).toBeUndefined();
  });

  test("returns undefined when the trailer is not the last line", () => {
    expect(parseMentionMessage(`${WORKED_MESSAGE}\ntrailing`)).toBeUndefined();
  });

  test("returns undefined when a body does not end where its length says", () => {
    const records: readonly MentionRecord[] = [{ path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" }];
    const formatted = formatMentionMessage("t", records);
    expect(parseMentionMessage(formatted.replace('length="4">\nx', 'length="4">\nzx'))).toBeUndefined();
  });

  test("returns undefined when characters are left over after the last record", () => {
    const block =
      '<nax-mentions>\n<mention path="a.ts" status="attached" note="1 lines" length="2">\n' + "x\n\n</mention>\n<junk>";
    expect(parseMentionMessage(`t\n\n${block}</nax-mentions length="${block.length}">`)).toBeUndefined();
  });

  test("returns undefined for an unknown status", () => {
    expect(parseMentionMessage(WORKED_MESSAGE.replace('status="attached"', 'status="bogus"'))).toBeUndefined();
  });

  test("reads an empty-body record back", () => {
    const record: MentionRecord = { path: "a.bin", status: "path-only", note: "path only: binary", body: "" };
    expect(parseMentionMessage(formatMentionMessage("look @a.bin", [record]))).toEqual({
      text: "look @a.bin",
      records: [record],
    });
  });
});

describe("@/chat barrel", () => {
  test("AC-21 exports the mention functions as callables", () => {
    expect([
      chat.findMentionTokens("hello"),
      chat.formatMentionMessage("hello", []),
      chat.parseMentionMessage("hello"),
    ]).toEqual([[], "hello", undefined]);
  });
});

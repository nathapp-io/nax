import { describe, expect, test } from "bun:test";
import type { MentionRecord } from "@/chat/mentions";
import { mentionTranscriptEntries } from "@/tui/chat/mention-entries";

/** What an attached mention of a short text file resolves to. */
const attachedA: MentionRecord = { path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" };
/** What a binary mention resolves to: the path travels, the bytes do not. */
const pathOnlyB: MentionRecord = { path: "b.png", status: "path-only", note: "path only: binary", body: "" };
/** A mention of a folder: the listing travels as its body. */
const folderSrc: MentionRecord = { path: "src/", status: "folder", note: "2 entries", body: "a.ts\nb.ts\n" };
/** A mention nax refused: nothing travelled with the message. */
const refusedX: MentionRecord = { path: "../x", status: "refused", note: "not attached: outside the repo", body: "" };

describe("mentionTranscriptEntries", () => {
  test("AC-1 lists the typed text with its mentioned paths, then one attachment entry per record", () => {
    expect(mentionTranscriptEntries({ text: "see @a.ts @b.png", records: [attachedA, pathOnlyB] })).toEqual([
      { kind: "user", text: "see @a.ts @b.png", mentions: ["a.ts", "b.png"] },
      { kind: "attachment", path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" },
      { kind: "attachment", path: "b.png", status: "path-only", note: "path only: binary", body: "" },
    ]);
  });

  test("AC-2 leaves a refused path out of the mentions and keeps its attachment entry", () => {
    expect(mentionTranscriptEntries({ text: "see @../x", records: [refusedX] })).toEqual([
      { kind: "user", text: "see @../x", mentions: [] },
      {
        kind: "attachment",
        path: "../x",
        status: "refused",
        note: "not attached: outside the repo",
        body: "",
      },
    ]);
  });

  test("keeps a folder among the mentions and the records in their order", () => {
    const entries = mentionTranscriptEntries({ text: "see @src/ @b.png", records: [folderSrc, pathOnlyB] });
    expect(entries[0]).toEqual({ kind: "user", text: "see @src/ @b.png", mentions: ["src/", "b.png"] });
    expect(entries.slice(1).map((entry) => entry.kind === "attachment" && entry.path)).toEqual(["src/", "b.png"]);
  });

  test("returns the user entry alone when the message carries no records", () => {
    expect(mentionTranscriptEntries({ text: "hello", records: [] })).toEqual([
      { kind: "user", text: "hello", mentions: [] },
    ]);
  });

  test("leaves every attachment entry collapsed, so its body is hidden until it is clicked", () => {
    const entries = mentionTranscriptEntries({ text: "see @a.ts", records: [attachedA] });
    for (const entry of entries.slice(1)) expect(entry).not.toHaveProperty("open");
  });
});

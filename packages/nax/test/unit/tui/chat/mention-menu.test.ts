import { describe, expect, test } from "bun:test";
import type { MentionFileRow } from "@/chat";
import type { EditorState } from "@/tui/chat/line-editor";
import { applyMentionRow, filterMentionRows, type MentionQuery, mentionQueryAt } from "@/tui/chat/mention-menu";

function fileRow(path: string): MentionFileRow {
  return { path, folder: false };
}

function folderRow(path: string): MentionFileRow {
  return { path, folder: true };
}

/** Rows for a list of paths, each a folder when it ends with the folder suffix. */
function rowsOf(paths: readonly string[]): MentionFileRow[] {
  return paths.map((path) => (path.endsWith("/") ? folderRow(path) : fileRow(path)));
}

function pathsOf(rows: readonly MentionFileRow[]): string[] {
  return rows.map((row) => row.path);
}

/** The query the picker would show for an editor, which every apply test starts from. */
function queryAt(editor: EditorState): MentionQuery {
  const query = mentionQueryAt(editor);
  if (query === null) throw new Error(`no mention query at ${JSON.stringify(editor)}`);
  return query;
}

describe("mentionQueryAt", () => {
  test("AC-8 reports the whole typed path when the cursor ends it", () => {
    expect(mentionQueryAt({ text: "see @src/ch", cursor: 11 })).toEqual({
      start: 4,
      end: 11,
      query: "src/ch",
      quoted: false,
    });
  });

  test("AC-9 reports the query before the cursor and the token's end after it", () => {
    expect(mentionQueryAt({ text: "see @src/ch now", cursor: 8 })).toEqual({
      start: 4,
      end: 11,
      query: "src",
      quoted: false,
    });
  });

  test("AC-10 returns null when whitespace separates the @ from the cursor", () => {
    expect(mentionQueryAt({ text: "see @a.ts now", cursor: 13 })).toBeNull();
  });

  test("AC-11 returns null when the cursor sits on the @ itself", () => {
    expect(mentionQueryAt({ text: "see @a.ts", cursor: 4 })).toBeNull();
  });

  test("AC-12 returns null in a slash-command line", () => {
    expect(mentionQueryAt({ text: "/skill @a", cursor: 9 })).toBeNull();
  });

  test("AC-13 reports an unclosed quoted path", () => {
    expect(mentionQueryAt({ text: 'see @"my d', cursor: 10 })).toEqual({
      start: 4,
      end: 10,
      query: "my d",
      quoted: true,
    });
  });

  test("reports a bare @ so completion can begin", () => {
    expect(mentionQueryAt({ text: "see @", cursor: 5 })).toEqual({ start: 4, end: 5, query: "", quoted: false });
  });

  test("returns null once a quoted path is closed before the cursor", () => {
    expect(mentionQueryAt({ text: '@"my dir" x', cursor: 11 })).toBeNull();
  });

  test("counts the cursor in code points and reports raw string offsets", () => {
    expect(mentionQueryAt({ text: "😀 @ab", cursor: 5 })).toEqual({ start: 3, end: 6, query: "ab", quoted: false });
  });
});

describe("filterMentionRows", () => {
  test("AC-14 offers the direct children for an empty query", () => {
    const rows = rowsOf(["a.ts", "src/", "src/b.ts"]);
    expect([...pathsOf(filterMentionRows(rows, ""))].sort()).toEqual(["a.ts", "src/"]);
  });

  test("AC-15 offers the direct children of a typed folder, not the folder itself", () => {
    const rows = rowsOf(["a.ts", "src/", "src/b.ts", "src/c/", "src/c/d.ts"]);
    expect([...pathsOf(filterMentionRows(rows, "src/"))].sort()).toEqual(["src/b.ts", "src/c/"]);
  });

  test("AC-16 keeps rows the rest of the query is a subsequence of, shortest path first", () => {
    const rows = rowsOf(["chat-host.ts", "x/chat-host.ts", "cheap.txt"]);
    expect(pathsOf(filterMentionRows(rows, "chh"))).toEqual(["chat-host.ts", "x/chat-host.ts"]);
  });

  test("AC-17 ranks a basename that starts with the query above an earlier subsequence match", () => {
    const rows = rowsOf(["ghost-x.ts", "src/host.ts"]);
    expect(pathsOf(filterMentionRows(rows, "host"))).toEqual(["src/host.ts", "ghost-x.ts"]);
  });

  test("AC-18 ranks a folder by its basename without the trailing slash", () => {
    const rows = rowsOf(["x/src.ts", "src/"]);
    expect(pathsOf(filterMentionRows(rows, "src"))).toEqual(["src/", "x/src.ts"]);
  });

  test("AC-19 matches case-insensitively", () => {
    const rows = rowsOf(["chat.ts"]);
    expect(pathsOf(filterMentionRows(rows, "CHAT"))).toEqual(["chat.ts"]);
  });
});

describe("applyMentionRow", () => {
  test("AC-20 completes a file in place and keeps the whitespace already after it", () => {
    const editor: EditorState = { text: "see @ch now", cursor: 7 };
    expect(applyMentionRow(editor, queryAt(editor), fileRow("chat.ts"), "return")).toEqual({
      text: "see @chat.ts now",
      cursor: 13,
    });
  });

  test("AC-21 drills into a folder on tab without a trailing space", () => {
    const editor: EditorState = { text: "@sr", cursor: 3 };
    expect(applyMentionRow(editor, queryAt(editor), folderRow("src/"), "tab")).toEqual({
      text: "@src/",
      cursor: 5,
    });
  });

  test("AC-22 completes a folder on return with a trailing space", () => {
    const editor: EditorState = { text: "@sr", cursor: 3 };
    expect(applyMentionRow(editor, queryAt(editor), folderRow("src/"), "return")).toEqual({
      text: "@src/ ",
      cursor: 6,
    });
  });

  test("AC-23 quotes a path with whitespace and leaves a trailing space", () => {
    const editor: EditorState = { text: "@my", cursor: 3 };
    expect(applyMentionRow(editor, queryAt(editor), fileRow("my file.ts"), "return")).toEqual({
      text: '@"my file.ts" ',
      cursor: 14,
    });
  });

  test("AC-24 drills into a folder with whitespace, leaving the quote open", () => {
    const editor: EditorState = { text: "@my", cursor: 3 };
    expect(applyMentionRow(editor, queryAt(editor), folderRow("my dir/"), "tab")).toEqual({
      text: '@"my dir/',
      cursor: 9,
    });
  });

  test("reports the cursor in code points after a non-ASCII prefix", () => {
    const editor: EditorState = { text: "😀 @ab", cursor: 5 };
    expect(applyMentionRow(editor, queryAt(editor), fileRow("ab.ts"), "return")).toEqual({
      text: "😀 @ab.ts ",
      cursor: 9,
    });
  });
});

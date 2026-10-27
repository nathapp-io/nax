import { describe, expect, test } from "bun:test";
import {
  cursorRow,
  type EditorKey,
  type EditorResult,
  type EditorState,
  EMPTY_EDITOR,
  editLine,
} from "@/tui/chat/line-editor";

type KeyFlags = EditorKey["key"];

/** Every modifier off — the base a helper presses one key on top of. */
const NO_FLAGS: KeyFlags = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

/** One keypress: `input` as ink reports it, with the named modifier flags set. */
function press(input = "", overrides: Partial<KeyFlags> = {}): EditorKey {
  return { input, key: { ...NO_FLAGS, ...overrides } };
}

/** A state whose cursor is a code-point index into `text`. */
function at(text: string, cursor: number): EditorState {
  return { text, cursor };
}

/** The state an edit result carries; a non-edit result fails the calling test. */
function edited(result: EditorResult): EditorState {
  if (result.kind !== "edit") throw new Error(`[test] expected an edit result, got "${result.kind}"`);
  return result.state;
}

describe("EMPTY_EDITOR", () => {
  test("is empty text with the cursor at the start", () => {
    expect(EMPTY_EDITOR).toEqual({ text: "", cursor: 0 });
  });
});

describe("editLine — insert", () => {
  test("inserts each printable character at the cursor", () => {
    // AC-1
    const once = editLine(EMPTY_EDITOR, press("a"));
    expect(editLine(edited(once), press("b"))).toEqual({ kind: "edit", state: { text: "ab", cursor: 2 } });
  });

  test("inserts at the cursor after moving left", () => {
    // AC-2
    const moved = editLine(at("ab", 2), press("", { leftArrow: true }));
    expect(editLine(edited(moved), press("X"))).toEqual({ kind: "edit", state: { text: "aXb", cursor: 2 } });
  });

  test("inserts a pasted chunk whole with CRLF and CR normalised to LF", () => {
    // AC-14
    expect(editLine(EMPTY_EDITOR, press("x\r\ny\rz"))).toEqual({
      kind: "edit",
      state: { text: "x\ny\nz", cursor: 5 },
    });
  });

  test("inserts a multi-character chunk before the text after the cursor", () => {
    expect(editLine(at("ad", 1), press("bc"))).toEqual({ kind: "edit", state: { text: "abcd", cursor: 3 } });
  });

  test("clamps a cursor that is outside the text", () => {
    expect(editLine(at("ab", 9), press("X"))).toEqual({ kind: "edit", state: { text: "abX", cursor: 3 } });
    expect(editLine(at("ab", -2), press("X"))).toEqual({ kind: "edit", state: { text: "Xab", cursor: 1 } });
  });

  test("leaves the state it was given untouched", () => {
    const state = at("ab", 1);
    editLine(state, press("X"));
    expect(state).toEqual({ text: "ab", cursor: 1 });
  });
});

describe("editLine — delete", () => {
  test("backspace deletes the character before the cursor", () => {
    // AC-3
    expect(editLine(at("ab", 1), press("", { backspace: true }))).toEqual({
      kind: "edit",
      state: { text: "b", cursor: 0 },
    });
  });

  test("key.delete also deletes the character before the cursor", () => {
    // AC-4 — ink reports the Backspace key's \u007f as `delete`
    expect(editLine(at("ab", 1), press("", { delete: true }))).toEqual({
      kind: "edit",
      state: { text: "b", cursor: 0 },
    });
  });

  test("backspace at the start of the text returns the state unchanged", () => {
    // AC-5
    const state = at("ab", 0);
    expect(editLine(state, press("", { backspace: true }))).toEqual({ kind: "edit", state });
  });

  test("backspace deletes one code point of an emoji", () => {
    // AC-6
    expect(editLine(at("a😀b", 2), press("", { backspace: true }))).toEqual({
      kind: "edit",
      state: { text: "ab", cursor: 1 },
    });
  });

  test("backspace at the end of a line joins the next line onto it", () => {
    expect(editLine(at("ab\ncd", 3), press("", { backspace: true }))).toEqual({
      kind: "edit",
      state: { text: "abcd", cursor: 2 },
    });
  });
});

describe("editLine — movement", () => {
  test("ctrl+a moves to the start of the current line", () => {
    // AC-7
    expect(editLine(at("one\ntwo", 6), press("a", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "one\ntwo", cursor: 4 },
    });
  });

  test("ctrl+e moves to the end of the current line", () => {
    // AC-8
    expect(editLine(at("one\ntwo", 4), press("e", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "one\ntwo", cursor: 7 },
    });
  });

  test("meta+left moves to the start of the word before the cursor", () => {
    // AC-9
    expect(editLine(at("foo bar baz", 11), press("", { leftArrow: true, meta: true }))).toEqual({
      kind: "edit",
      state: { text: "foo bar baz", cursor: 8 },
    });
  });

  test("meta+right moves to the end of the word after the cursor", () => {
    // AC-10
    expect(editLine(at("foo bar baz", 0), press("", { rightArrow: true, meta: true }))).toEqual({
      kind: "edit",
      state: { text: "foo bar baz", cursor: 3 },
    });
  });

  test("left and right move one code point and stop at the ends", () => {
    expect(editLine(at("one\ntwo", 5), press("", { leftArrow: true }))).toEqual({
      kind: "edit",
      state: { text: "one\ntwo", cursor: 4 },
    });
    expect(editLine(at("one\ntwo", 0), press("", { leftArrow: true }))).toEqual({
      kind: "edit",
      state: { text: "one\ntwo", cursor: 0 },
    });
    expect(editLine(at("one\ntwo", 7), press("", { rightArrow: true }))).toEqual({
      kind: "edit",
      state: { text: "one\ntwo", cursor: 7 },
    });
  });

  test("ctrl+a on the only line moves to 0 and ctrl+e to the text end", () => {
    expect(editLine(at("abc", 2), press("a", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "abc", cursor: 0 },
    });
    expect(editLine(at("abc", 2), press("e", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "abc", cursor: 3 },
    });
  });

  test("meta+left skips the whitespace before the previous word and meta+right the whitespace after", () => {
    expect(editLine(at("foo   bar", 6), press("", { leftArrow: true, meta: true }))).toEqual({
      kind: "edit",
      state: { text: "foo   bar", cursor: 0 },
    });
    expect(editLine(at("foo   bar", 3), press("", { rightArrow: true, meta: true }))).toEqual({
      kind: "edit",
      state: { text: "foo   bar", cursor: 9 },
    });
  });
});

describe("editLine — line and word deletes", () => {
  test("ctrl+w deletes the word before the cursor", () => {
    // AC-11
    expect(editLine(at("foo bar", 7), press("w", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "foo ", cursor: 4 },
    });
  });

  test("ctrl+u deletes from the line start to the cursor", () => {
    // AC-12
    expect(editLine(at("ab\ncd", 4), press("u", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "ab\nd", cursor: 3 },
    });
  });

  test("ctrl+k deletes from the cursor to the line end", () => {
    // AC-13
    expect(editLine(at("ab\ncd", 1), press("k", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "a\ncd", cursor: 1 },
    });
  });

  test("ctrl+w at the start of the text changes nothing", () => {
    expect(editLine(at("foo bar", 0), press("w", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "foo bar", cursor: 0 },
    });
  });

  test("ctrl+u at the line start changes nothing", () => {
    expect(editLine(at("ab\ncd", 3), press("u", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "ab\ncd", cursor: 3 },
    });
  });

  test("ctrl+k at the line end changes nothing", () => {
    expect(editLine(at("ab\ncd", 2), press("k", { ctrl: true }))).toEqual({
      kind: "edit",
      state: { text: "ab\ncd", cursor: 2 },
    });
  });
});

describe("editLine — return", () => {
  test("return with meta inserts a newline", () => {
    // AC-15
    expect(editLine(at("a", 1), press("", { return: true, meta: true }))).toEqual({
      kind: "edit",
      state: { text: "a\n", cursor: 2 },
    });
  });

  test("return with shift inserts a newline", () => {
    // AC-16
    expect(editLine(at("a", 1), press("", { return: true, shift: true }))).toEqual({
      kind: "edit",
      state: { text: "a\n", cursor: 2 },
    });
  });

  test("return after a backslash replaces the backslash with a newline", () => {
    // AC-17
    expect(editLine(at("a\\", 2), press("", { return: true }))).toEqual({
      kind: "edit",
      state: { text: "a\n", cursor: 2 },
    });
  });

  test("any other return submits the text untrimmed", () => {
    // AC-18
    expect(editLine(at(" hi ", 4), press("", { return: true }))).toEqual({ kind: "submit", text: " hi " });
  });

  test("return on an empty editor submits the empty text", () => {
    expect(editLine(EMPTY_EDITOR, press("", { return: true }))).toEqual({ kind: "submit", text: "" });
  });

  test("return elsewhere keeps the backslash and submits", () => {
    expect(editLine(at("a\\b", 1), press("", { return: true }))).toEqual({ kind: "submit", text: "a\\b" });
  });
});

describe("editLine — ignored", () => {
  const IGNORED_KEYS: [string, Partial<KeyFlags>][] = [
    ["upArrow", { upArrow: true }],
    ["downArrow", { downArrow: true }],
    ["tab", { tab: true }],
    ["escape", { escape: true }],
  ];

  test.each(IGNORED_KEYS)("%s is ignored", (_name, flags) => {
    // AC-19
    expect(editLine(at("ab", 1), press("", flags))).toEqual({ kind: "ignored" });
  });

  test("an unhandled ctrl chord is ignored", () => {
    // AC-20
    expect(editLine(at("ab", 1), press("x", { ctrl: true }))).toEqual({ kind: "ignored" });
  });

  test("input that carries no text and no handled key is ignored", () => {
    expect(editLine(at("ab", 1), press(""))).toEqual({ kind: "ignored" });
  });
});

describe("cursorRow", () => {
  test("reports the row of the cursor and the number of rows", () => {
    // AC-21
    expect(cursorRow(at("a\nb\nc", 3))).toEqual({ row: 1, rows: 3 });
  });

  test("single-line text is row 0 of 1", () => {
    expect(cursorRow(at("abc", 2))).toEqual({ row: 0, rows: 1 });
  });

  test("a cursor sitting on a newline is still on the row it ends", () => {
    expect(cursorRow(at("a\nb", 1))).toEqual({ row: 0, rows: 2 });
  });

  test("a cursor at the end of the text is on the last row", () => {
    expect(cursorRow(at("a\nb\nc", 5))).toEqual({ row: 2, rows: 3 });
  });
});

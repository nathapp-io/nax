import { describe, expect, test } from "bun:test";
import { layoutTranscript } from "@/tui/chat/layout";
import { attachmentExpandable, attachmentLabel } from "@/tui/chat/layout-attachment";
import { plainText } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
const WIDTH = 60;

type AttachmentEntry = Extract<TranscriptEntry, { kind: "attachment" }>;

/** An attached text file: two lines travel and the row says so. */
function attachment(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
  return { kind: "attachment", path: "a.ts", status: "attached", note: "2 lines", body: "one\ntwo\n", ...overrides };
}

/** The plain text of every row the layout draws for `entries`. */
function rowsOf(entries: readonly TranscriptEntry[], expanded = false): readonly string[] {
  return layoutTranscript(entries, { width: WIDTH, theme, expanded }).map(plainText);
}

describe("attachmentLabel", () => {
  test("AC-3 names an attached file and what travelled", () => {
    expect(attachmentLabel({ path: "a.ts", status: "attached", note: "2 lines" })).toBe("attached @a.ts · 2 lines");
  });

  test("AC-4 says a cut file travelled in part", () => {
    expect(attachmentLabel({ path: "big.ts", status: "cut", note: "first 10 of 99 lines" })).toBe(
      "attached @big.ts · first 10 of 99 lines",
    );
  });

  test("AC-5 names a folder and its entry count", () => {
    expect(attachmentLabel({ path: "src/", status: "folder", note: "2 entries" })).toBe("attached @src/ · 2 entries");
  });

  test("AC-6 says a path-only mention travelled as its path alone", () => {
    expect(attachmentLabel({ path: "b.png", status: "path-only", note: "path only: binary" })).toBe(
      "attached @b.png as path only: binary",
    );
  });

  test("AC-7 names a refused path without claiming it was attached", () => {
    expect(attachmentLabel({ path: "../x", status: "refused", note: "not attached: outside the repo" })).toBe(
      "@../x not attached: outside the repo",
    );
  });

  test("quotes a path that carries whitespace, the way the token is typed", () => {
    expect(attachmentLabel({ path: "my dir/x.ts", status: "attached", note: "1 lines" })).toBe(
      'attached @"my dir/x.ts" · 1 lines',
    );
  });
});

describe("attachmentExpandable", () => {
  test.each(["attached", "cut", "folder"] as const)("%s carries a body ctrl+o reveals", (status) => {
    expect(attachmentExpandable(status)).toBe(true);
  });

  test.each(["path-only", "refused"] as const)("%s carries nothing to reveal", (status) => {
    expect(attachmentExpandable(status)).toBe(false);
  });
});

describe("attachmentLines: collapsed", () => {
  test("AC-8 draws one muted row promising the body", () => {
    const rows = rowsOf([attachment()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].endsWith("(ctrl+o to show)")).toBe(true);
  });

  test("draws the label behind the result prefix, muted", () => {
    const [line] = layoutTranscript([attachment()], { width: WIDTH, theme, expanded: false });
    expect(plainText(line)).toBe(`  ${theme.glyphs.result}  attached @a.ts · 2 lines (ctrl+o to show)`);
    for (const span of line) expect(span.color).toBe("muted");
  });

  test("draws no body rows while collapsed", () => {
    expect(rowsOf([attachment()]).some((row) => row.includes("one"))).toBe(false);
  });

  test("never promises a body for a path-only entry", () => {
    expect(rowsOf([attachment({ status: "path-only", note: "path only: binary", body: "" })])).toEqual([
      `  ${theme.glyphs.result}  attached @a.ts as path only: binary`,
    ]);
  });

  test("never promises a body for a refused entry", () => {
    const refused = attachment({ status: "refused", note: "not attached: outside the repo", body: "" });
    expect(rowsOf([refused])).toEqual([`  ${theme.glyphs.result}  @a.ts not attached: outside the repo`]);
  });
});

describe("attachmentLines: expanded", () => {
  test("AC-9 draws the label row and one indented muted row per body line", () => {
    const rows = rowsOf([attachment()], true);
    expect(rows).toHaveLength(3);
    expect(rows[0].endsWith("(ctrl+o to hide)")).toBe(true);
    expect(rows[1].endsWith("one")).toBe(true);
    expect(rows[2].endsWith("two")).toBe(true);
  });

  test("indents the body the way a skill body is indented, muted", () => {
    const lines = layoutTranscript([attachment()], { width: WIDTH, theme, expanded: true });
    expect(plainText(lines[1])).toBe("     one");
    for (const span of lines[1]) expect(span.color).toBe("muted");
  });

  test("AC-10 draws a path-only entry's label alone however the transcript is expanded", () => {
    const rows = rowsOf([attachment({ status: "path-only", note: "path only: binary", body: "" })], true);
    expect(rows).toHaveLength(1);
  });

  test("expands on its own open flag while the transcript stays collapsed", () => {
    const rows = rowsOf([attachment({ open: true })]);
    expect(rows).toHaveLength(3);
    expect(rows[0].endsWith("(ctrl+o to hide)")).toBe(true);
  });

  test("keeps a blank body line as an indented blank row", () => {
    expect(rowsOf([attachment({ body: "one\n\ntwo\n" })], true)).toEqual([
      "  ⎿  attached @a.ts · 2 lines (ctrl+o to hide)",
      "     one",
      " ".repeat(5),
      "     two",
    ]);
  });

  test("draws no body rows for an attached entry with an empty body", () => {
    expect(rowsOf([attachment({ body: "" })], true)).toEqual(["  ⎿  attached @a.ts · 2 lines (ctrl+o to hide)"]);
  });

  test("wraps a label wider than the layout instead of overflowing it", () => {
    const entry = attachment({ path: `${"x".repeat(80)}.ts`, note: "2 lines" });
    const lines = layoutTranscript([entry], { width: 20, theme, expanded: false });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(plainText(line).length).toBeLessThanOrEqual(20);
  });
});

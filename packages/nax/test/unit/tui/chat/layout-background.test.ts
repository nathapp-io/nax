import { describe, expect, test } from "bun:test";
import { type LayoutOptions, layoutTranscript } from "@/tui/chat/layout";
import { backgroundLines } from "@/tui/chat/layout-background";
import { type LayoutContext, resolveWidth } from "@/tui/chat/layout-lines";
import { plainText, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

/** Colour on, so a case can assert the row is muted rather than only what it says. */
const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
const WIDTH = 120;

type BackgroundEntry = Extract<TranscriptEntry, { kind: "background" }>;

/** A two-line background task notice, as `buildBackgroundTaskNotice` writes one. */
const NOTICE = [
  "[nax-tasks] background command bash-11111111 (bun dev) ended: succeeded, exit code 0, log /o/tasks/1.log",
  "Read its output with `nax-tasks__output`, report the outcome to the user and propose the next step.",
].join("\n");

const SUMMARY = "1 background command ended · 1 succeeded";

/** A background entry; a case opens it or overrides what the row says. */
function background(overrides: Partial<BackgroundEntry> = {}): BackgroundEntry {
  return { kind: "background", summary: SUMMARY, text: NOTICE, ...overrides };
}

function context(expanded: boolean): LayoutContext {
  return { width: resolveWidth(WIDTH), theme, expanded };
}

/** The plain text of every row `backgroundLines` draws for `entry`. */
function rowsOf(entry: BackgroundEntry, expanded: boolean): readonly string[] {
  return backgroundLines(entry, context(expanded)).map(plainText);
}

/** Every span of every row, so a case can assert the whole block is muted. */
function spansOf(lines: readonly StyledLine[]): readonly { color?: string }[] {
  return lines.flatMap((line) => line);
}

/** The plain text of every row the layout drew. */
function texts(lines: readonly StyledLine[]): readonly string[] {
  return lines.map(plainText);
}

function layout(entries: readonly TranscriptEntry[], expanded: boolean): readonly StyledLine[] {
  const options: LayoutOptions = { width: WIDTH, theme, expanded };
  return layoutTranscript(entries, options);
}

/** Where a card's rows start: the gutter, the result glyph and the two columns after it. */
const PREFIX = `  ${theme.glyphs.result}  `;
/** Where a card's indent rows start: as wide as the prefix. */
const INDENT = " ".repeat(PREFIX.length);

describe("backgroundLines: collapsed", () => {
  test("AC-3 draws one muted row behind the result prefix promising the notice", () => {
    const lines = backgroundLines(background(), context(false));
    expect(lines).toHaveLength(1);
    expect(plainText(lines[0])).toBe(`${PREFIX}${SUMMARY} (ctrl+o to show)`);
    for (const span of lines[0]) expect(span.color).toBe("muted");
  });

  test("draws no notice line while collapsed", () => {
    expect(rowsOf(background(), false).some((row) => row.includes("[nax-tasks]"))).toBe(false);
  });
});

describe("backgroundLines: expanded", () => {
  test("AC-4 draws the summary row then one indented muted row per notice line", () => {
    expect(rowsOf(background(), true)).toEqual([
      `${PREFIX}${SUMMARY} (ctrl+o to hide)`,
      `${INDENT}[nax-tasks] background command bash-11111111 (bun dev) ended: succeeded, exit code 0, log /o/tasks/1.log`,
      `${INDENT}Read its output with \`nax-tasks__output\`, report the outcome to the user and propose the next step.`,
    ]);
    for (const span of spansOf(backgroundLines(background(), context(true)))) expect(span.color).toBe("muted");
  });

  test("wraps a notice line wider than the layout so no row overflows it", () => {
    const lines = backgroundLines(background({ text: "x".repeat(200) }), {
      width: resolveWidth(40),
      theme,
      expanded: true,
    });
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(plainText(line).length).toBeLessThanOrEqual(40);
  });
});

describe("layoutTranscript: background entries", () => {
  test("AC-5 an entry's own open draws the open form while the transcript is collapsed", () => {
    expect(texts(layout([background({ open: true })], false))).toEqual(rowsOf(background(), true));
  });

  test("AC-5 an entry's own closed flag draws the collapsed form while the transcript is expanded", () => {
    expect(texts(layout([background({ open: false })], true))).toEqual(rowsOf(background(), false));
  });
});

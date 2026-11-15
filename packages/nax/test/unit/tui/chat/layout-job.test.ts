import { describe, expect, test } from "bun:test";
import type { JobPanelDecision, JobPanelStory, JobPanelView } from "@/chat";
import { layoutTranscript } from "@/tui/chat/layout";
import { formatElapsed, JOB_PANEL_DECISION_ROWS, JOB_PROGRESS_CELLS, jobPanelLines } from "@/tui/chat/layout-job";
import { type LayoutContext, resolveWidth, SHOW_HINT } from "@/tui/chat/layout-lines";
import { plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

/** Colour on, so a case can assert which tone a row was drawn in. */
const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
/** The same glyphs with every colour token off. */
const noColor: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 0 });
const WIDTH = 120;

type JobEntry = Extract<TranscriptEntry, { kind: "job" }>;

/** A live `run` job of `review-and-gate-guards`, as `buildJobPanelView` projects one. */
function view(overrides: Partial<JobPanelView> = {}): JobPanelView {
  return {
    jobId: "run-1a2b3c4d",
    kind: "run",
    target: "review-and-gate-guards",
    state: "running",
    elapsedMs: 2_520_000,
    stories: [],
    decisions: [],
    logTail: [],
    ...overrides,
  };
}

function entry(overrides: Partial<JobPanelView> = {}): JobEntry {
  return { kind: "job", view: view(overrides) };
}

function context(expanded: boolean, resolved: ChatTheme = theme, width = WIDTH): LayoutContext {
  return { width: resolveWidth(width), theme: resolved, expanded };
}

function linesOf(entered: JobEntry, expanded = false, resolved: ChatTheme = theme): readonly StyledLine[] {
  return jobPanelLines(entered, context(expanded, resolved));
}

function rowsOf(entered: JobEntry, expanded = false, resolved: ChatTheme = theme): readonly string[] {
  return linesOf(entered, expanded, resolved).map(plainText);
}

/** The trimmed text of every row, so a case can find a section heading behind its indent. */
function trimmed(rows: readonly string[]): readonly string[] {
  return rows.map((row) => row.trim());
}

/** The spans of `rows` whose own text is exactly `text`, across every row. */
function spansWithText(lines: readonly StyledLine[], text: string): readonly Span[] {
  return lines.flatMap((row) => row.filter((span) => span.text === text));
}

function decisions(count: number, flagged = 0): readonly JobPanelDecision[] {
  return Array.from({ length: count }, (_, index) => ({
    line: `decision-${String(index + 1).padStart(2, "0")}`,
    flagged: index < flagged,
  }));
}

function stories(): readonly JobPanelStory[] {
  return [
    { id: "US-001", title: "Job panel view model", status: "passed", current: false },
    { id: "US-002", title: "Job panel layout", status: "in-progress", current: true },
    { id: "US-003", title: "Live panels", status: "pending", current: false },
  ];
}

/** Progress, a current story and two decisions (one flagged): the panel's full second row. */
function runningView(): Partial<JobPanelView> {
  return {
    cost: 3.18,
    progress: { passed: 4, total: 13 },
    current: { storyId: "US-005", phase: "review" },
    decisions: decisions(2, 1),
  };
}

describe("formatElapsed", () => {
  test("AC-1 renders seconds under a minute", () => {
    expect(formatElapsed(42_000)).toBe("42s");
  });

  test("AC-2 renders whole minutes under an hour", () => {
    expect(formatElapsed(2_520_000)).toBe("42m");
  });

  test("AC-3 renders hours with two-digit minutes", () => {
    expect(formatElapsed(3_900_000)).toBe("1h 05m");
  });

  test("treats a negative elapsed as none", () => {
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("jobPanelLines: collapsed row one", () => {
  test("AC-4 draws the pointer, command, state, elapsed, cost and show hint", () => {
    const rows = rowsOf(entry(runningView()));
    expect(rows[0]).toBe(`${theme.glyphs.pointer} nax run review-and-gate-guards  running  42m  $3.18 ${SHOW_HINT}`);
  });

  test("AC-5 draws the state word running in the accent colour", () => {
    const spans = spansWithText(linesOf(entry(runningView())), "running");
    expect(spans).toHaveLength(1);
    expect(spans[0].color).toBe("accent");
  });

  test("AC-6 draws the state word failed in the danger colour", () => {
    const spans = spansWithText(linesOf(entry({ state: "failed" })), "failed");
    expect(spans).toHaveLength(1);
    expect(spans[0].color).toBe("danger");
  });

  test("AC-7 names a bot review job as `nax bot review #<target>`", () => {
    const rows = rowsOf(entry({ kind: "bot_review", target: "2936", elapsedMs: 0 }));
    expect(rows[0]).toContain("nax bot review #2936");
  });

  test("names a bot fix job as `nax bot fix #<target>`", () => {
    const rows = rowsOf(entry({ kind: "bot_fix", target: "2936", elapsedMs: 0 }));
    expect(rows[0]).toContain("nax bot fix #2936");
  });

  test("leaves the cost out when the view carries none", () => {
    const rows = rowsOf(entry({ progress: { passed: 4, total: 13 } }));
    expect(rows[0]).toBe(`${theme.glyphs.pointer} nax run review-and-gate-guards  running  42m ${SHOW_HINT}`);
  });
});

describe("jobPanelLines: collapsed progress row", () => {
  test("AC-8 draws 5 full and 11 empty cells then the counts for 4 of 13", () => {
    const rows = rowsOf(entry({ progress: { passed: 4, total: 13 } }));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe(`${"█".repeat(5)}${"░".repeat(11)} 4/13`);
  });

  test("AC-8 draws the full cells accent and the empty ones muted", () => {
    const lines = linesOf(entry({ progress: { passed: 4, total: 13 } }));
    expect(spansWithText(lines, "█".repeat(5))[0]?.color).toBe("accent");
    expect(spansWithText(lines, "░".repeat(11))[0]?.color).toBe("muted");
  });

  test("AC-9 draws every cell empty when the total is 0", () => {
    const rows = rowsOf(entry({ progress: { passed: 0, total: 0 } }));
    expect(rows[1]).toBe(`${"░".repeat(JOB_PROGRESS_CELLS)} 0/0`);
  });

  test("AC-10 names the current story and its phase in the second row", () => {
    const rows = rowsOf(entry({ progress: { passed: 4, total: 13 }, current: { storyId: "US-005", phase: "review" } }));
    expect(rows[1]).toContain("· US-005 review");
  });
});

describe("jobPanelLines: advisor decisions in the second row", () => {
  test("AC-11 counts two decisions and names the flagged one", () => {
    const rows = rowsOf(entry(runningView()));
    expect(rows[1]).toContain("· 2 advisor decisions (1 flagged)");
  });

  test("AC-12 draws the flagged count in the warning colour", () => {
    const spans = spansWithText(linesOf(entry(runningView())), " (1 flagged)");
    expect(spans).toHaveLength(1);
    expect(spans[0].color).toBe("warning");
  });

  test("AC-13 draws a decisions-only second row for one decision and no progress", () => {
    const rows = rowsOf(entry({ decisions: decisions(1) }));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe("1 advisor decision");
  });

  test("draws no second row without progress, a current story or a decision", () => {
    expect(rowsOf(entry())).toHaveLength(1);
  });
});

describe("jobPanelLines: expanded sections", () => {
  test("AC-14 draws no section heading while collapsed", () => {
    const rows = trimmed(rowsOf(entry({ ...runningView(), stories: stories(), logTail: ["started"] })));
    for (const heading of ["stories", "advisor decisions", "log"]) expect(rows).not.toContain(heading);
  });

  test("AC-15 draws the stories, advisor decisions and log headings in that order", () => {
    const rows = trimmed(rowsOf(entry({ ...runningView(), stories: stories(), logTail: ["started"] }), true));
    const order = ["stories", "advisor decisions", "log"].map((heading) => rows.indexOf(heading));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order[0]).toBeGreaterThanOrEqual(0);
  });

  test("AC-16 omits the advisor decisions heading when there are none", () => {
    const rows = trimmed(rowsOf(entry({ ...runningView(), decisions: [], stories: stories() }), true));
    expect(rows).toContain("stories");
    expect(rows).not.toContain("advisor decisions");
  });

  test("AC-17 marks the current story's row with its phase", () => {
    const rows = rowsOf(
      entry({
        current: { storyId: "US-002", phase: "review" },
        stories: stories(),
      }),
      true,
    ).filter((row) => row.includes("◂ review"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("US-002 Job panel layout");
  });

  test("AC-17 draws every story's status word, id and title", () => {
    const rows = trimmed(rowsOf(entry({ stories: stories() }), true));
    expect(rows).toContain("passed US-001 Job panel view model");
    expect(rows).toContain("in-progress US-002 Job panel layout");
    expect(rows).toContain("pending US-003 Live panels");
  });

  test("AC-18 starts a flagged decision row with the warning glyph", () => {
    const lines = linesOf(entry({ decisions: decisions(2, 1) }), true);
    const flagged = lines.filter((row) => plainText(row).trimStart().startsWith(theme.glyphs.warning));
    expect(flagged).toHaveLength(1);
    expect(plainText(flagged[0]).trim()).toBe(`${theme.glyphs.warning} decision-01`);
    for (const span of flagged[0]) expect(span.color).toBe("warning");
  });

  test("AC-19 caps the decision rows and counts the rest", () => {
    const rows = trimmed(rowsOf(entry({ decisions: decisions(12) }), true));
    expect(rows.filter((row) => row.startsWith("decision-"))).toHaveLength(JOB_PANEL_DECISION_ROWS);
    expect(rows).toContain(`decision-${String(JOB_PANEL_DECISION_ROWS)}`);
    expect(rows).toContain(`+${12 - JOB_PANEL_DECISION_ROWS} more`);
    expect(rows).not.toContain(`decision-${JOB_PANEL_DECISION_ROWS + 1}`);
  });

  test("draws the log tail under its heading, muted", () => {
    const lines = linesOf(entry({ logTail: ["[nax-jobs] started", "[nax-jobs] story 2"] }), true);
    const rows = lines.map(plainText).map((row) => row.trim());
    expect(rows).toContain("log");
    expect(rows).toContain("[nax-jobs] started");
    expect(rows).toContain("[nax-jobs] story 2");
    const span = lines
      .filter((row) => plainText(row).includes("[nax-jobs] started"))
      .flat()
      .find((item) => item.text.includes("[nax-jobs] started"));
    expect(span?.color).toBe("muted");
  });
});

describe("jobPanelLines: colour and width", () => {
  test("AC-20 draws the same rows with no colour styles when the theme has no colour", () => {
    const rich = entry({ ...runningView(), stories: stories(), logTail: ["started"] });
    const lines = linesOf(rich, true, noColor);
    expect(lines.map(plainText)).toEqual([...rowsOf(rich, true)]);
    for (const span of lines.flat()) {
      expect(span.color).toBeUndefined();
      expect(span.background).toBeUndefined();
    }
  });

  test("wraps every row inside a narrow layout", () => {
    const lines = jobPanelLines(
      entry({ ...runningView(), stories: stories(), logTail: ["started"] }),
      context(true, theme, 30),
    );
    for (const row of lines) expect(plainText(row).length).toBeLessThanOrEqual(30);
  });
});

describe("layoutTranscript: the job dispatch case", () => {
  test("routes a job entry to the panel renderer at either expansion", () => {
    const rich = entry({ ...runningView(), stories: stories() });
    const options = (expanded: boolean) => ({ width: resolveWidth(WIDTH), theme, expanded });
    expect(layoutTranscript([rich], options(false)).map(plainText)).toEqual([...rowsOf(rich, false)]);
    expect(layoutTranscript([rich], options(true)).map(plainText)).toEqual([...rowsOf(rich, true)]);
  });
});

describe("resolved theme progress glyphs", () => {
  test("AC-21 the ASCII theme draws progress as '#' and '.'", () => {
    const ascii = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 3 });
    expect(ascii.glyphs.progressFull).toBe("#");
    expect(ascii.glyphs.progressEmpty).toBe(".");
  });

  test("AC-22 the Unicode theme draws progress as '█' and '░'", () => {
    expect(theme.glyphs.progressFull).toBe("█");
    expect(theme.glyphs.progressEmpty).toBe("░");
  });
});

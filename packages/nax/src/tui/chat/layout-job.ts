/**
 * Job panel rows — the transcript card that makes a long `nax plan` / `nax run` visible
 * while it runs: one row naming the job, its state, how long it has run and what it has
 * cost, a second row with the story progress, the story being worked on and how many
 * advisor decisions the run has taken, and — expanded — the PRD's stories, the decision
 * lines and the job log tail.
 *
 * The two rows are the collapsed form and they are terminal rows, not cards: the pointer
 * opens row one and row two starts at the left edge, so the panel reads as the job's own
 * headline rather than as a nested result. The expanded sections sit under muted headings,
 * indented with `cardIndent`, the way a card's summary lines do. Every row is laid out
 * through `prefixedLine`, so a narrow terminal wraps the panel instead of losing it.
 *
 * The view is `buildJobPanelView`'s projection (chat-job-panel US-001) and carries no
 * styling: a tone is a token here, resolved by the theme at draw time. With colour off the
 * rows are the same text with no colour at all.
 *
 * A `job` entry's own `open` flag is not read here: the entry owns its expansion through
 * `cachedLines` in `layout.ts`, which passes the effective `expanded` in the context.
 *
 * A log line is the one row source that can be arbitrarily long, so it is drawn through a row
 * budget: only the columns `JOB_LOG_ROWS_PER_LINE` rows can hold are ever wrapped, and a line
 * with text left over ends in the theme's ellipsis (review-0942 finding 12).
 */
import type { JobPanelView } from "@/chat";
import {
  cardIndent,
  cardRows,
  HIDE_HINT,
  type LayoutContext,
  oneLine,
  prefixedLine,
  SHOW_HINT,
  SOURCE_LINE_BREAK,
  SPACE,
  type SpanStyle,
  styled,
} from "./layout-lines";
import { displayWidth, type Span, type StyledLine, sanitizeText } from "./styled-line";
import type { ChatColorToken, ChatTheme } from "./theme";
import type { TranscriptEntry } from "./transcript-model";
import { headColumns, markSpansEnd, wrapSpans } from "./wrap";

/** The cells the progress bar draws. Fixed: the panel is a glance, not a dashboard. */
export const JOB_PROGRESS_CELLS = 16;
/** The decision lines the expanded panel shows before it counts the rest. */
export const JOB_PANEL_DECISION_ROWS = 10;
/** The rows one log line may draw, its truncation mark included. */
export const JOB_LOG_ROWS_PER_LINE = 4;

/** The wrapping the log rows go through, injectable so a test can measure what it is handed. */
export const _layoutJobDeps: {
  wrap: (
    spans: readonly Span[],
    options: { readonly width: number; readonly prefix?: readonly Span[] },
  ) => readonly StyledLine[];
} = { wrap: wrapSpans };

/** The gap between row one's fields, and the single space before its hint. */
const FIELD_GAP = "  ";
/** What separates row two's parts. */
const SECTION_SEPARATOR = " · ";
/** The mark a current story's row closes with, ahead of the phase it is in. */
const CURRENT_MARK = "◂";
/** Opens the count of decision lines the panel withholds. */
const HIDDEN_MARK = "+";
const MUTED: SpanStyle = { color: "muted" };

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MINUTE_DIGITS = 2;
const MONEY_DIGITS = 2;

type JobEntry = Extract<TranscriptEntry, { kind: "job" }>;
type JobState = JobPanelView["state"];
type StoryStatusWord = JobPanelView["stories"][number]["status"];

/** `<s>s` under a minute, `<m>m` under an hour, then `<h>h <mm>m` with two-digit minutes. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  return `${hours}h ${String(rest).padStart(MINUTE_DIGITS, "0")}m`;
}

/** The colour the state word is drawn in: a finished job says how it ended. */
function stateColor(state: JobState): ChatColorToken {
  switch (state) {
    case "running":
      return "accent";
    case "succeeded":
      return "success";
    case "failed":
    case "lost":
      return "danger";
    case "cancelled":
      return "warning";
  }
}

/** The colour a story's status word is drawn in; a status the panel does not rank stays muted. */
function storyColor(status: StoryStatusWord): ChatColorToken {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
    case "regression-failed":
      return "danger";
    case "in-progress":
      return "accent";
    default:
      return "muted";
  }
}

/** What the job's command line was: a bot job reviews or fixes a PR, not a feature. */
function commandOf(view: JobPanelView): string {
  switch (view.kind) {
    case "bot_review":
      return `nax bot review #${view.target}`;
    case "bot_fix":
      return `nax bot fix #${view.target}`;
    case "plan":
    case "run":
      return `nax ${view.kind} ${view.target}`;
    case "publish":
      return `nax run ${view.target} --publish-only`;
  }
}

/** A view string as one sanitised row's worth of text. */
function flat(text: string): string {
  return oneLine(sanitizeText(text));
}

/**
 * Row one's fields behind the pointer: the command, the state word in its colour, how long
 * the job has run, what it has cost when the view knows, and the expansion hint.
 */
function factSpans(view: JobPanelView, hint: string): readonly Span[] {
  const spans: Span[] = [
    styled(flat(commandOf(view))),
    styled(FIELD_GAP),
    styled(view.state, { color: stateColor(view.state) }),
    styled(FIELD_GAP),
    styled(formatElapsed(view.elapsedMs)),
  ];
  if (view.cost !== undefined) {
    spans.push(styled(FIELD_GAP), styled(`$${view.cost.toFixed(MONEY_DIGITS)}`));
  }
  spans.push(styled(`${SPACE}${hint}`));
  return spans;
}

/** Row one: the pointer, then the job's headline facts, and the hint that ends it. */
function headlineRows(entry: JobEntry, context: LayoutContext): readonly StyledLine[] {
  const hint = context.expanded ? HIDE_HINT : SHOW_HINT;
  const head: readonly Span[] = [styled(`${context.theme.glyphs.pointer}${SPACE}`)];
  return prefixedLine(factSpans(entry.view, hint), head, context);
}

/**
 * The progress bar and its counts: `round(cells * passed / total)` filled cells, the rest
 * empty, then `<passed>/<total>`. A total of nothing fills no cell, so an unplanned job
 * draws an empty bar rather than a full one.
 */
function progressSpans(progress: NonNullable<JobPanelView["progress"]>, theme: ChatTheme): readonly Span[] {
  const filled =
    progress.total > 0
      ? Math.min(JOB_PROGRESS_CELLS, Math.max(0, Math.round((JOB_PROGRESS_CELLS * progress.passed) / progress.total)))
      : 0;
  return [
    styled(theme.glyphs.progressFull.repeat(filled), { color: "accent" }),
    styled(theme.glyphs.progressEmpty.repeat(JOB_PROGRESS_CELLS - filled), MUTED),
    styled(`${SPACE}${progress.passed}/${progress.total}`),
  ];
}

/** `<n> advisor decision(s)`, and `<m> flagged` in the warning colour when any is flagged. */
function decisionCountSpans(decisions: JobPanelView["decisions"]): readonly Span[] {
  const flagged = decisions.filter((decision) => decision.flagged).length;
  const word = decisions.length === 1 ? "advisor decision" : "advisor decisions";
  const spans: Span[] = [styled(`${decisions.length} ${word}`)];
  if (flagged > 0) spans.push(styled(` (${flagged} flagged)`, { color: "warning" }));
  return spans;
}

/** Row two's parts, in order, separated by ` · `. */
function secondRowSections(view: JobPanelView, theme: ChatTheme): readonly (readonly Span[])[] {
  const sections: (readonly Span[])[] = [];
  if (view.progress) sections.push(progressSpans(view.progress, theme));
  if (view.current) sections.push([styled(flat(`${view.current.storyId} ${view.current.phase}`))]);
  if (view.decisions.length > 0) sections.push(decisionCountSpans(view.decisions));
  return sections;
}

/** Row two: progress, the current story and the decision count, when there is any of them. */
function progressRows(entry: JobEntry, context: LayoutContext): readonly StyledLine[] {
  const sections = secondRowSections(entry.view, context.theme);
  if (sections.length === 0) return [];
  const spans = sections.flatMap((section, index) =>
    index === 0 ? [...section] : [styled(SECTION_SEPARATOR), ...section],
  );
  return prefixedLine(spans, [], context);
}

/** A section's heading: the name alone, muted, behind the card indent. */
function headingRows(name: string, context: LayoutContext): readonly StyledLine[] {
  const indent = cardIndent(context.theme);
  return cardRows(name, { head: indent, rest: indent }, MUTED, context);
}

/** One row per story: its status word in that status's colour, its id and title, and the phase it is in. */
function storyRows(entry: JobEntry, context: LayoutContext): readonly StyledLine[] {
  const { stories, current } = entry.view;
  if (stories.length === 0) return [];
  const indent = styled(cardIndent(context.theme));
  return stories.flatMap((story) => {
    const spans: Span[] = [
      styled(story.status, { color: storyColor(story.status) }),
      styled(`${SPACE}${flat(`${story.id} ${story.title}`)}`),
    ];
    if (story.current && current !== undefined) {
      spans.push(styled(`${SPACE}${CURRENT_MARK}${SPACE}${flat(current.phase)}`));
    }
    return prefixedLine(spans, [indent], context);
  });
}

/**
 * One row per decision line, at most `JOB_PANEL_DECISION_ROWS` of them and a `+<n> more`
 * when the run has taken more. A flagged ruling opens with the theme's warning glyph and is
 * drawn in the warning colour, so the decisions the run needs a human for stand out.
 */
function decisionRows(entry: JobEntry, context: LayoutContext): readonly StyledLine[] {
  const { decisions } = entry.view;
  if (decisions.length === 0) return [];
  const shown = decisions.slice(0, JOB_PANEL_DECISION_ROWS);
  const rows = shown.flatMap((decision) => {
    const text = flat(decision.line);
    const style: SpanStyle = decision.flagged ? { color: "warning" } : MUTED;
    const label = decision.flagged ? `${context.theme.glyphs.warning}${SPACE}${text}` : text;
    return prefixedLine([styled(label, style)], [styled(cardIndent(context.theme), style)], context);
  });
  const hidden = decisions.length - shown.length;
  if (hidden > 0) {
    const indent = styled(cardIndent(context.theme), MUTED);
    rows.push(...prefixedLine([styled(`${HIDDEN_MARK}${hidden} more`, MUTED)], [indent], context));
  }
  return rows;
}

/** The mark a log line ends with when its row budget cannot draw the rest of it. */
function truncationMark(context: LayoutContext): Span {
  return styled(context.theme.glyphs.ellipsis, MUTED);
}

/**
 * One log line's rows, at most `JOB_LOG_ROWS_PER_LINE` of them. Only the columns that budget
 * can draw are ever wrapped — a 256 KiB line costs the budget's work, not its own — and a line
 * with text left over ends in the theme's ellipsis.
 */
function boundedRows(text: string, indent: string, context: LayoutContext): readonly StyledLine[] {
  const prefix = styled(indent, MUTED);
  const columns = Math.max(1, context.width - displayWidth(indent));
  const head = headColumns(text, JOB_LOG_ROWS_PER_LINE * columns);
  const rows = _layoutJobDeps.wrap([styled(head.text, MUTED)], { width: context.width, prefix: [prefix] });
  const kept = rows.slice(0, JOB_LOG_ROWS_PER_LINE);
  if (!head.more && kept.length === rows.length) return kept;
  const last = markSpansEnd(kept[kept.length - 1], context.width, truncationMark(context));
  return [...kept.slice(0, -1), last];
}

/** The job log's tail: one muted block per line, each bounded to `JOB_LOG_ROWS_PER_LINE` rows. */
function logRows(entry: JobEntry, context: LayoutContext): readonly StyledLine[] {
  const indent = cardIndent(context.theme);
  return entry.view.logTail.flatMap((source) =>
    sanitizeText(source)
      .split(SOURCE_LINE_BREAK)
      .flatMap((physical) => boundedRows(physical, indent, context)),
  );
}

/** The sections a view actually has something to show for, in the panel's order. */
function expandedRows(entry: JobEntry, context: LayoutContext): readonly StyledLine[] {
  const { view } = entry;
  const rows: StyledLine[] = [];
  if (view.stories.length > 0) {
    rows.push(...headingRows("stories", context), ...storyRows(entry, context));
  }
  if (view.decisions.length > 0) {
    rows.push(...headingRows("advisor decisions", context), ...decisionRows(entry, context));
  }
  if (view.logTail.length > 0) {
    rows.push(...headingRows("log", context), ...logRows(entry, context));
  }
  return rows;
}

/** The same rows with every style dropped: what a colourless terminal draws. */
function withoutColor(rows: readonly StyledLine[]): readonly StyledLine[] {
  return rows.map((row) => row.map((span) => ({ text: span.text })));
}

/**
 * One job's panel: the headline row, the progress row, and — expanded — the stories, the
 * advisor decisions and the log tail. A section with nothing to show is omitted.
 */
export function jobPanelLines(entry: JobEntry, context: LayoutContext): readonly StyledLine[] {
  const rows = [
    ...headlineRows(entry, context),
    ...progressRows(entry, context),
    ...(context.expanded ? expandedRows(entry, context) : []),
  ];
  return context.theme.color ? rows : withoutColor(rows);
}

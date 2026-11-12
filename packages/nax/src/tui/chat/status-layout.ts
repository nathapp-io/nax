import { type footerModel, workingLine } from "./chat-status";
import { type FooterRole, type FooterSegment, footerSegments } from "./footer-segments";
import type { StyledLine } from "./styled-line";
import { cutSpans, spansWidth } from "./wrap";

/** The columns between the left and right sides of the row. */
const GAP = 2;
/** The separator between two parts of one side. */
const SEPARATOR = " · ";
/**
 * What a job strip too wide to draw becomes: how many jobs and tasks are running. The key it
 * names is `JOBS_KEY` in `use-jobs-opener.ts`, the gesture that opens the list it counts.
 */
const SUMMARY_SUFFIX = " active (ctrl+g)";

/** The footer's input, taken from `footerModel` so the two can never disagree about it. */
type FooterInput = Parameters<typeof footerModel>[0];

/** One candidate of the pipeline: the two sides as the segments still standing. */
interface FooterState {
  readonly left: readonly FooterSegment[];
  readonly right: readonly FooterSegment[];
}

/**
 * The footer's role-tagged segments, swappable so a test can prove what the fitter reads:
 * the mounted-screen seam (US-002) substitutes them and asserts the drawn footer row carries
 * the substitute's texts. Production always uses `footerSegments`.
 */
export const _statusLayoutDeps = { footerSegments };

/** A side's segments as one line, the separator joining one part to the next. */
function joinedLine(segments: readonly FooterSegment[]): StyledLine {
  return segments.flatMap((segment, index) =>
    index === 0 ? [segment.span] : [{ text: SEPARATOR, color: "muted" as const }, segment.span],
  );
}

/** The side without one role's segments — how a step drops a part. */
function without(segments: readonly FooterSegment[], role: FooterRole): readonly FooterSegment[] {
  return segments.filter((segment) => segment.role !== role);
}

/** The job strip replaced whole by the count of what is running, as step 3 does. */
function summarised(segments: readonly FooterSegment[], summary: string): readonly FooterSegment[] {
  const replacement: FooterSegment = { role: "strip", span: { text: summary } };
  return segments.map((segment) => (segment.role === "strip" ? replacement : segment));
}

/** The clickable columns of the strip, wherever it stands on the right side; 0 when none does. */
function stripWidthOf(segments: readonly FooterSegment[]): number {
  const strip = segments.find((segment) => segment.role === "strip");
  return strip === undefined ? 0 : spansWidth([strip.span]);
}

/** How many jobs and tasks are running, as the strip's replacement names them. */
function summaryOf(input: FooterInput): string {
  return `${(input.jobs?.length ?? 0) + (input.tasks?.length ?? 0)}${SUMMARY_SUFFIX}`;
}

/**
 * The states the pipeline tries, in order: the footer as `footerSegments` gave it, then each
 * drop this story defines — the model, the context meter, the strip replaced by the running
 * count, that count, and the hint's extra keybinding. Later steps are US-003's.
 */
function fitStates(
  left: readonly FooterSegment[],
  right: readonly FooterSegment[],
  summary: string,
): readonly FooterState[] {
  const noModel = without(right, "model");
  const noContext = without(noModel, "context");
  const counted = without(summarised(noContext, summary), "strip");
  return [
    { left, right },
    { left, right: noModel },
    { left, right: noContext },
    { left, right: summarised(noContext, summary) },
    { left, right: counted },
    { left: without(left, "gestureExtra"), right: counted },
  ];
}

/**
 * Fit before Ink lays out the row, keeping gestures ahead of duplicated model metadata.
 *
 * The input's footer is read as role-tagged segments, and the first state whose two sides fit
 * the row is the one drawn: metering is dropped before the running count, and the count before
 * the hint's secondary keybinding. No segment's text or position decides what is dropped.
 */
export function fittedFooterModel(input: FooterInput & { readonly width: number }): {
  left: StyledLine;
  right: StyledLine;
  stripWidth: number;
} {
  const width = Math.max(1, Math.floor(input.width));
  const footer = _statusLayoutDeps.footerSegments(input);
  for (const state of fitStates(footer.left, footer.right, summaryOf(input))) {
    const left = joinedLine(state.left);
    const right = joinedLine(state.right);
    if (spansWidth(left) + spansWidth(right) + (state.right.length === 0 ? 0 : GAP) <= width) {
      return { left, right, stripWidth: stripWidthOf(state.right) };
    }
  }
  // The steps that shorten the left side — the sandbox warning, the mode, the cost and the
  // elided last resort — are US-003's. Until they exist the gesture side is cut, as before.
  return { left: cutSpans(joinedLine(footer.left), width), right: [], stripWidth: 0 };
}

/** A narrow working row keeps its phase and time; the footer carries the active escape hint. */
export function fittedWorkingLine(
  ...[status, now, glyphs, hint, width]: [...Parameters<typeof workingLine>, number]
): StyledLine | undefined {
  const line = workingLine(status, now, glyphs, hint);
  if (line === undefined || spansWidth(line) <= width) return line;
  const started = Date.parse(status.startedAt ?? "");
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  return cutSpans([...line.slice(0, -1), { text: ` (${seconds}s)`, color: "muted" }], width);
}

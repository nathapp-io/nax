import { type footerModel, GLYPHS, type TurnStatus, workingLine } from "./chat-status";
import { type FooterRole, type FooterSegment, footerSegments } from "./footer-segments";
import type { Span, StyledLine } from "./styled-line";
import type { ChatGlyphs } from "./theme";
import { elideSpansEnd, spansWidth } from "./wrap";

/** The columns between the left and right sides of the row. */
const GAP = 2;
/** The separator between two parts of one side. */
const SEPARATOR = " · ";
/**
 * What a job strip too wide to draw becomes: how many jobs and tasks are running. The key it
 * names is `JOBS_KEY` in `use-jobs-opener.ts`, the gesture that opens the list it counts.
 */
const SUMMARY_SUFFIX = " active (ctrl+g)";
/** What the sandbox warning is shortened to when the row cannot afford it in full. */
const SHORT_WARNING = "sandbox n/a";
/** A cut suffix is drawn in the muted colour the measurement around it is drawn in. */
const MARKER_COLOR = "muted";

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

/** The sandbox warning in its short form, drawn in the colour the long form carried. */
function shortened(segments: readonly FooterSegment[]): readonly FooterSegment[] {
  return segments.map((segment) =>
    segment.role === "sandbox" ? { role: segment.role, span: { ...segment.span, text: SHORT_WARNING } } : segment,
  );
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
 * The right side's steps, in order: the footer as `footerSegments` gave it, then the model,
 * the context meter, the strip replaced by the running count, that count, and the hint's extra
 * keybinding. The left side's steps follow in `leftStates`.
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

/** How the sandbox reads to the pipeline: the two states it can shorten, and off. */
type SandboxKind = "available" | "unavailable" | "off";

/**
 * The sandbox's state as the pipeline reads it, from the state it was given rather than from a
 * drawn text: `off` covers a disabled sandbox and one the host never reported.
 */
function sandboxKindOf(sandbox: FooterInput["state"]["sandbox"]): SandboxKind {
  if (sandbox?.kind === "available") return "available";
  return sandbox?.kind === "unavailable" ? "unavailable" : "off";
}

/**
 * The left side's steps and then the cost, each state differing from the one before it by that
 * one step: a sandbox that is off goes first (the header still states it), then the mode, then
 * the warning's short form — never the warning itself — and the cost last.
 */
function leftStates(state: FooterState, kind: SandboxKind): readonly FooterState[] {
  const noOffSandbox = { left: kind === "off" ? without(state.left, "sandbox") : state.left, right: state.right };
  const noMode = { left: without(noOffSandbox.left, "mode"), right: noOffSandbox.right };
  const warning = { left: kind === "unavailable" ? shortened(noMode.left) : noMode.left, right: noMode.right };
  return [noOffSandbox, noMode, warning, { left: warning.left, right: without(warning.right, "cost") }];
}

/** Every state the pipeline tries, in order: the right side's steps, then the left side's. */
function pipelineStates(
  left: readonly FooterSegment[],
  right: readonly FooterSegment[],
  input: FooterInput,
): readonly FooterState[] {
  const states = fitStates(left, right, summaryOf(input));
  return [...states, ...leftStates(states[states.length - 1], sandboxKindOf(input.state.sandbox))];
}

/** Whether the state's two sides and the gap between them fit `width` columns. */
function fitsIn(state: FooterState, width: number): boolean {
  const gap = state.right.length === 0 ? 0 : GAP;
  return spansWidth(joinedLine(state.left)) + spansWidth(joinedLine(state.right)) + gap <= width;
}

/** The state as the row is drawn, with the columns of the strip the jobs list is opened from. */
function drawn(state: FooterState): { left: StyledLine; right: StyledLine; stripWidth: number } {
  return { left: joinedLine(state.left), right: joinedLine(state.right), stripWidth: stripWidthOf(state.right) };
}

/**
 * Fit before Ink lays out the row, keeping gestures ahead of duplicated model metadata.
 *
 * The input's footer is read as role-tagged segments, and the first state whose two sides fit
 * the row is the one drawn: the model and the context meter go first, the running count before
 * the hint's secondary keybinding, then a sandbox that is off, the mode, the warning's short
 * form and the cost. When even the cost does not fit, the left side alone is elided at its end.
 * No segment's text or position decides what is dropped.
 */
export function fittedFooterModel(input: FooterInput & { readonly width: number }): {
  left: StyledLine;
  right: StyledLine;
  stripWidth: number;
} {
  const width = Math.max(1, Math.floor(input.width));
  const footer = _statusLayoutDeps.footerSegments(input);
  const states = pipelineStates(footer.left, footer.right, input);
  for (const state of states) {
    if (fitsIn(state, width)) return drawn(state);
  }
  const last = states[states.length - 1];
  const glyphs = input.glyphs ?? GLYPHS;
  const marker: Span = { text: glyphs.ellipsis, color: MARKER_COLOR };
  return { left: elideSpansEnd(joinedLine(last.left), width, marker), right: [], stripWidth: 0 };
}

/**
 * A narrow working row keeps its phase and time; the footer carries the active escape hint.
 * The seconds and their guards are `workingLine`'s own, so the two rows can never disagree
 * about the elapsed time.
 */
export function fittedWorkingLine(
  status: TurnStatus,
  now: number,
  glyphs: ChatGlyphs,
  hint: string | undefined,
  width: number,
): StyledLine | undefined {
  return workingLine(status, now, glyphs, hint, width);
}

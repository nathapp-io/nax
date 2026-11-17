/**
 * The chat frame's allocator: one deterministic answer to "how many rows does each part of
 * the screen get, and where does each of them start?".
 *
 * The screen used to add up its regions' minimums in `ChatApp.tsx` and hope the total fitted
 * the terminal. It did not: seventeen unresolved steers can overflow an 80x24 frame without
 * any resizing, because every region asked for its own minimum and nothing owned the sum. So
 * the arithmetic lives here instead — pure, one call, one result — and everything else in the
 * screen reads that result rather than recomputing a budget of its own.
 *
 * The parts, in the order the screen draws them: the header's three rows (a title, the path
 * line and the rule that closes it off), the transcript, the live working line with one
 * explicit pad row above and below it, the combined pending previews (steers then queue), the
 * surface that owns the bottom region — an ask card, a picker, or the input — the menu drawn
 * under the input, and the footer.
 *
 * What cannot be given up is the essential set: the visible surface's own minimum, the footer,
 * and the live working line while a turn runs. Everything else yields, in one fixed order, when
 * the terminal is too short for the frame it asked for: the working gaps (as a pair), the
 * previews, the menu's rows, the surface's rows beyond its minimum, the header's path line and
 * rule (together), the header's title, and finally the one transcript row the frame reserved.
 * Whatever is left over goes to the transcript. An essential set that still does not fit is a
 * terminal too small to hold the surface at all, and the frame becomes a single diagnostic row
 * instead of an interactive screen whose controls are half clipped away.
 *
 * The result is the sole geometry model: each region's row count and zero-based top, the
 * surface actually visible, and which keyboard and mouse targets are live inside those bounds.
 * Terminal events are 1-based, so the conversion belongs at that boundary, not here.
 *
 * Nothing here measures a component: the caller passes each surface's `minimum` and `desired`
 * from the component's own measurement (`measureInput`, `measurePicker`, `measureAskCard`), so
 * a drawn surface and its allocation cannot disagree.
 */
import { MAX_PENDING_PREVIEW_ROWS } from "./message-queue";

/** One row of slack: the frame never fills the terminal's last row. */
const FRAME_SLACK_ROWS = 1;
/** The most a diagnostic fallback draws, and the whole frame a one-row terminal gets. */
const DIAGNOSTIC_ROWS = 1;
/** The header's three rows: the product/session line, the path line, and the closing rule. */
const HEADER_TITLE_ROWS = 1;
const HEADER_PATH_ROWS = 1;
const HEADER_RULE_ROWS = 1;
/** The footer's one row: the hints and the job strip. */
const FOOTER_ROWS = 1;
/** The one transcript row the frame reserves before any leftover space is given to it. */
const TRANSCRIPT_ROWS = 1;
/** The live working line, and the one pad row it keeps on each side. */
const STATUS_ROWS = 1;
const STATUS_GAP_ROWS = 1;
const NO_ROWS = 0;
/** The height a terminal that reports none is assumed to have, as the screen's own fallback is. */
const FALLBACK_ROWS = 24;

/** What a terminal too small to hold its surface says instead of drawing it, clipped to width. */
export const TERMINAL_TOO_SMALL = "Terminal too small — enlarge to continue";

/** The surface the frame actually draws. `diagnostic` replaces all three interactive ones. */
export type ChatSurface = "input" | "ask" | "picker" | "diagnostic";

/** Every region, in the order the screen draws them. */
export const FRAME_REGION_ORDER = [
  "headerTitle",
  "headerPath",
  "headerRule",
  "transcript",
  "statusGapBefore",
  "status",
  "statusGapAfter",
  "previews",
  "surface",
  "menus",
  "diagnostic",
  "footer",
] as const;

export type FrameRegionName = (typeof FRAME_REGION_ORDER)[number];

/** One region's share of the frame: how many rows, and the zero-based row it starts on. */
export interface FrameRegion {
  readonly rows: number;
  readonly top: number;
}

export type ChatFrameRegions = Readonly<Record<FrameRegionName, FrameRegion>>;

/**
 * What is live inside the allocated bounds. A target that is not active must ignore both its
 * keys and its clicks: it either has no rows or is hidden behind the surface that owns them.
 */
export interface ChatFrameTargets {
  /** The ask card's keys. */
  readonly ask: boolean;
  /** The picker's choice, cycle, stop and cancel keys. */
  readonly picker: boolean;
  /** The chat input's keys. */
  readonly input: boolean;
  /** The menu under the input: its navigation keys, and its completions. */
  readonly menus: boolean;
  /** The transcript viewport: its scrolling keys and its mouse selection and clicks. */
  readonly transcript: boolean;
  /** The footer's job strip: its clicks. */
  readonly footer: boolean;
}

/** One allocation: the whole geometry and visibility of the frame, decided once. */
export interface ChatFrameAllocation {
  readonly surface: ChatSurface;
  /** The terminal height the frame was allocated for. */
  readonly height: number;
  /** The rows the frame may use: one fewer than the height, and the whole height at H = 1. */
  readonly usable: number;
  /** Every row the frame uses — the sum of its regions. */
  readonly rows: number;
  readonly regions: ChatFrameRegions;
  readonly targets: ChatFrameTargets;
}

/** What a surface measures: the rows it cannot be drawn in fewer of, and the rows it wants. */
export interface SurfaceSize {
  readonly minimum: number;
  readonly desired: number;
}

export interface ChatFrameOptions {
  /** The terminal's height in rows, as the screen reads it (fallbacks already applied or not). */
  readonly rows: number;
  /**
   * The input measured with the draft on screen. It is used when the input is the visible
   * surface; an ask card or a picker replaces it and is measured in its own options.
   */
  readonly input: SurfaceSize;
  /** The ask card measured at this width, its answer box included. */
  readonly ask?: SurfaceSize;
  /** The picker measured at this width and filtered list. */
  readonly picker?: SurfaceSize;
  /** The rows the menu under the input would draw: the slash menu's or the mention list's. */
  readonly menus?: number;
  /**
   * The rows the pending previews want — `pendingPreviewLines`' own length. Never more than
   * `MAX_PENDING_PREVIEW_ROWS` are allocated, and an overlay gets none of them.
   */
  readonly previews?: number;
  /** True while the live working line is drawn: it claims its row and its two pads. */
  readonly working?: boolean;
  /** True while the screen is closing: no surface accepts a key, and the viewport is inactive. */
  readonly locked?: boolean;
}

/** The optional regions' row counts, as the frame wants them and as it fits them. */
interface OptionalRows {
  headerTitle: number;
  headerPath: number;
  headerRule: number;
  transcript: number;
  gaps: number;
  previews: number;
  menus: number;
  surface: number;
}

/** The surface the frame will draw, and the measurement that sizes it. */
interface VisibleSurface {
  readonly kind: ChatSurface;
  readonly size: SurfaceSize;
}

/** Everything a fitted interactive frame needs to become its regions and targets. */
interface FittedFrame extends VisibleSurface {
  readonly height: number;
  readonly usable: number;
  readonly rows: OptionalRows;
  readonly working: boolean;
  readonly locked: boolean;
}

/** No target at all: what a diagnostic frame, and only a diagnostic frame, reports. */
const NO_TARGETS: ChatFrameTargets = {
  ask: false,
  picker: false,
  input: false,
  menus: false,
  transcript: false,
  footer: false,
};

/** A row count from a measurement: a whole number of rows, never negative. */
function rowCount(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows)) return NO_ROWS;
  return Math.max(NO_ROWS, Math.floor(rows));
}

/** The height the frame is allocated for, falling back to the assumed one when none is given. */
function frameHeight(height: number): number {
  if (!Number.isFinite(height) || height <= NO_ROWS) return FALLBACK_ROWS;
  return Math.floor(height);
}

/**
 * The rows a frame may use at a terminal height: one row of slack at H >= 2, so the terminal
 * never scrolls on the frame's last row, and the whole height at H = 1 — there is no row to
 * leave free there, and the diagnostic needs its own.
 */
export function usableFrameRows(height: number): number {
  const rows = frameHeight(height);
  return rows <= DIAGNOSTIC_ROWS ? DIAGNOSTIC_ROWS : rows - FRAME_SLACK_ROWS;
}

/** The surface that owns the bottom region, by precedence: an ask card, a picker, the input. */
function visibleSurface(options: ChatFrameOptions): VisibleSurface {
  if (options.ask !== undefined) return { kind: "ask", size: options.ask };
  if (options.picker !== undefined) return { kind: "picker", size: options.picker };
  return { kind: "input", size: options.input };
}

/** Whether a surface other than the input owns the bottom region, taking previews and menus. */
function isOverlay(surface: VisibleSurface): boolean {
  return surface.kind !== "input";
}

/**
 * Every optional region at the size the frame would like it: the full three-row header, one
 * transcript row, the working pads while a turn runs, the shared preview budget, the menu's
 * rows, and the surface's rows above its own minimum.
 */
function desiredOptional(options: ChatFrameOptions, surface: VisibleSurface): OptionalRows {
  const working = options.working === true;
  return {
    headerTitle: HEADER_TITLE_ROWS,
    headerPath: HEADER_PATH_ROWS,
    headerRule: HEADER_RULE_ROWS,
    transcript: TRANSCRIPT_ROWS,
    gaps: working ? STATUS_GAP_ROWS * 2 : NO_ROWS,
    previews: isOverlay(surface) ? NO_ROWS : Math.min(rowCount(options.previews), MAX_PENDING_PREVIEW_ROWS),
    menus: isOverlay(surface) ? NO_ROWS : rowCount(options.menus),
    surface: Math.max(NO_ROWS, rowCount(surface.size.desired) - rowCount(surface.size.minimum)),
  };
}

/** Every optional row the frame asked for, added up. */
function totalOptional(rows: OptionalRows): number {
  return (
    rows.headerTitle +
    rows.headerPath +
    rows.headerRule +
    rows.transcript +
    rows.gaps +
    rows.previews +
    rows.menus +
    rows.surface
  );
}

/** Take up to `over` rows away from one yielding region, returning what is still over. */
function shed(rows: OptionalRows, region: "previews" | "menus" | "surface", over: number): number {
  if (over <= NO_ROWS) return over;
  const cut = Math.min(rows[region], over);
  rows[region] -= cut;
  return over - cut;
}

/**
 * The optional regions fitted to what the terminal has left, shed in the specification's one
 * order: the working gaps as a pair, then the previews down to nothing, then the menu's rows,
 * then the surface's rows beyond its framed minimum, then the header's path line and rule
 * together, then the header's title, and last the one reserved transcript row. Anything still
 * unspent goes to the transcript, which is the region that reads best bigger.
 */
function reduceOptional(desired: OptionalRows, excess: number): OptionalRows {
  const rows: OptionalRows = { ...desired };
  let over = excess;
  // (1) The pads around the working line yield first, and only ever both at once.
  if (over > NO_ROWS) {
    over -= rows.gaps;
    rows.gaps = NO_ROWS;
  }
  // (2) Previews have no guaranteed minimum; (3) menus keep their keys only while they have rows.
  over = shed(rows, "previews", over);
  over = shed(rows, "menus", over);
  // (4) The surface gives up its rows down to the minimum it cannot be used without.
  over = shed(rows, "surface", over);
  // (5) The header's path line and its rule go together, (6) then the title on its own.
  if (over > NO_ROWS) {
    over -= rows.headerPath + rows.headerRule;
    rows.headerPath = NO_ROWS;
    rows.headerRule = NO_ROWS;
  }
  if (over > NO_ROWS) {
    over -= rows.headerTitle;
    rows.headerTitle = NO_ROWS;
  }
  // (7) The reserved transcript row is the last thing to go.
  if (over > NO_ROWS) {
    over -= rows.transcript;
    rows.transcript = NO_ROWS;
  }
  return { ...rows, transcript: rows.transcript + Math.max(NO_ROWS, -over) };
}

/**
 * The regions as the screen draws them, each with the top the region before it ended at. The
 * object literal below is evaluated in source order, which is what makes the running top the
 * cumulative rows of everything drawn before it.
 */
function stackRegions(counts: Readonly<Record<FrameRegionName, number>>): ChatFrameRegions {
  let top = NO_ROWS;
  const place = (rows: number): FrameRegion => {
    const region = { rows, top };
    top += rows;
    return region;
  };
  return {
    headerTitle: place(counts.headerTitle),
    headerPath: place(counts.headerPath),
    headerRule: place(counts.headerRule),
    transcript: place(counts.transcript),
    statusGapBefore: place(counts.statusGapBefore),
    status: place(counts.status),
    statusGapAfter: place(counts.statusGapAfter),
    previews: place(counts.previews),
    surface: place(counts.surface),
    menus: place(counts.menus),
    diagnostic: place(counts.diagnostic),
    footer: place(counts.footer),
  };
}

/** Everything a frame has drawn, added up — the footer is the last region drawn. */
function stackedRows(regions: ChatFrameRegions): number {
  return regions.footer.top + regions.footer.rows;
}

/**
 * Which targets a fitted frame leaves live. A surface owns its keys only while it is the one
 * drawn and the screen is not closing; the menu owns navigation only while it has rows; the
 * viewport keeps its keys and clicks unless a picker is scrolling for it; and the footer's job
 * strip is clickable only while nothing else owns the bottom of the screen.
 */
function targetsFor(fitted: FittedFrame, drawn: ChatFrameRegions): ChatFrameTargets {
  const unlocked = !fitted.locked;
  const inputSurface = fitted.kind === "input";
  return {
    ask: unlocked && fitted.kind === "ask",
    picker: unlocked && fitted.kind === "picker",
    input: unlocked && inputSurface,
    menus: unlocked && inputSurface && drawn.menus.rows > NO_ROWS,
    transcript: unlocked && fitted.kind !== "picker" && drawn.transcript.rows > NO_ROWS,
    footer: inputSurface && drawn.menus.rows === NO_ROWS && drawn.footer.rows > NO_ROWS,
  };
}

/** The interactive frame: every region it fitted, and the targets those rows leave live. */
function interactiveFrame(fitted: FittedFrame): ChatFrameAllocation {
  const gaps = fitted.rows.gaps;
  const regions = stackRegions({
    headerTitle: fitted.rows.headerTitle,
    headerPath: fitted.rows.headerPath,
    headerRule: fitted.rows.headerRule,
    transcript: fitted.rows.transcript,
    statusGapBefore: gaps > NO_ROWS ? STATUS_GAP_ROWS : NO_ROWS,
    status: fitted.working ? STATUS_ROWS : NO_ROWS,
    statusGapAfter: gaps > NO_ROWS ? gaps - STATUS_GAP_ROWS : NO_ROWS,
    previews: fitted.rows.previews,
    surface: rowCount(fitted.size.minimum) + fitted.rows.surface,
    menus: fitted.rows.menus,
    diagnostic: NO_ROWS,
    footer: FOOTER_ROWS,
  });
  return {
    surface: fitted.kind,
    height: fitted.height,
    usable: fitted.usable,
    rows: stackedRows(regions),
    regions,
    targets: targetsFor(fitted, regions),
  };
}

/** The fallback frame: one clipped diagnostic row, and nothing that accepts a key or a click. */
function diagnosticFrame(height: number, usable: number): ChatFrameAllocation {
  const regions = stackRegions({
    headerTitle: NO_ROWS,
    headerPath: NO_ROWS,
    headerRule: NO_ROWS,
    transcript: NO_ROWS,
    statusGapBefore: NO_ROWS,
    status: NO_ROWS,
    statusGapAfter: NO_ROWS,
    previews: NO_ROWS,
    surface: NO_ROWS,
    menus: NO_ROWS,
    diagnostic: Math.min(DIAGNOSTIC_ROWS, usable),
    footer: NO_ROWS,
  });
  return { surface: "diagnostic", height, usable, rows: stackedRows(regions), regions, targets: NO_TARGETS };
}

/**
 * Allocate the frame for a terminal height. The visible surface is resolved first — an ask
 * card outranks a picker, which outranks the input — because it decides both the essential set
 * and whether the previews and the menu have any share at all. If the essential set does not
 * fit, the whole frame becomes the diagnostic; otherwise every other region is fitted in the
 * specification's shedding order and the leftover rows go to the transcript.
 */
export function allocateChatFrame(options: ChatFrameOptions): ChatFrameAllocation {
  const height = frameHeight(options.rows);
  const usable = usableFrameRows(height);
  const surface = visibleSurface(options);
  const working = options.working === true;
  const essential = rowCount(surface.size.minimum) + FOOTER_ROWS + (working ? STATUS_ROWS : NO_ROWS);
  if (essential > usable) return diagnosticFrame(height, usable);
  const desired = desiredOptional(options, surface);
  const rows = reduceOptional(desired, essential + totalOptional(desired) - usable);
  return interactiveFrame({ ...surface, height, usable, rows, working, locked: options.locked === true });
}

/**
 * The chat frame's allocator: how a terminal's rows are shared between the header, the
 * transcript, the live working line and its two gaps, the combined pending previews, the
 * surface that owns the bottom region, the menu under it and the footer — and where each of
 * them starts.
 *
 * Every case here is pure: the same options give the same allocation, and the allocation is
 * the whole geometry. The tables are the specification's degradation order written out one
 * boundary at a time, so a change that reorders the yielding regions fails on the row it
 * moved rather than only at the bottom line.
 */
import { describe, expect, test } from "bun:test";
import {
  allocateChatFrame,
  type ChatFrameAllocation,
  type ChatFrameOptions,
  FRAME_REGION_ORDER,
  TERMINAL_TOO_SMALL,
  usableFrameRows,
} from "@/tui/chat/frame-layout";
import { pendingPreviewLines, type SteeringRow } from "@/tui/chat/message-queue";

/** The fewest rows the input is ever drawn in: two rules and one text row. */
const INPUT_MINIMUM = 3;
/** A frame drawing a single pending item: nothing left to hide behind a summary row. */
const ONE_PENDING = 1;
/** The columns every projection in these cases is drawn into. */
const COLUMNS = 80;
/** The heights every bound is checked at. */
const HEIGHTS = [2, 3, 4, 5, 8, 9, 10, 12, 24, 40] as const;

/** The input measured with an empty, short draft. */
const SHORT_INPUT = { minimum: INPUT_MINIMUM, desired: INPUT_MINIMUM };

/** A frame of `rows` rows whose input is the shortest one, plus whatever the case sets. */
function frame(rows: number, overrides: Partial<ChatFrameOptions> = {}): ChatFrameOptions {
  return { rows, input: SHORT_INPUT, ...overrides };
}

/** The rows an allocation gave each region, in the order the screen draws them. */
function regionRows(allocation: ChatFrameAllocation): readonly number[] {
  return FRAME_REGION_ORDER.map((name) => allocation.regions[name].rows);
}

/** Every row an allocation handed out, added up. */
function usedRows(allocation: ChatFrameAllocation): number {
  return regionRows(allocation).reduce((sum, rows) => sum + rows, 0);
}

/** The rows the header claims, all three of its parts together. */
function headerRows(allocation: ChatFrameAllocation): number {
  return allocation.regions.headerTitle.rows + allocation.regions.headerPath.rows + allocation.regions.headerRule.rows;
}

/** The rows the working line's padding claims, both sides together. */
function gapRows(allocation: ChatFrameAllocation): number {
  return allocation.regions.statusGapBefore.rows + allocation.regions.statusGapAfter.rows;
}

/** `count` pending steers, each naming its own arrival position. */
function steersOf(count: number): readonly SteeringRow[] {
  return Array.from({ length: count }, (_unused, index) => ({ steerId: `s${index + 1}`, text: `s${index + 1}` }));
}

/** The rows a pending projection draws for `count` queued messages at `budget` rows. */
function queuedPreviews(count: number, budget?: number): number {
  const queued = Array.from({ length: count }, (_unused, index) => `q${index + 1}`);
  return pendingPreviewLines({ queued, columns: COLUMNS, ...(budget === undefined ? {} : { budget }) }).length;
}

/** One surface the frame can be allocated for, and the options that put it there. */
interface SurfaceCase {
  readonly name: string;
  readonly frame: (rows: number) => ChatFrameOptions;
}

/** The surface matrix: every surface, every draft and pending shape, at every height. */
const SURFACES: readonly SurfaceCase[] = [
  { name: "idle with a short draft", frame: (rows) => frame(rows) },
  {
    name: "busy with a long draft",
    frame: (rows) => frame(rows, { input: { minimum: INPUT_MINIMUM, desired: 11 }, working: true }),
  },
  { name: "queue-only pending items", frame: (rows) => frame(rows, { previews: queuedPreviews(5) }) },
  { name: "steer-only pending items", frame: (rows) => frame(rows, { previews: queuedPreviews(17) }) },
  {
    name: "mixed pending items",
    frame: (rows) =>
      frame(rows, {
        previews: pendingPreviewLines({ steering: steersOf(3), queued: ["q1", "q2"], columns: COLUMNS }).length,
        working: true,
      }),
  },
  { name: "a menu under the input", frame: (rows) => frame(rows, { input: { minimum: 3, desired: 5 }, menus: 8 }) },
  { name: "an ask card", frame: (rows) => frame(rows, { ask: { minimum: 8, desired: 15 } }) },
  { name: "a picker", frame: (rows) => frame(rows, { picker: { minimum: 4, desired: 12 } }) },
  {
    name: "an ask card over a picker",
    frame: (rows) => frame(rows, { ask: { minimum: 8, desired: 15 }, picker: { minimum: 4, desired: 12 } }),
  },
];

describe("allocateChatFrame — bounds", () => {
  test("AC-1 uses no more than the rows the terminal leaves, across the whole matrix", () => {
    for (const surface of SURFACES) {
      for (const rows of HEIGHTS) {
        const allocation = allocateChatFrame(surface.frame(rows));
        const case_ = { surface: surface.name, rows };
        expect({ ...case_, regions: usedRows(allocation) }).toEqual({ ...case_, regions: allocation.rows });
        expect({ ...case_, fits: allocation.rows <= rows - 1 }).toEqual({ ...case_, fits: true });
      }
    }
  });

  test("AC-2 allocates a whole, nonnegative row count to every region, H=1 included", () => {
    for (const surface of SURFACES) {
      for (const rows of [1, ...HEIGHTS]) {
        const allocation = allocateChatFrame(surface.frame(rows));
        for (const name of FRAME_REGION_ORDER) {
          const region = allocation.regions[name];
          expect({ surface: surface.name, rows, region: name, whole: Number.isInteger(region.rows) }).toEqual({
            surface: surface.name,
            rows,
            region: name,
            whole: true,
          });
          expect({ surface: surface.name, rows, region: name, nonnegative: region.rows >= 0 }).toEqual({
            surface: surface.name,
            rows,
            region: name,
            nonnegative: true,
          });
        }
      }
    }
  });

  test("AC-3 gives every region the rows before it as its top coordinate", () => {
    for (const surface of SURFACES) {
      for (const rows of HEIGHTS) {
        const allocation = allocateChatFrame(surface.frame(rows));
        let top = 0;
        for (const name of FRAME_REGION_ORDER) {
          expect({ surface: surface.name, rows, region: name, top: allocation.regions[name].top }).toEqual({
            surface: surface.name,
            rows,
            region: name,
            top,
          });
          top += allocation.regions[name].rows;
        }
      }
    }
  });
});

describe("allocateChatFrame — surfaces and targets", () => {
  test("usableFrameRows keeps one row of slack, and gives a one-row terminal its only row", () => {
    expect([usableFrameRows(24), usableFrameRows(2), usableFrameRows(1)]).toEqual([23, 1, 1]);
    // A terminal that reports no height gets the screen's own fallback height, less the slack.
    expect([usableFrameRows(0), usableFrameRows(Number.NaN)]).toEqual([23, 23]);
  });

  test("AC-4 leaves every target inactive in a diagnostic frame", () => {
    const allocation = allocateChatFrame(frame(8, { ask: { minimum: 20, desired: 30 } }));
    expect(allocation.surface).toBe("diagnostic");
    for (const [target, active] of Object.entries(allocation.targets)) {
      expect({ target, active }).toEqual({ target, active: false });
    }
  });

  test("AC-5 at one row tall, draws a single diagnostic row and no target", () => {
    const allocation = allocateChatFrame(frame(1, { previews: ONE_PENDING }));
    expect(allocation.surface).toBe("diagnostic");
    expect(allocation.regions.diagnostic.rows).toBeLessThanOrEqual(1);
    expect(allocation.regions.diagnostic.rows).toBe(1);
    expect(allocation.rows).toBe(1);
    // The one row the caller draws is this text, clipped to the supported width.
    expect(TERMINAL_TOO_SMALL).toBe("Terminal too small — enlarge to continue");
    expect(allocation.targets).toEqual({
      ask: false,
      picker: false,
      input: false,
      menus: false,
      transcript: false,
      footer: false,
    });
  });

  test("AC-7 an ask or a picker gives the input's menus and previews no rows at all", () => {
    const card = allocateChatFrame(frame(24, { ask: { minimum: 8, desired: 15 }, menus: 8, previews: 4 }));
    expect({ menus: card.regions.menus.rows, previews: card.regions.previews.rows }).toEqual({
      menus: 0,
      previews: 0,
    });
    const list = allocateChatFrame(frame(24, { picker: { minimum: 4, desired: 12 }, menus: 8, previews: 4 }));
    expect({ menus: list.regions.menus.rows, previews: list.regions.previews.rows }).toEqual({
      menus: 0,
      previews: 0,
    });
  });

  test("AC-8 with both an ask and a picker present, the ask card owns the surface", () => {
    const allocation = allocateChatFrame(
      frame(24, { ask: { minimum: 8, desired: 15 }, picker: { minimum: 4, desired: 12 } }),
    );
    expect(allocation.surface).toBe("ask");
    expect(allocation.targets.ask).toBe(true);
    expect(allocation.targets.picker).toBe(false);
  });

  test("AC-9 replaces an unfittable essential set with the diagnostic", () => {
    // Three input rows, the footer and the live status row need five; four are usable at H=5.
    expect(allocateChatFrame(frame(5, { working: true })).surface).toBe("diagnostic");
    // The same frame without a live status row fits in those four rows.
    expect(allocateChatFrame(frame(5)).surface).toBe("input");
    // An overlay's own minimum counts the same way: a nine-row card needs a ten-row terminal.
    expect(allocateChatFrame(frame(9, { ask: { minimum: 8, desired: 15 } })).surface).toBe("diagnostic");
    expect(allocateChatFrame(frame(10, { ask: { minimum: 8, desired: 15 } })).surface).toBe("ask");
  });

  test("targets follow the visible surface, its rows and the lock", () => {
    // The input owns its keys, its open menu owns navigation, and the menu blocks the job strip.
    expect(allocateChatFrame(frame(24, { menus: 3 })).targets).toEqual({
      ask: false,
      picker: false,
      input: true,
      menus: true,
      transcript: true,
      footer: false,
    });
    // With no menu drawn the menu target is inactive and the footer's strip is clickable again.
    expect(allocateChatFrame(frame(24)).targets).toEqual({
      ask: false,
      picker: false,
      input: true,
      menus: false,
      transcript: true,
      footer: true,
    });
    // A card blocks the footer's job strip and replaces the input; the transcript keeps its keys.
    expect(allocateChatFrame(frame(24, { ask: { minimum: 8, desired: 15 }, menus: 8 })).targets).toEqual({
      ask: true,
      picker: false,
      input: false,
      menus: false,
      transcript: true,
      footer: false,
    });
    // A picker scrolls the transcript for the user, so the viewport owns neither keys nor clicks.
    expect(allocateChatFrame(frame(24, { picker: { minimum: 4, desired: 12 } })).targets).toEqual({
      ask: false,
      picker: true,
      input: false,
      menus: false,
      transcript: false,
      footer: false,
    });
    // A screen that is closing accepts no key from any surface; the footer's click still lands.
    expect(allocateChatFrame(frame(24, { locked: true })).targets).toEqual({
      ask: false,
      picker: false,
      input: false,
      menus: false,
      transcript: false,
      footer: true,
    });
  });
});

describe("allocateChatFrame — the working line", () => {
  test("AC-10 reserves exactly one status row while a live working line is drawn", () => {
    for (const rows of [24, 12, 8, 6]) {
      const allocation = allocateChatFrame(frame(rows, { working: true }));
      expect({ rows, surface: allocation.surface, status: allocation.regions.status.rows }).toEqual({
        rows,
        surface: "input",
        status: 1,
      });
    }
  });

  test("AC-11 yields the working gaps as a pair, never one side on its own", () => {
    const roomy = allocateChatFrame(frame(24, { working: true }));
    expect([roomy.regions.statusGapBefore.rows, roomy.regions.statusGapAfter.rows]).toEqual([1, 1]);
    // Five usable rows are exactly the essential set, so the gaps go before anything else.
    const tight = allocateChatFrame(frame(6, { working: true }));
    expect(tight.surface).toBe("input");
    expect([tight.regions.statusGapBefore.rows, tight.regions.statusGapAfter.rows]).toEqual([0, 0]);
  });

  test("AC-12 reserves neither the status row nor its gaps while nothing runs", () => {
    const allocation = allocateChatFrame(frame(24, { previews: 4 }));
    expect([
      allocation.regions.status.rows,
      allocation.regions.statusGapBefore.rows,
      allocation.regions.statusGapAfter.rows,
    ]).toEqual([0, 0, 0]);
  });

  test("AC-13 allocates from the desired sizes again once the terminal grows", () => {
    const options = { input: { minimum: INPUT_MINIMUM, desired: 5 }, menus: 3, previews: 4, working: true };
    const squeezed = allocateChatFrame({ ...options, rows: 7 });
    const grown = allocateChatFrame({ ...options, rows: 24 });
    expect({ surface: squeezed.regions.surface.rows, previews: squeezed.regions.previews.rows }).toEqual({
      surface: INPUT_MINIMUM,
      previews: 0,
    });
    expect({ previews: grown.regions.previews.rows, surface: grown.regions.surface.rows }).toEqual({
      previews: 4,
      surface: 5,
    });
    expect({ menus: grown.regions.menus.rows, header: headerRows(grown), gaps: gapRows(grown) }).toEqual({
      menus: 3,
      header: 3,
      gaps: 2,
    });
    // Nothing is carried over: the same options at the same height give the same allocation.
    expect(regionRows(grown)).toEqual(regionRows(allocateChatFrame({ ...options, rows: 24 })));
    expect(grown.rows).toBe(24 - 1);
  });
});

describe("allocateChatFrame — degradation order", () => {
  /**
   * One terminal height, and the rows the frame gives each optional region there. The input
   * wants five rows, the menu three and the previews four, and a turn is running — so every
   * yielding region is present at the top of the table and gone by the bottom.
   */
  const TABLE: readonly {
    readonly rows: number;
    readonly header: number;
    readonly transcript: number;
    readonly gaps: number;
    readonly previews: number;
    readonly surface: number;
    readonly menus: number;
  }[] = [
    { rows: 21, header: 3, transcript: 1, gaps: 2, previews: 4, surface: 5, menus: 3 },
    { rows: 20, header: 3, transcript: 2, gaps: 0, previews: 4, surface: 5, menus: 3 },
    { rows: 19, header: 3, transcript: 1, gaps: 0, previews: 4, surface: 5, menus: 3 },
    { rows: 18, header: 3, transcript: 1, gaps: 0, previews: 3, surface: 5, menus: 3 },
    { rows: 14, header: 3, transcript: 1, gaps: 0, previews: 0, surface: 5, menus: 2 },
    { rows: 13, header: 3, transcript: 1, gaps: 0, previews: 0, surface: 5, menus: 1 },
    { rows: 10, header: 3, transcript: 1, gaps: 0, previews: 0, surface: 3, menus: 0 },
    { rows: 9, header: 1, transcript: 2, gaps: 0, previews: 0, surface: 3, menus: 0 },
    { rows: 8, header: 1, transcript: 1, gaps: 0, previews: 0, surface: 3, menus: 0 },
    { rows: 7, header: 0, transcript: 1, gaps: 0, previews: 0, surface: 3, menus: 0 },
    { rows: 6, header: 0, transcript: 0, gaps: 0, previews: 0, surface: 3, menus: 0 },
  ];

  test("AC-6 sheds gaps, previews, menus, input text, the header and the transcript in that order", () => {
    for (const step of TABLE) {
      const allocation = allocateChatFrame({
        rows: step.rows,
        input: { minimum: INPUT_MINIMUM, desired: 5 },
        menus: 3,
        previews: 4,
        working: true,
      });
      expect({
        rows: step.rows,
        surface: allocation.surface,
        header: headerRows(allocation),
        transcript: allocation.regions.transcript.rows,
        gaps: gapRows(allocation),
        previews: allocation.regions.previews.rows,
        bottom: allocation.regions.surface.rows,
        menus: allocation.regions.menus.rows,
        status: allocation.regions.status.rows,
        used: allocation.rows,
      }).toEqual({
        rows: step.rows,
        surface: "input",
        header: step.header,
        transcript: step.transcript,
        gaps: step.gaps,
        previews: step.previews,
        bottom: step.surface,
        menus: step.menus,
        status: 1,
        used: step.rows - 1,
      });
    }
  });

  test("AC-6 gives the header's path and rule up together, keeping its title last", () => {
    const kept = allocateChatFrame(
      frame(9, { input: { minimum: INPUT_MINIMUM, desired: 5 }, menus: 3, working: true }),
    );
    expect({
      path: kept.regions.headerPath.rows,
      rule: kept.regions.headerRule.rows,
      title: kept.regions.headerTitle.rows,
    }).toEqual({ path: 0, rule: 0, title: 1 });
  });
});

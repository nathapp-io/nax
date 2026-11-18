import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The chat frame is one row shorter than the terminal (FRAME_SLACK_ROWS), so Ink is not in
 * fullscreen mode and ends every frame with a newline. Ink 6.7's incremental log-update
 * moved the cursor up one row too few after such a frame, so every redraw landed one row
 * low (#2717). `patches/ink@6.7.0.patch` carries the fix Ink 8 shipped.
 */

const FIXTURE = join(import.meta.dir, "../../fixtures/ink-incremental/two-frames.mjs");
const REPAINT_FIXTURE = join(import.meta.dir, "../../fixtures/ink-incremental/repaint.mjs");
const FRAME_ROWS = 5;
/** The three rows the repaint fixture draws, in order. */
const REPAINT_ROWS = ["alpha", "bravo", "charlie"];

interface Frames {
  readonly first: readonly string[];
  readonly redraw: readonly string[];
}

interface Repaint {
  readonly first: readonly string[];
  readonly repaint: readonly string[];
  readonly unmount: readonly string[];
  readonly afterUnmount: readonly string[];
}

/** Ink reads `is-in-ci` at import, so the writes come from a process with CI switched off. */
async function runFixture(fixture: string): Promise<unknown> {
  const proc = Bun.spawn([process.execPath, fixture], {
    env: { ...process.env, CI: "0", CONTINUOUS_INTEGRATION: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`fixture ${fixture} exited ${code}: ${err}`);
  return JSON.parse(out);
}

/** The fixture's JSON, narrowed: four arrays of the strings Ink wrote. */
function repaintOf(raw: unknown): Repaint {
  if (typeof raw !== "object" || raw === null) throw new Error(`fixture printed no frames: ${JSON.stringify(raw)}`);
  return {
    first: textRows(raw, "first"),
    repaint: textRows(raw, "repaint"),
    unmount: textRows(raw, "unmount"),
    afterUnmount: textRows(raw, "afterUnmount"),
  };
}

/** One named array of the fixture's JSON, or a failure that names what it printed instead. */
function textRows(raw: object, key: string): readonly string[] {
  const value: unknown = Reflect.get(raw, key);
  if (!Array.isArray(value)) throw new Error(`fixture ${key} is not an array: ${JSON.stringify(raw)}`);
  return value.map(String);
}

/** The fixture's JSON, narrowed: two arrays of the strings Ink wrote. */
function framesOf(raw: unknown): Frames {
  if (typeof raw !== "object" || raw === null || !("first" in raw) || !("redraw" in raw)) {
    throw new Error(`fixture printed no frames: ${JSON.stringify(raw)}`);
  }
  const { first, redraw } = raw;
  if (!Array.isArray(first) || !Array.isArray(redraw)) throw new Error("fixture frames are not arrays");
  return { first: first.map(String), redraw: redraw.map(String) };
}

async function renderRepaint(): Promise<Repaint> {
  return repaintOf(await runFixture(REPAINT_FIXTURE));
}

describe("ink incremental rendering under a rows - 1 frame", () => {
  test("a redraw moves back to the frame's first row and rewrites only the changed row", async () => {
    const { first, redraw } = framesOf(await runFixture(FIXTURE));
    const drawn = redraw.join("");

    expect(first.join("")).toContain("header");
    // The frame is FRAME_ROWS lines plus a trailing newline: the cursor sits FRAME_ROWS rows
    // below the frame's first row, so the redraw climbs exactly that far.
    expect(drawn).toContain(`\u001b[${FRAME_ROWS}A`);
    expect(drawn).not.toContain(`\u001b[${FRAME_ROWS - 1}A`);
    expect(drawn).toContain("after");
    expect(drawn).not.toContain("header");
  });
});

describe("ink instance repaint", () => {
  test("AC-19: a repaint writes every row of the unchanged frame again", async () => {
    const { first, repaint } = await renderRepaint();
    const drawn = repaint.join("");

    expect(first.join("")).toContain(REPAINT_ROWS[0] as string);
    // Nothing changed in the component, so a plain rerender would write no row at all.
    for (const row of REPAINT_ROWS) expect(drawn).toContain(row);
  });

  test("AC-20: a repaint after unmount writes no bytes", async () => {
    const { unmount, afterUnmount } = await renderRepaint();
    expect(unmount.length).toBeGreaterThan(0);
    expect(afterUnmount.join("")).toBe("");
  });
});

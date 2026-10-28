import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The chat frame is one row shorter than the terminal (FRAME_SLACK_ROWS), so Ink is not in
 * fullscreen mode and ends every frame with a newline. Ink 6.7's incremental log-update
 * moved the cursor up one row too few after such a frame, so every redraw landed one row
 * low (#2717). `patches/ink@6.7.0.patch` carries the fix Ink 8 shipped.
 */

const FIXTURE = join(import.meta.dir, "../../fixtures/ink-incremental/two-frames.mjs");
const FRAME_ROWS = 5;

interface Frames {
  readonly first: readonly string[];
  readonly redraw: readonly string[];
}

/** Ink reads `is-in-ci` at import, so the frames come from a process with CI switched off. */
async function renderTwoFrames(): Promise<Frames> {
  const proc = Bun.spawn([process.execPath, FIXTURE], {
    env: { ...process.env, CI: "0", CONTINUOUS_INTEGRATION: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return framesOf(JSON.parse(out));
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

describe("ink incremental rendering under a rows - 1 frame", () => {
  test("a redraw moves back to the frame's first row and rewrites only the changed row", async () => {
    const { first, redraw } = await renderTwoFrames();
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

/**
 * US-001 — ScratchpadRead / ScratchpadWrite accept a path spelled with the
 * confined prefix they are confined to (AC9, AC11, AC12) and still refuse an
 * escape (AC13).
 *
 * The truncation marker now names `.nax/scratchpad/spill/<Tool>-<callId>.txt`,
 * which is the path *from the directory the session starts in* — not the path
 * `ScratchpadRead` used to require, which was relative to the scratchpad
 * itself. A marker the session cannot open is worse than no marker: the run
 * that motivated this story ended with the agent running `find / -name ...`
 * and burning the full 300 s Bash timeout.
 *
 * So `ScratchpadRead` must accept BOTH spellings — `.nax/scratchpad/spill/x.txt`
 * (what the marker names, and what Read accepts) and `spill/x.txt` (what every
 * existing caller passes) — and both must reach the same file. `ScratchpadWrite`
 * must accept the prefixed spelling without doubling the prefix on disk
 * (`<root>/.nax/scratchpad/.nax/scratchpad/notes.md` is the defect AC12 pins).
 *
 * Everything below is asserted through `createCodingToolRuntime`, so the
 * policy and the tool are exercised together — the acceptance is a path that
 * RESOLVES, and a path only resolves if both agree. Containment is the
 * boundary the last describe pins: accepting a prefix must not become a way
 * out of the confined directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { CodingToolRuntime } from "@/tools";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";

/** The scratchpad file both spellings must reach. */
const SPILL_BODY = "spill-body-line\nsecond-line";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-scratchpad-prefix-");
  const spillDir = join(root, ".nax", "scratchpad", "spill");
  mkdirSync(spillDir, { recursive: true });
  writeFileSync(join(spillDir, "x.txt"), SPILL_BODY);
});

afterEach(() => {
  cleanupTempDir(root);
});

/** The runtime the story's ACs run through: the real scratchpad tools. */
function runtime(): CodingToolRuntime {
  return createCodingToolRuntime({
    policy: compileToolPolicy(
      ["ScratchpadWrite", "ScratchpadRead", "ScratchpadList"].map((tool) => ({ tool, patterns: ["*"] })),
      root,
    ),
  });
}

// -----------------------------------------------------------------------------
// AC9 — ScratchpadRead with `.nax/scratchpad/spill/x.txt` returns the content
//       of `<root>/.nax/scratchpad/spill/x.txt`.
// -----------------------------------------------------------------------------

describe("US-001 AC9: ScratchpadRead accepts the scratchpad-prefixed spelling the marker names", () => {
  test("US-001 AC9: reading '.nax/scratchpad/spill/x.txt' returns the file's content", async () => {
    const out = await runtime().callTool("ScratchpadRead", { path: ".nax/scratchpad/spill/x.txt" });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    expect(out.content).toBe(`[2 lines]\n${SPILL_BODY}`);
  });

  test("US-001 AC9 boundary: the prefixed spelling of a MISSING file is a read error naming the path, not a denial", async () => {
    // The prefix is accepted, so the read really is attempted: the model sees
    // a missing-file error it can act on rather than a containment refusal it
    // would have to work around.
    const out = await runtime().callTool("ScratchpadRead", { path: ".nax/scratchpad/spill/absent.txt" });
    expect(out.kind).toBe("error");
    if (out.kind !== "error") throw new Error("unreachable");
    expect(out.content).toContain(".nax/scratchpad/spill/absent.txt");
  });

  test("US-001 AC13 (runtime companion): a prefixed climb onto an ordinary file outside the scratchpad is denied", async () => {
    // The same prefix handling, at the same seam, does not widen containment:
    // the stripped remainder is resolved INSIDE the confined directory, so the
    // climb lands outside it and the call is refused before any read happens.
    // `.nax/scratchpad/../notes.md` is chosen over the AC's `../config.json`
    // because only the ordinary file discriminates — `config.json` is refused
    // by the nax-config rule whatever the prefix handling does.
    const out = await runtime().callTool("ScratchpadRead", { path: ".nax/scratchpad/../notes.md" });
    expect(out.kind).toBe("denied");
    if (out.kind !== "denied") throw new Error("unreachable");
    expect(out.breach).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// AC11 — ScratchpadRead with `spill/x.txt` still returns the content of
//        `<root>/.nax/scratchpad/spill/x.txt`.
// -----------------------------------------------------------------------------

describe("US-001 AC11: the unprefixed spelling still resolves to the same file", () => {
  test("US-001 AC11: reading 'spill/x.txt' returns the content of <root>/.nax/scratchpad/spill/x.txt", async () => {
    const out = await runtime().callTool("ScratchpadRead", { path: "spill/x.txt" });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    expect(out.content).toBe(`[2 lines]\n${SPILL_BODY}`);
  });

  test("US-001 AC11 boundary: both spellings return byte-identical content — one file, two spellings", async () => {
    const rt = runtime();
    const prefixed = await rt.callTool("ScratchpadRead", { path: ".nax/scratchpad/spill/x.txt" });
    const bare = await rt.callTool("ScratchpadRead", { path: "spill/x.txt" });
    expect(prefixed.kind).toBe("ok");
    expect(bare.kind).toBe("ok");
    if (prefixed.kind !== "ok" || bare.kind !== "ok") throw new Error("unreachable");
    // If the prefix were kept rather than stripped, the first read would
    // resolve to `<root>/.nax/scratchpad/.nax/scratchpad/spill/x.txt` and
    // fail — the two results could not agree.
    expect(prefixed.content).toBe(bare.content);
  });
});

// -----------------------------------------------------------------------------
// AC12 — ScratchpadWrite with `.nax/scratchpad/notes.md` writes
//        `<root>/.nax/scratchpad/notes.md` and creates no file at
//        `<root>/.nax/scratchpad/.nax/scratchpad/notes.md`.
// -----------------------------------------------------------------------------

describe("US-001 AC12: ScratchpadWrite does not double the prefix on disk", () => {
  test("US-001 AC12: writing '.nax/scratchpad/notes.md' writes <root>/.nax/scratchpad/notes.md only", async () => {
    const out = await runtime().callTool("ScratchpadWrite", {
      path: ".nax/scratchpad/notes.md",
      content: "note",
    });
    expect(out.kind).toBe("ok");

    const flat = join(root, ".nax", "scratchpad", "notes.md");
    const doubled = join(root, ".nax", "scratchpad", ".nax", "scratchpad", "notes.md");
    expect(existsSync(flat)).toBe(true);
    expect(existsSync(doubled)).toBe(false);
    expect(readFileSync(flat, "utf8")).toBe("note");
  });

  test("US-001 AC12 boundary: the unprefixed spelling still writes under the scratchpad", async () => {
    const out = await runtime().callTool("ScratchpadWrite", { path: "spill/notes.md", content: "note" });
    expect(out.kind).toBe("ok");

    const flat = join(root, ".nax", "scratchpad", "spill", "notes.md");
    const doubled = join(root, ".nax", "scratchpad", "spill", "spill", "notes.md");
    expect(existsSync(flat)).toBe(true);
    expect(existsSync(doubled)).toBe(false);
  });
});

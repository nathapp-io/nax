/**
 * US-001 — the spill marker names a path the session can open (AC1-AC6).
 *
 * The marker that a truncated tool result carries is the only thing that tells
 * the model where the untruncated body went. Before this story it named
 * `spill/<Tool>-<callId>.txt`, a path *relative to the scratchpad*: a
 * test-writer that ran `cat "spill/Bash-call_00_x.txt"` from the repo root
 * failed, then ran `find / -name ...`, which burned the whole 300 s Bash
 * timeout. The widest marker shape now names a path the session's own tools
 * and shell can actually open —
 * `.nax/scratchpad/spill/<Tool>-<callId>.txt` (root-relative) or its absolute
 * form — while the two narrower fallback shapes are unchanged.
 *
 * Each AC below is pinned at the one seam that decides the marker:
 * `applyModelTruncationPolicy` in `src/tools/spill.ts`. The two invariants
 * worth spelling out, because they are what make the marker trustworthy:
 *
 *  - the path may only appear when the write actually SUCCEEDED (AC5), and
 *  - the marker lives inside the byte budget rather than being appended past
 *    it (AC6), so a marker that names a path can never push the result over
 *    the model-facing cap.
 *
 * Everything is asserted on observable output: the composed marker string, the
 * bytes of the spill file on disk, and the result's byte length. No private
 * helper is touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { _spillDeps, applyModelTruncationPolicy, READ_CEILING } from "#src/tools/index";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let root: string;
/** Original `_spillDeps`, restored after every test that overrides them. */
const realSpillDeps = { mkdir: _spillDeps.mkdir, writeFile: _spillDeps.writeFile };

/** The model-facing byte ceiling these tests shape against. */
const MAX_BYTES = 4_096;

beforeEach(() => {
  root = makeTempDir("nax-spill-marker-");
});

afterEach(() => {
  _spillDeps.mkdir = realSpillDeps.mkdir;
  _spillDeps.writeFile = realSpillDeps.writeFile;
  cleanupTempDir(root);
});

/** A body that is `over` bytes past the cap, in a shape the head direction keeps. */
function headBody(over = 100): string {
  return `head-line\n${"x".repeat(MAX_BYTES + over)}`;
}

/** The one line of a composed result that carries the truncation marker. */
function markerLineOf(content: string): string {
  return content.split("\n").find((line) => line.includes("[truncated")) ?? "";
}

/** The path the marker names, or "" when it names none. */
function namedPath(content: string): string {
  const match = /full output at (\S+)/.exec(markerLineOf(content));
  return match?.[1] ?? "";
}

// -----------------------------------------------------------------------------
// AC1 — a Read-tool body over maxBytes ends with the widest marker naming
//       .nax/scratchpad/spill/Read-<callId>.txt, the delivered and the
//       original byte count.
// -----------------------------------------------------------------------------

describe("AC1: a truncated Read result ends with the widest marker naming the root-relative spill path", () => {
  test("US-001 AC1: the last line names .nax/scratchpad/spill/Read-<callId>.txt and both byte counts", async () => {
    const body = headBody();
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c1",
      root,
      maxBytes: MAX_BYTES,
    });

    const lines = content.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    // N is the body text the model can read back: everything before the line
    // that carries the marker.
    const delivered = Buffer.byteLength(content.slice(0, content.lastIndexOf("\n")), "utf8");
    expect(lastLine).toBe(
      `... [truncated: full output at .nax/scratchpad/spill/Read-c1.txt (open with Read or ScratchpadRead); showing ${delivered} of ${Buffer.byteLength(body, "utf8")} bytes]`,
    );
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  // AC1 says N is the DELIVERED count and M the ORIGINAL count of the BODY —
  // bytes, not characters. The fixture above is ASCII, so a regression that
  // reported `String#length` would pass it unchanged; this one is multibyte,
  // where the two numbers differ by a factor of two.
  test("US-001 AC1 boundary: N and M are UTF-8 byte counts, not character counts", async () => {
    const body = `héllo\n${"é".repeat(MAX_BYTES)}`;
    // The fixture discriminates only while char count and byte count differ.
    expect(body.length).toBeLessThan(Buffer.byteLength(body, "utf8"));

    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c1u",
      root,
      maxBytes: MAX_BYTES,
    });

    const lastLine = content.split("\n").pop() ?? "";
    const head = content.slice(0, content.lastIndexOf("\n"));
    const delivered = Buffer.byteLength(head, "utf8");
    // Guard the discriminator: the retained head really is multibyte, so a
    // character count could not coincide with the byte count.
    expect(head.length).toBeLessThan(delivered);
    expect(lastLine).toBe(
      `... [truncated: full output at .nax/scratchpad/spill/Read-c1u.txt (open with Read or ScratchpadRead); showing ${delivered} of ${Buffer.byteLength(body, "utf8")} bytes]`,
    );
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  test("US-001 AC1 boundary: a Read body within maxBytes is returned unchanged with no marker", async () => {
    const body = "small\nbody";
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c1b",
      root,
      maxBytes: MAX_BYTES,
    });
    expect(content).toBe(body);
    expect(content).not.toContain("[truncated");
  });
});

// -----------------------------------------------------------------------------
// AC2 — a Bash-tool body over maxBytes carries a marker line naming
//       .nax/scratchpad/spill/Bash-<callId>.txt (open with Read or
//       ScratchpadRead).
// -----------------------------------------------------------------------------

describe("AC2: a truncated Bash result carries a marker line naming the root-relative spill path", () => {
  test("US-001 AC2: the content contains a marker line naming .nax/scratchpad/spill/Bash-<callId>.txt (open with Read or ScratchpadRead)", async () => {
    const body = `exit 0\n${"y".repeat(MAX_BYTES)}\nlast-line-of-output`;
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Bash",
      callId: "c2",
      root,
      maxBytes: MAX_BYTES,
    });

    expect(content).toContain(".nax/scratchpad/spill/Bash-c2.txt (open with Read or ScratchpadRead)");
    // The marker really is its own line, not a fragment of a longer one.
    const markerLine = markerLineOf(content);
    expect(markerLine.startsWith("... [truncated: full output at ")).toBe(true);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  test("US-001 AC2 boundary: a Bash body within maxBytes is returned unchanged with no marker", async () => {
    const body = "exit 0\nall good\n";
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Bash",
      callId: "c2b",
      root,
      maxBytes: MAX_BYTES,
    });
    expect(content).toBe(body);
    expect(content).not.toContain("[truncated");
  });
});

// -----------------------------------------------------------------------------
// AC3 — spillPathStyle "absolute" makes the marker name the absolute path
//       <root>/.nax/scratchpad/spill/<Tool>-<callId>.txt.
// -----------------------------------------------------------------------------

describe("AC3: spillPathStyle 'absolute' names the absolute spill path", () => {
  test("US-001 AC3: the marker names <root>/.nax/scratchpad/spill/Read-<callId>.txt", async () => {
    const content = await applyModelTruncationPolicy(headBody(), {
      toolName: "Read",
      callId: "c3",
      root,
      maxBytes: MAX_BYTES,
      spillPathStyle: "absolute",
    });

    const absolute = join(root, ".nax", "scratchpad", "spill", "Read-c3.txt");
    expect(markerLineOf(content)).toContain(absolute);
    expect(markerLineOf(content)).toContain("(open with Read or ScratchpadRead)");
    // The named path is the file the writer really produced.
    expect(existsSync(absolute)).toBe(true);
  });

  test("US-001 AC3 boundary: the default style names the root-relative path, not an absolute one", async () => {
    const content = await applyModelTruncationPolicy(headBody(), {
      toolName: "Read",
      callId: "c3b",
      root,
      maxBytes: MAX_BYTES,
    });
    expect(namedPath(content)).toBe(".nax/scratchpad/spill/Read-c3b.txt");
    // The absolute spelling must NOT leak into the default marker.
    expect(markerLineOf(content)).not.toContain(root);
  });
});

// -----------------------------------------------------------------------------
// AC4 — the file at join(root, <path named by a root-relative marker>) holds
//       the untruncated body that was passed in.
// -----------------------------------------------------------------------------

describe("AC4: join(root, <path named by the marker>) is readable and holds the untruncated body", () => {
  test("US-001 AC4: reading the marker's path yields the full body passed to the policy", async () => {
    const body = headBody();
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c4",
      root,
      maxBytes: MAX_BYTES,
    });

    const named = namedPath(content);
    expect(named).toBe(".nax/scratchpad/spill/Read-c4.txt");
    expect(readFileSync(join(root, named), "utf8")).toBe(body);
  });

  test("US-001 AC4 boundary: a body one byte over maxBytes still spills the complete body", async () => {
    const body = `first\n${"z".repeat(MAX_BYTES)}`;
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c4b",
      root,
      maxBytes: MAX_BYTES,
    });

    const named = namedPath(content);
    expect(named).toBe(".nax/scratchpad/spill/Read-c4b.txt");
    expect(readFileSync(join(root, named), "utf8")).toBe(body);
  });

  // Past READ_CEILING the spill writer caps the file and says so on its last
  // line (spill-recovery.test.ts AC9). The marker must still name that file:
  // dropping the path there leaves the model told "showing N of M bytes" with
  // no way to reach the READ_CEILING bytes nax did write.
  test("US-001 AC4 boundary: a body past READ_CEILING is named by the marker and spilled capped with an incomplete note", async () => {
    const body = `first\n${"y".repeat(READ_CEILING + 5_000)}`;
    const total = Buffer.byteLength(body, "utf8");
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c4c",
      root,
      maxBytes: MAX_BYTES,
    });

    const named = namedPath(content);
    expect(named).toBe(".nax/scratchpad/spill/Read-c4c.txt");
    const spilled = readFileSync(join(root, named), "utf8");
    expect(Buffer.byteLength(spilled, "utf8")).toBeLessThanOrEqual(READ_CEILING);
    const noteAt = spilled.lastIndexOf("\n");
    const kept = spilled.slice(0, noteAt);
    expect(body.startsWith(kept)).toBe(true);
    expect(spilled.slice(noteAt + 1)).toBe(
      `... [spill incomplete: showing ${Buffer.byteLength(kept, "utf8")} of ${total} bytes]`,
    );
  });

  test("US-001 AC4 boundary: a Bash body past READ_CEILING still carries a marker naming its spill path", async () => {
    const body = `${"b".repeat(READ_CEILING + 5_000)}\nlast-line`;
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Bash",
      callId: "c4d",
      root,
      maxBytes: MAX_BYTES,
    });

    expect(namedPath(content)).toBe(".nax/scratchpad/spill/Bash-c4d.txt");
    expect(existsSync(join(root, ".nax/scratchpad/spill/Bash-c4d.txt"))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// AC5 — when the spill write rejects, the marker is the narrow
//       `... [truncated: showing N of M bytes]` shape and names no path.
// -----------------------------------------------------------------------------

describe("AC5: a rejected spill write yields a marker naming no path", () => {
  test("US-001 AC5: with the spill write rejecting, the marker is '... [truncated: showing N of M bytes]'", async () => {
    _spillDeps.mkdir = async () => {
      throw new Error("EACCES: spill mkdir blocked");
    };
    _spillDeps.writeFile = async () => {
      throw new Error("EACCES: spill write blocked");
    };

    const body = headBody();
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c5",
      root,
      maxBytes: MAX_BYTES,
    });

    const lastLine = content.split("\n").pop() ?? "";
    expect(lastLine).toMatch(/^\.\.\. \[truncated: showing \d+ of \d+ bytes\]$/);
    expect(content).not.toContain(".nax/scratchpad/spill/");
    expect(content).not.toContain("spill/Read-c5.txt");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  test("US-001 AC5 boundary: only the write step rejecting (mkdir succeeds) still yields a path-free marker", async () => {
    // AC5 names the WRITE as the step that rejects. A writer whose directory
    // creation succeeds but whose file write fails must take the same
    // fail-open branch — and must not leave the marker naming the file it
    // failed to produce.
    _spillDeps.writeFile = async () => {
      throw new Error("ENOSPC: no space left on device");
    };

    const body = headBody();
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c5d",
      root,
      maxBytes: MAX_BYTES,
    });

    expect(content.split("\n").pop() ?? "").toMatch(/^\.\.\. \[truncated: showing \d+ of \d+ bytes\]$/);
    expect(namedPath(content)).toBe("");
    expect(existsSync(join(root, ".nax", "scratchpad", "spill", "Read-c5d.txt"))).toBe(false);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  // Discriminating companion: the assertion above is satisfied trivially by a
  // regression that never names a path at all. The same body, with the writer
  // working, must name the path.
  test("US-001 AC5 boundary: the same body with a working write DOES name the path", async () => {
    const body = headBody();
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c5b",
      root,
      maxBytes: MAX_BYTES,
    });
    expect(namedPath(content)).toBe(".nax/scratchpad/spill/Read-c5b.txt");
  });

  test("US-001 AC5 boundary: with no root the marker names no path and no file is written", async () => {
    const content = await applyModelTruncationPolicy(headBody(), {
      toolName: "Read",
      callId: "c5c",
      maxBytes: MAX_BYTES,
    });
    expect(namedPath(content)).toBe("");
    expect(content).not.toContain(".nax/scratchpad/spill/");
    expect(existsSync(join(root, ".nax", "scratchpad", "spill"))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// AC6 — when maxBytes is too small for the widest marker shape, the returned
//       content is at most maxBytes.
// -----------------------------------------------------------------------------

describe("AC6: a byte budget too small for the widest marker still yields content within the budget", () => {
  test("US-001 AC6: at a budget the widest shape cannot fit, the content is at most maxBytes and names no path", async () => {
    // 100 bytes fits the OLD wide shape (`... full output at spill/Read-<id>.txt;
    // showing N of M bytes]`) but not the new one, which is ~130 bytes once the
    // `.nax/scratchpad/` prefix and the `(open with Read or ScratchpadRead)`
    // instruction are in it. The narrow shape must therefore be used -- and it
    // must fit.
    const maxBytes = 100;
    const body = "w".repeat(5_000);
    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "c6",
      root,
      maxBytes,
    });

    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(content.split("\n").pop() ?? "").toMatch(/^\.\.\. \[truncated: showing \d+ of \d+ bytes\]$/);
    expect(content).not.toContain(".nax/scratchpad/spill/");
  });

  test("US-001 AC6 boundary: a zero budget yields zero bytes rather than an over-budget marker", async () => {
    const content = await applyModelTruncationPolicy(headBody(), {
      toolName: "Read",
      callId: "c6b",
      root,
      maxBytes: 0,
    });
    expect(Buffer.byteLength(content, "utf8")).toBe(0);
  });

  // The budget AC6 is about is a continuum, and the marker shape chosen
  // changes across it: below ~36 bytes nothing fits, then the path-free
  // narrow shapes, then the widest shape once the path and its instruction
  // fit. Sweeping the boundary is what pins the ceiling as unconditional
  // rather than true only at one convenient size — and it re-checks the
  // marker's trustworthiness at each step: a marker names a path only when
  // the file is really there.
  test.each([0, 16, 48, 100, 140, 200, 400])(
    "US-001 AC6 boundary: at a %d-byte budget the content fits the budget and any named path exists",
    async (budget: number) => {
      const content = await applyModelTruncationPolicy(`a\n${"x".repeat(5_000)}`, {
        toolName: "Read",
        callId: `c6s-${budget}`,
        root,
        maxBytes: budget,
      });

      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(budget);
      const named = namedPath(content);
      if (named !== "") expect(existsSync(join(root, named))).toBe(true);
    },
  );
});

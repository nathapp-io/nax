/**
 * US-001 — the native session's spill marker names a path its tools can open
 * (AC7, AC8).
 *
 * `truncateNativeToolResult` is the native loop's `after_tool` chokepoint. The
 * spill root it hands to the policy decides WHICH spelling the marker uses,
 * and that spelling is the difference between a marker a session can act on
 * and one that sent a test-writer to `find / -name ...` (which burned the full
 * 300 s Bash timeout):
 *
 *  - a session opened through the runtime has a scratchpad root recorded in
 *    `nativeSessionScratchpadRoots` (its workdir). The marker is then
 *    root-relative — `.nax/scratchpad/spill/<Tool>-<callId>.txt` — so it is
 *    openable from the directory the session's tools and shell start in (AC7).
 *  - a session driven without one (unit tests calling `runNativeTurn`
 *    directly) falls back to its transcript directory. That directory is not
 *    the session's shell root, so the marker must name the ABSOLUTE path under
 *    it, or the model would resolve it somewhere it is not (AC8).
 *
 * Everything here is asserted on the composed marker string and on the bytes
 * of the spill file on disk — never on which internal map was read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { nativeSessionScratchpadRoots, nativeTranscriptDirs } from "@/agents/native/session/session";
import { truncateNativeToolResult } from "@/agents/native/session/truncation-handler";
import { MODEL_MAX_BYTES } from "@/tools";

const SESSION_WORKDIR = "sess-with-workdir";
const SESSION_TRANSCRIPT = "sess-transcript-only";
const SESSION_BOTH = "sess-with-both";

let workdir: string;
let transcriptDir: string;

beforeEach(() => {
  workdir = makeTempDir("nax-native-spill-root-");
  transcriptDir = makeTempDir("nax-native-spill-transcript-");
});

afterEach(() => {
  nativeSessionScratchpadRoots.delete(SESSION_WORKDIR);
  nativeSessionScratchpadRoots.delete(SESSION_BOTH);
  nativeTranscriptDirs.delete(SESSION_TRANSCRIPT);
  nativeTranscriptDirs.delete(SESSION_BOTH);
  cleanupTempDir(workdir);
  cleanupTempDir(transcriptDir);
});

/** A Bash body comfortably past the model-facing cap. */
function overCapBody(): string {
  return `exit 0\n${"x".repeat(MODEL_MAX_BYTES)}\nlast-line-of-output`;
}

/** The one line of a shaped result that carries the truncation marker. */
function markerLineOf(content: string): string {
  return content.split("\n").find((line) => line.includes("[truncated")) ?? "";
}

/** The path the marker names, or "" when it names none. */
function namedPath(content: string): string {
  const match = /full output at (\S+)/.exec(markerLineOf(content));
  return match?.[1] ?? "";
}

// -----------------------------------------------------------------------------
// AC7 — a session registered in nativeSessionScratchpadRoots with workdir W
//       produces a `.nax/scratchpad/spill/...` marker, and the spill file
//       exists under W/.nax/scratchpad/spill/.
// -----------------------------------------------------------------------------

describe("AC7: a session with a scratchpad root gets a root-relative marker under its workdir", () => {
  test("AC7: the marker names .nax/scratchpad/spill/Bash-<callId>.txt and the file exists under W", async () => {
    nativeSessionScratchpadRoots.set(SESSION_WORKDIR, workdir);
    const body = overCapBody();

    const content = await truncateNativeToolResult(SESSION_WORKDIR, body, { toolName: "Bash", callId: "c1" });

    expect(namedPath(content)).toBe(".nax/scratchpad/spill/Bash-c1.txt");
    expect(markerLineOf(content)).toContain("(open with Read or ScratchpadRead)");
    const spillFile = join(workdir, ".nax", "scratchpad", "spill", "Bash-c1.txt");
    expect(existsSync(spillFile)).toBe(true);
    expect(readFileSync(spillFile, "utf8")).toBe(body);
  });

  test("AC7 boundary: a within-cap result is unchanged and spills nothing under W", async () => {
    nativeSessionScratchpadRoots.set(SESSION_WORKDIR, workdir);

    const content = await truncateNativeToolResult(SESSION_WORKDIR, "exit 0\nfine\n", {
      toolName: "Bash",
      callId: "c1b",
    });

    expect(content).toBe("exit 0\nfine\n");
    expect(existsSync(join(workdir, ".nax", "scratchpad", "spill"))).toBe(false);
  });

  test("AC7 boundary: an unregistered session names no path at all", async () => {
    const content = await truncateNativeToolResult("sess-unknown", overCapBody(), {
      toolName: "Bash",
      callId: "c1c",
    });

    // Nothing is spilled, so the marker must not name a file that is not there
    // — the fail-open contract AC5 of the policy pins.
    expect(namedPath(content)).toBe("");
    expect(content).not.toContain("[truncated: full output at");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });
});

// -----------------------------------------------------------------------------
// AC8 — a session registered only in nativeTranscriptDirs with directory T
//       produces a marker naming an absolute path starting with T.
// -----------------------------------------------------------------------------

describe("AC8: a session falling back to its transcript directory gets an absolute marker", () => {
  test("AC8: the marker names an absolute path starting with T", async () => {
    nativeTranscriptDirs.set(SESSION_TRANSCRIPT, transcriptDir);
    const body = overCapBody();

    const content = await truncateNativeToolResult(SESSION_TRANSCRIPT, body, { toolName: "Bash", callId: "c2" });

    const expected = join(transcriptDir, ".nax", "scratchpad", "spill", "Bash-c2.txt");
    expect(isAbsolute(expected)).toBe(true);
    expect(namedPath(content)).toBe(expected);
    expect(markerLineOf(content)).toContain("(open with Read or ScratchpadRead)");
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf8")).toBe(body);
  });

  test("AC8 boundary: a scratchpad root wins over a transcript dir for the same session", async () => {
    // Both maps hold the session — what a real open does when the runtime
    // records a workdir. The scratchpad root is the session's shell root, so
    // the marker must stay root-relative even though a transcript dir exists.
    nativeSessionScratchpadRoots.set(SESSION_BOTH, workdir);
    nativeTranscriptDirs.set(SESSION_BOTH, transcriptDir);

    const content = await truncateNativeToolResult(SESSION_BOTH, overCapBody(), { toolName: "Bash", callId: "c2b" });

    expect(namedPath(content)).toBe(".nax/scratchpad/spill/Bash-c2b.txt");
    expect(existsSync(join(workdir, ".nax", "scratchpad", "spill", "Bash-c2b.txt"))).toBe(true);
    expect(existsSync(join(transcriptDir, ".nax", "scratchpad", "spill", "Bash-c2b.txt"))).toBe(false);
  });

  test("AC8 boundary: a within-cap result through the transcript fallback names no path", async () => {
    nativeTranscriptDirs.set(SESSION_TRANSCRIPT, transcriptDir);

    const content = await truncateNativeToolResult(SESSION_TRANSCRIPT, "exit 0\nfine\n", {
      toolName: "Bash",
      callId: "c2c",
    });

    expect(content).toBe("exit 0\nfine\n");
    expect(existsSync(join(transcriptDir, ".nax", "scratchpad", "spill"))).toBe(false);
  });
});

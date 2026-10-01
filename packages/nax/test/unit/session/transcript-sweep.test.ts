/**
 * US-002 AC4-AC9 — sweepFeatureTranscripts
 *
 * `sweepFeatureTranscripts({ featureName, transcriptRoot, dryRun })` resolves
 * the feature's `sessions/` directory under the runtime outputDir via
 * `deriveNativeTranscriptDir` and delegates to `pruneRetainedTranscripts`.
 *
 * - AC4: prunes the derived directory to MAX_RETAINED_TRANSCRIPTS, returning
 *   the deleted count.
 * - AC5: a live-name `<name>.transcript.json` is as deletable as a
 *   `failed-<stamp>` artifact — mtime decides, never the name shape.
 * - AC6-AC9: returns 0 and touches nothing when the directory cannot be
 *   derived (either input missing), when dryRun is true, or when the derived
 *   directory is absent.
 *
 * The no-op cases seed a directory that is genuinely over the cap, so a 0 that
 * came from doing the work anyway would still fail the listing assertion.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import {
  _resetTranscriptTruncationWarningForTests,
  MAX_RETAINED_TRANSCRIPTS,
  saveTranscript,
} from "@/agents/native/session/transcript-store";
import { sweepFeatureTranscripts } from "@/session";

let rootDir: string;
let transcriptRoot: string;
const FEATURE = "demo-feature";

const msgs: ConversationMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

const SESSIONS_DIR = () => join(transcriptRoot, "features", FEATURE, "sessions");

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "nax-sweep-"));
  transcriptRoot = join(rootDir, "nax-out");
  _resetTranscriptTruncationWarningForTests();
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

/** Force an explicit mtime so age ordering never depends on write scheduling. */
async function setMtime(path: string, dayOffset: number): Promise<void> {
  const mtime = new Date(2026, 0, 1 + dayOffset);
  await utimes(path, mtime, mtime);
}

async function seedSessions(n: number): Promise<void> {
  const dir = SESSIONS_DIR();
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const name = `sess-${String(i).padStart(3, "0")}`;
    await saveTranscript(dir, name, msgs);
    await setMtime(join(dir, `${name}.transcript.json`), i);
  }
}

/** A `failed-<stamp>` artifact, the shape `retainTranscript` leaves behind. */
async function seedFailed(name: string, stamp: string, dayOffset: number): Promise<string> {
  const dir = SESSIONS_DIR();
  await mkdir(dir, { recursive: true });
  const file = `${name}.transcript.failed-${stamp}.json`;
  await writeFile(join(dir, file), JSON.stringify({ savedAt: stamp, messages: msgs }), "utf8");
  await setMtime(join(dir, file), dayOffset);
  return file;
}

/** A live-name `<name>.transcript.json` file at an explicit mtime. */
async function seedLive(name: string, dayOffset: number): Promise<string> {
  const dir = SESSIONS_DIR();
  await saveTranscript(dir, name, msgs);
  const file = `${name}.transcript.json`;
  await setMtime(join(dir, file), dayOffset);
  return file;
}

async function transcriptFiles(): Promise<string[]> {
  const entries = await readdir(SESSIONS_DIR());
  return entries.filter((n) => n.includes(".transcript.") && n.endsWith(".json")).sort((a, b) => a.localeCompare(b));
}

describe("sweepFeatureTranscripts — AC4", () => {
  test("prunes the derived directory and returns the count", async () => {
    await seedSessions(53);
    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });
    expect(deleted).toBe(3);
    const dir = SESSIONS_DIR();
    const files = (await readdir(dir)).filter((n) => n.endsWith(".transcript.json"));
    expect(files).toHaveLength(50);
  });

  test("prunes to MAX_RETAINED_TRANSCRIPTS when no explicit cap is passed", async () => {
    // AC4 names the cap as MAX_RETAINED_TRANSCRIPTS, not a locally chosen 50 —
    // the sweep takes no maxRetained argument, so the constant is the contract.
    await seedSessions(MAX_RETAINED_TRANSCRIPTS + 4);

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });

    expect(deleted).toBe(4);
    expect(await transcriptFiles()).toHaveLength(MAX_RETAINED_TRANSCRIPTS);
  });

  test("prunes the <transcriptRoot>/features/<featureName>/sessions directory specifically", async () => {
    // A same-shaped sessions dir under a DIFFERENT feature must be untouched:
    // it proves the sweep derived the path from featureName rather than
    // walking the transcript root.
    await seedSessions(MAX_RETAINED_TRANSCRIPTS + 2);
    const otherDir = join(transcriptRoot, "features", "other-feature", "sessions");
    await mkdir(otherDir, { recursive: true });
    for (let i = 0; i < MAX_RETAINED_TRANSCRIPTS + 2; i++) {
      await saveTranscript(otherDir, `other-${String(i).padStart(3, "0")}`, msgs);
    }

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });

    expect(deleted).toBe(2);
    expect(await transcriptFiles()).toHaveLength(MAX_RETAINED_TRANSCRIPTS);
    const otherRemaining = (await readdir(otherDir)).filter((n) => n.endsWith(".transcript.json"));
    expect(otherRemaining).toHaveLength(MAX_RETAINED_TRANSCRIPTS + 2);
  });
});

describe("sweepFeatureTranscripts — AC5 live-name vs failed-stamp parity", () => {
  test("deletes the oldest live-name file when it is older than every failed-<stamp> file", async () => {
    // The live name is the one `loadTranscript` opens, so an implementation
    // that "protected" it would silently exempt it from the cap. Age, not
    // name shape, decides: this live file is the oldest, so it goes.
    const live = await seedLive("sess-live", 0);
    for (let i = 0; i < MAX_RETAINED_TRANSCRIPTS; i++) {
      await seedFailed(`sess-${String(i).padStart(3, "0")}`, `2026-01-02T00-00-0${i % 10}-000Z`, 10 + i);
    }

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });

    expect(deleted).toBe(1);
    const remaining = await transcriptFiles();
    expect(remaining).not.toContain(live);
    expect(remaining).toHaveLength(MAX_RETAINED_TRANSCRIPTS);
  });

  test("deletes the oldest failed-<stamp> file when it is older than every live-name file", async () => {
    // The mirror case: same directory shape, ages swapped, and now the failed
    // artifact is the one that goes. Together these show neither shape is
    // privileged.
    const failed = await seedFailed("sess-failed", "2026-01-01T00-00-00-000Z", 0);
    for (let i = 0; i < MAX_RETAINED_TRANSCRIPTS; i++) {
      await seedLive(`sess-${String(i).padStart(3, "0")}`, 10 + i);
    }

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });

    expect(deleted).toBe(1);
    const remaining = await transcriptFiles();
    expect(remaining).not.toContain(failed);
    expect(remaining).toHaveLength(MAX_RETAINED_TRANSCRIPTS);
  });

  test("deletes both shapes together, purely by mtime, in a mixed directory", async () => {
    // Interleave the two shapes across the age range and go over the cap by 4:
    // the survivors must be exactly the newest MAX_RETAINED, regardless of shape.
    const seeded: string[] = [];
    for (let i = 0; i < MAX_RETAINED_TRANSCRIPTS + 4; i++) {
      const name = `sess-${String(i).padStart(3, "0")}`;
      seeded.push(
        i % 2 === 0 ? await seedLive(name, i) : await seedFailed(name, `2026-02-01T00-00-0${i % 10}-000Z`, i),
      );
    }
    const oldestFour = seeded.slice(0, 4);
    const expectedSurvivors = seeded.slice(4).sort((a, b) => a.localeCompare(b));

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });

    expect(deleted).toBe(4);
    const remaining = await transcriptFiles();
    expect(remaining).toEqual(expectedSurvivors);
    for (const gone of oldestFour) expect(remaining).not.toContain(gone);
    // The oldest four spanned both shapes, so both were actually exercised.
    expect(oldestFour.filter((n) => n.endsWith(".transcript.json"))).toHaveLength(2);
    expect(oldestFour.filter((n) => n.includes(".transcript.failed-"))).toHaveLength(2);
  });
});

describe("sweepFeatureTranscripts — AC6 featureName undefined", () => {
  test("returns 0 and deletes nothing when featureName is undefined", async () => {
    // Seed well over the cap so a sweep that ran anyway would return a
    // non-zero count and lose files — the no-op has to be real, not vacuous.
    await seedSessions(MAX_RETAINED_TRANSCRIPTS + 3);
    const before = await transcriptFiles();

    const deleted = await sweepFeatureTranscripts({ featureName: undefined, transcriptRoot, dryRun: false });

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toEqual(before);
  });

  test("returns 0 and deletes nothing when featureName is an empty string", async () => {
    // Empty string is the falsy case `deriveNativeTranscriptDir` guards; an
    // unguarded join would resolve to <root>/features//sessions.
    await seedSessions(MAX_RETAINED_TRANSCRIPTS + 3);
    const before = await transcriptFiles();

    const deleted = await sweepFeatureTranscripts({ featureName: "", transcriptRoot, dryRun: false });

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toEqual(before);
  });
});

describe("sweepFeatureTranscripts — AC7 transcriptRoot undefined", () => {
  test("returns 0 and deletes nothing when transcriptRoot is undefined", async () => {
    await seedSessions(MAX_RETAINED_TRANSCRIPTS + 3);
    const before = await transcriptFiles();

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot: undefined, dryRun: false });

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toEqual(before);
  });

  test("returns 0 and deletes nothing when transcriptRoot is an empty string", async () => {
    // Without the falsy guard this would derive a CWD-relative
    // features/<name>/sessions path and prune whatever happened to be there.
    await seedSessions(MAX_RETAINED_TRANSCRIPTS + 3);
    const before = await transcriptFiles();

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot: "", dryRun: false });

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toEqual(before);
  });

  test("returns 0 and deletes nothing when both inputs are absent", async () => {
    await seedSessions(MAX_RETAINED_TRANSCRIPTS + 3);
    const before = await transcriptFiles();

    const deleted = await sweepFeatureTranscripts({});

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toEqual(before);
  });
});

describe("sweepFeatureTranscripts — AC8 dryRun", () => {
  test("returns 0 and deletes nothing when dryRun is true, even over the cap", async () => {
    // Same directory that AC4 prunes by 3 — the only difference is dryRun, so
    // the 0 and the untouched listing are attributable to the dry-run guard.
    await seedSessions(53);
    const before = await transcriptFiles();
    expect(before).toHaveLength(53);

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: true });

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toEqual(before);
  });

  test("leaves failed-<stamp> artifacts in place under dryRun", async () => {
    // The retained set is what a real sweep would delete first; a dry run must
    // not remove post-mortem artifacts a human is about to read.
    const kept: string[] = [];
    for (let i = 0; i < MAX_RETAINED_TRANSCRIPTS + 5; i++) {
      kept.push(await seedFailed(`sess-${String(i).padStart(3, "0")}`, `2026-03-01T00-00-0${i % 10}-000Z`, i));
    }

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: true });

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toEqual(kept.sort((a, b) => a.localeCompare(b)));
  });

  test("prunes the very same directory once dryRun is false", async () => {
    // Pins dryRun as the sole cause: a dry run then a real run on one
    // directory, no reseeding in between.
    await seedSessions(53);

    expect(await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: true })).toBe(0);
    expect(await transcriptFiles()).toHaveLength(53);

    expect(await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false })).toBe(3);
    expect(await transcriptFiles()).toHaveLength(MAX_RETAINED_TRANSCRIPTS);
  });
});

describe("sweepFeatureTranscripts — AC9 derived directory absent", () => {
  test("returns 0 when the derived sessions directory does not exist", async () => {
    // Nothing seeded: transcriptRoot itself was never created, which is the
    // state of a fresh run's output dir at setupRun time.
    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });

    expect(deleted).toBe(0);
  });

  test("does not create the derived directory as a side effect", async () => {
    // A sweep that mkdir'd its target would leave an empty sessions/ tree in
    // every output dir; ENOENT must stay a read-only no-op.
    await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });

    await expect(readdir(SESSIONS_DIR())).rejects.toThrow();
  });

  test("returns 0 when the feature's sessions directory exists but is empty", async () => {
    await mkdir(SESSIONS_DIR(), { recursive: true });

    const deleted = await sweepFeatureTranscripts({ featureName: FEATURE, transcriptRoot, dryRun: false });

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toEqual([]);
  });

  test("returns 0 for a feature that has no sessions directory of its own", async () => {
    // The root and a sibling feature exist and are over the cap; the swept
    // feature has no directory, so the answer is 0 and the sibling is intact.
    await seedSessions(MAX_RETAINED_TRANSCRIPTS + 2);

    const deleted = await sweepFeatureTranscripts({
      featureName: "feature-without-sessions",
      transcriptRoot,
      dryRun: false,
    });

    expect(deleted).toBe(0);
    expect(await transcriptFiles()).toHaveLength(MAX_RETAINED_TRANSCRIPTS + 2);
  });
});

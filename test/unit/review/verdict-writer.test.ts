/**
 * Unit tests for src/review/verdict-writer.ts
 *
 * Tests cover:
 * - Happy path: writes verdict JSON to .nax/review-verdicts/<featureName>/<storyId>.json
 * - Correct content (storyId, threshold, reviewer breakdown)
 * - Never throws on write failure (fire-and-forget)
 * - Uses "_unknown" subfolder when featureName is missing
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _verdictWriterDeps, writeReviewVerdict } from "../../../src/review/verdict-writer";
import type { ReviewVerdictEntry } from "../../../src/review/verdict-writer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WriteFileMock = ReturnType<typeof mock>;

function makeWriteCapture(): { calls: Array<{ path: string; body: string }>; fn: WriteFileMock } {
  const calls: Array<{ path: string; body: string }> = [];
  const fn = mock(async (path: string, body: string) => {
    calls.push({ path, body });
    return 0;
  });
  return { calls, fn };
}

const ENTRY: ReviewVerdictEntry = {
  storyId: "US-001",
  featureName: "my-feature",
  timestamp: "2026-04-14T00:00:00.000Z",
  blockingThreshold: "error",
  reviewers: {
    semantic: { blocking: 1, advisory: 2, passed: false },
    adversarial: { blocking: 0, advisory: 1, passed: true },
  },
};

// ---------------------------------------------------------------------------
// Saved deps
// ---------------------------------------------------------------------------

let origFindNaxProjectRoot: typeof _verdictWriterDeps.findNaxProjectRoot;
let origMkdir: typeof _verdictWriterDeps.mkdir;
let origWriteFile: typeof _verdictWriterDeps.writeFile;

beforeEach(() => {
  origFindNaxProjectRoot = _verdictWriterDeps.findNaxProjectRoot;
  origMkdir = _verdictWriterDeps.mkdir;
  origWriteFile = _verdictWriterDeps.writeFile;

  // Default happy-path mocks
  _verdictWriterDeps.findNaxProjectRoot = mock(async () => "/tmp/project");
  _verdictWriterDeps.mkdir = mock(async () => undefined);
});

afterEach(() => {
  _verdictWriterDeps.findNaxProjectRoot = origFindNaxProjectRoot;
  _verdictWriterDeps.mkdir = origMkdir;
  _verdictWriterDeps.writeFile = origWriteFile;
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("writeReviewVerdict — happy path", () => {
  test("writes valid JSON to .nax/review-verdicts/<featureName>/<storyId>.json", async () => {
    const { calls, fn } = makeWriteCapture();
    _verdictWriterDeps.writeFile = fn as unknown as unknown as typeof _verdictWriterDeps.writeFile;

    await writeReviewVerdict(ENTRY);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toContain("review-verdicts");
    expect(calls[0].path).toContain("my-feature");
    expect(calls[0].path).toEndWith("US-001.json");
  });

  test("written JSON contains storyId, blockingThreshold and reviewer breakdown", async () => {
    const { calls, fn } = makeWriteCapture();
    _verdictWriterDeps.writeFile = fn as unknown as unknown as typeof _verdictWriterDeps.writeFile;

    await writeReviewVerdict(ENTRY);

    const parsed = JSON.parse(calls[0].body) as ReviewVerdictEntry;
    expect(parsed.storyId).toBe("US-001");
    expect(parsed.blockingThreshold).toBe("error");
    expect(parsed.reviewers.semantic?.blocking).toBe(1);
    expect(parsed.reviewers.semantic?.advisory).toBe(2);
    expect(parsed.reviewers.adversarial?.blocking).toBe(0);
    expect(parsed.reviewers.adversarial?.advisory).toBe(1);
  });

  test("creates directory recursively before writing", async () => {
    const mkdirCalls: string[] = [];
    _verdictWriterDeps.mkdir = mock(async (path: string) => {
      mkdirCalls.push(path);
      return undefined;
    });
    _verdictWriterDeps.writeFile = mock(async () => {}) as unknown as typeof _verdictWriterDeps.writeFile;

    await writeReviewVerdict(ENTRY);

    expect(mkdirCalls).toHaveLength(1);
    expect(mkdirCalls[0]).toContain("my-feature");
  });
});

// ---------------------------------------------------------------------------
// Fallback subfolder
// ---------------------------------------------------------------------------

describe("writeReviewVerdict — featureName missing", () => {
  test("uses '_unknown' subfolder when featureName is undefined", async () => {
    const { calls, fn } = makeWriteCapture();
    _verdictWriterDeps.writeFile = fn as unknown as unknown as typeof _verdictWriterDeps.writeFile;

    await writeReviewVerdict({ ...ENTRY, featureName: undefined });

    expect(calls[0].path).toContain("_unknown");
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe("writeReviewVerdict — error resilience", () => {
  test("does not throw when mkdir fails", async () => {
    _verdictWriterDeps.mkdir = mock(async () => { throw new Error("permission denied"); });
    _verdictWriterDeps.writeFile = mock(async () => {}) as unknown as typeof _verdictWriterDeps.writeFile;

    await expect(writeReviewVerdict(ENTRY)).resolves.toBeUndefined();
  });

  test("does not throw when writeFile fails", async () => {
    _verdictWriterDeps.writeFile = mock(async () => { throw new Error("disk full"); }) as unknown as typeof _verdictWriterDeps.writeFile;

    await expect(writeReviewVerdict(ENTRY)).resolves.toBeUndefined();
  });

  test("does not throw when findNaxProjectRoot fails", async () => {
    _verdictWriterDeps.findNaxProjectRoot = mock(async () => { throw new Error("not a git repo"); });
    _verdictWriterDeps.writeFile = mock(async () => {}) as unknown as typeof _verdictWriterDeps.writeFile;

    await expect(writeReviewVerdict(ENTRY)).resolves.toBeUndefined();
  });
});

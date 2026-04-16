import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  appendScratchEntry,
  scratchFilePath,
  _scratchWriterDeps,
} from "../../../src/session/scratch-writer";
import type { ScratchEntry } from "../../../src/session/scratch-writer";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nax-scratch-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const VERIFY_ENTRY: ScratchEntry = {
  kind: "verify-result",
  timestamp: "2026-01-01T00:00:00.000Z",
  storyId: "US-001",
  stage: "verify",
  success: false,
  status: "TEST_FAILURE",
  passCount: 5,
  failCount: 2,
  rawOutputTail: "Expected 1 but got 2",
};

const RECTIFY_ENTRY: ScratchEntry = {
  kind: "rectify-attempt",
  timestamp: "2026-01-01T00:01:00.000Z",
  storyId: "US-001",
  stage: "rectify",
  attempt: 1,
  succeeded: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// scratchFilePath
// ─────────────────────────────────────────────────────────────────────────────

describe("scratchFilePath", () => {
  test("appends scratch.jsonl to the dir", () => {
    expect(scratchFilePath("/some/dir")).toBe("/some/dir/scratch.jsonl");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendScratchEntry — integration (real filesystem via tmpdir)
// ─────────────────────────────────────────────────────────────────────────────

describe("appendScratchEntry", () => {
  test("creates the file if it does not exist", async () => {
    const scratchDir = join(tmpDir, "sessions", "sess-001");
    await appendScratchEntry(scratchDir, VERIFY_ENTRY);

    const filePath = scratchFilePath(scratchDir);
    const raw = await Bun.file(filePath).text();
    expect(raw.trim()).not.toBe("");
  });

  test("writes valid JSON on first call", async () => {
    const scratchDir = join(tmpDir, "sess-a");
    await appendScratchEntry(scratchDir, VERIFY_ENTRY);

    const raw = await Bun.file(scratchFilePath(scratchDir)).text();
    const parsed = JSON.parse(raw.trim());
    expect(parsed.kind).toBe("verify-result");
    expect(parsed.storyId).toBe("US-001");
    expect(parsed.failCount).toBe(2);
  });

  test("appends on second call — two JSONL lines", async () => {
    const scratchDir = join(tmpDir, "sess-b");
    await appendScratchEntry(scratchDir, VERIFY_ENTRY);
    await appendScratchEntry(scratchDir, RECTIFY_ENTRY);

    const raw = await Bun.file(scratchFilePath(scratchDir)).text();
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe("verify-result");
    expect(JSON.parse(lines[1]).kind).toBe("rectify-attempt");
  });

  test("each line is valid JSON", async () => {
    const scratchDir = join(tmpDir, "sess-c");
    await appendScratchEntry(scratchDir, VERIFY_ENTRY);
    await appendScratchEntry(scratchDir, RECTIFY_ENTRY);

    const raw = await Bun.file(scratchFilePath(scratchDir)).text();
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("creates nested parent directories", async () => {
    const scratchDir = join(tmpDir, "deep", "nested", "sess-001");
    await appendScratchEntry(scratchDir, VERIFY_ENTRY);
    const exists = await Bun.file(scratchFilePath(scratchDir)).exists();
    expect(exists).toBe(true);
  });

  describe("throws on write failure (dep injection)", () => {
    const origWrite = _scratchWriterDeps.writeFile;

    beforeEach(() => {
      _scratchWriterDeps.writeFile = async () => {
        throw new Error("disk full");
      };
    });

    afterEach(() => {
      _scratchWriterDeps.writeFile = origWrite;
    });

    test("propagates write error", async () => {
      let threw = false;
      try {
        await appendScratchEntry(join(tmpDir, "sess-fail"), VERIFY_ENTRY);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  appendScratchEntry,
  digestFilePath,
  readDigestFile,
  scratchFilePath,
  writeDigestFile,
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

  describe("throws on append failure (dep injection)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = _scratchWriterDeps as any;
    let origAppend: unknown;

    beforeEach(() => {
      origAppend = deps.appendFile;
      deps.appendFile = async () => {
        throw new Error("disk full");
      };
    });

    afterEach(() => {
      deps.appendFile = origAppend;
    });

    test("propagates append error", async () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// #508-M8: append-atomic — replace read+writeFile with appendFile dep
// ─────────────────────────────────────────────────────────────────────────────

describe("appendScratchEntry — #508-M8 append-atomic dep injection", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps = _scratchWriterDeps as any;

  test("_scratchWriterDeps exposes appendFile for injection", () => {
    expect(typeof deps.appendFile).toBe("function");
  });

  test("appendScratchEntry calls appendFile dep (not read+writeFile) for append", async () => {
    let appendPayload: string | undefined;
    let writeCalled = false;

    const origAppend = deps.appendFile;
    const origWrite = _scratchWriterDeps.writeFile;
    deps.appendFile = async (_path: string, content: string) => { appendPayload = content; return 0; };
    _scratchWriterDeps.writeFile = async () => { writeCalled = true; return 0; };

    try {
      const scratchDir = join(tmpDir, "m8-atomic");
      await appendScratchEntry(scratchDir, VERIFY_ENTRY);
      expect(appendPayload).toBeDefined();
      expect(appendPayload).toContain('"kind":"verify-result"');
      expect(writeCalled).toBe(false);
    } finally {
      deps.appendFile = origAppend;
      _scratchWriterDeps.writeFile = origWrite;
    }
  });

  test("appendFile error propagates out of appendScratchEntry", async () => {
    const origAppend = deps.appendFile;
    deps.appendFile = async () => { throw new Error("disk full (append)"); };

    try {
      let threw = false;
      try {
        await appendScratchEntry(join(tmpDir, "m8-fail"), VERIFY_ENTRY);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      deps.appendFile = origAppend;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// digestFilePath / writeDigestFile / readDigestFile
// ─────────────────────────────────────────────────────────────────────────────

describe("digestFilePath", () => {
  test("returns <scratchDir>/digest-<stageKey>.txt", () => {
    expect(digestFilePath("/sessions/sess-001", "context")).toBe("/sessions/sess-001/digest-context.txt");
    expect(digestFilePath("/sessions/sess-001", "verify")).toBe("/sessions/sess-001/digest-verify.txt");
  });
});

describe("writeDigestFile", () => {
  test("creates the digest file with content", async () => {
    const scratchDir = join(tmpDir, "sess-digest-a");
    await writeDigestFile(scratchDir, "context", "prior context summary");
    const raw = await Bun.file(digestFilePath(scratchDir, "context")).text();
    expect(raw).toBe("prior context summary");
  });

  test("overwrites existing digest on second call", async () => {
    const scratchDir = join(tmpDir, "sess-digest-b");
    await writeDigestFile(scratchDir, "context", "first digest");
    await writeDigestFile(scratchDir, "context", "second digest");
    const raw = await Bun.file(digestFilePath(scratchDir, "context")).text();
    expect(raw).toBe("second digest");
  });

  test("creates nested parent directories if absent", async () => {
    const scratchDir = join(tmpDir, "deep", "nested", "sess-digest");
    await writeDigestFile(scratchDir, "context", "hello");
    const exists = await Bun.file(digestFilePath(scratchDir, "context")).exists();
    expect(exists).toBe(true);
  });

  test("different stage keys produce separate files", async () => {
    const scratchDir = join(tmpDir, "sess-digest-c");
    await writeDigestFile(scratchDir, "context", "context digest");
    await writeDigestFile(scratchDir, "verify", "verify digest");
    const ctxRaw = await Bun.file(digestFilePath(scratchDir, "context")).text();
    const verRaw = await Bun.file(digestFilePath(scratchDir, "verify")).text();
    expect(ctxRaw).toBe("context digest");
    expect(verRaw).toBe("verify digest");
  });
});

describe("readDigestFile", () => {
  test("returns empty string when file does not exist", async () => {
    const result = await readDigestFile(join(tmpDir, "no-such-session"), "context");
    expect(result).toBe("");
  });

  test("returns trimmed content when file exists", async () => {
    const scratchDir = join(tmpDir, "sess-digest-d");
    await writeDigestFile(scratchDir, "context", "  trimmed digest  ");
    const result = await readDigestFile(scratchDir, "context");
    expect(result).toBe("trimmed digest");
  });

  test("returns empty string for empty file", async () => {
    const scratchDir = join(tmpDir, "sess-digest-e");
    await writeDigestFile(scratchDir, "context", "");
    const result = await readDigestFile(scratchDir, "context");
    expect(result).toBe("");
  });

  test("roundtrip: write then read returns the same content", async () => {
    const scratchDir = join(tmpDir, "sess-digest-f");
    const digest = "## Context\n- Touched src/review/semantic.ts\n- Added test fixture tempWorkdir";
    await writeDigestFile(scratchDir, "context", digest);
    const result = await readDigestFile(scratchDir, "context");
    expect(result).toBe(digest);
  });
});

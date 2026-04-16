import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionScratchProvider, _sessionScratchDeps } from "../../../../../src/context/engine/providers/session-scratch";
import type { ContextRequest } from "../../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    workdir: "/repo",
    stage: "rectify",
    role: "implementer",
    budgetTokens: 4_000,
    ...overrides,
  };
}

const VERIFY_ENTRY = JSON.stringify({
  kind: "verify-result",
  timestamp: "2026-01-01T00:00:00.000Z",
  storyId: "US-001",
  stage: "verify",
  success: false,
  status: "TEST_FAILURE",
  passCount: 3,
  failCount: 1,
  rawOutputTail: "Expected true but got false",
});

const RECTIFY_ENTRY = JSON.stringify({
  kind: "rectify-attempt",
  timestamp: "2026-01-01T00:01:00.000Z",
  storyId: "US-001",
  stage: "rectify",
  attempt: 1,
  succeeded: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _sessionScratchDeps.fileExists;
let origReadFile: typeof _sessionScratchDeps.readFile;

beforeEach(() => {
  origFileExists = _sessionScratchDeps.fileExists;
  origReadFile = _sessionScratchDeps.readFile;
});

afterEach(() => {
  _sessionScratchDeps.fileExists = origFileExists;
  _sessionScratchDeps.readFile = origReadFile;
});

function mockScratchFile(content: string) {
  _sessionScratchDeps.fileExists = async () => true;
  _sessionScratchDeps.readFile = async () => content;
}

function mockNoFile() {
  _sessionScratchDeps.fileExists = async () => false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionScratchProvider", () => {
  test("id and kind are correct", () => {
    const provider = new SessionScratchProvider();
    expect(provider.id).toBe("session-scratch");
    expect(provider.kind).toBe("session");
  });

  test("returns empty when storyScratchDirs is undefined", async () => {
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest());
    expect(result.chunks).toHaveLength(0);
    expect(result.pullTools).toEqual([]);
  });

  test("returns empty when storyScratchDirs is []", async () => {
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: [] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty when scratch file does not exist", async () => {
    mockNoFile();
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty when scratch file is empty", async () => {
    mockScratchFile("");
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("returns a chunk for a scratch file with one entry", async () => {
    mockScratchFile(`${VERIFY_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    const chunk = result.chunks[0];
    expect(chunk.kind).toBe("session");
    expect(chunk.scope).toBe("session");
    expect(chunk.role).toContain("all");
    expect(chunk.rawScore).toBe(0.9);
    expect(chunk.id).toMatch(/^session-scratch:[0-9a-f]{8}$/);
    expect(chunk.content).toContain("Verify");
    expect(chunk.content).toContain("FAIL");
  });

  test("includes content from multiple entries", async () => {
    mockScratchFile(`${VERIFY_ENTRY}\n${RECTIFY_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("Verify");
    expect(result.chunks[0].content).toContain("Rectify");
  });

  test("skips malformed JSONL lines without throwing", async () => {
    mockScratchFile(`${VERIFY_ENTRY}\nnot-valid-json\n${RECTIFY_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    // Should still produce a chunk from the two valid entries
    expect(result.chunks).toHaveLength(1);
  });

  test("chunk id is stable for identical content", async () => {
    mockScratchFile(`${VERIFY_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const r1 = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));
    const r2 = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));
    expect(r1.chunks[0].id).toBe(r2.chunks[0].id);
  });

  test("produces one chunk per non-empty scratch dir", async () => {
    // Two dirs: both have a file
    let callCount = 0;
    _sessionScratchDeps.fileExists = async () => true;
    _sessionScratchDeps.readFile = async () => {
      callCount++;
      return `${VERIFY_ENTRY}\n`;
    };

    const provider = new SessionScratchProvider();
    const result = await provider.fetch(
      makeRequest({ storyScratchDirs: ["/sess/dir-a", "/sess/dir-b"] }),
    );
    expect(result.chunks).toHaveLength(2);
    expect(callCount).toBe(2);
  });

  test("pullTools is always empty (push-only provider)", async () => {
    mockScratchFile(`${VERIFY_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));
    expect(result.pullTools).toEqual([]);
  });
});

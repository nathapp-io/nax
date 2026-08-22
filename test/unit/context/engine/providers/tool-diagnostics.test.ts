/**
 * US-002 ToolDiagnosticsProvider — surface authoritative tool diagnostics
 *
 * `ToolDiagnosticsProvider` reads `tool-diagnostics` scratch entries from the
 * same `scratch.jsonl` files written by US-001 lint/typecheck capture and
 * surfaces them as `diagnostics` kind chunks at session scope.
 *
 * Acceptance criteria mapping (provider scope):
 *  AC1 — constructor with no args succeeds
 *  AC2 — id = "tool-diagnostics", kind = "diagnostics"
 *  AC5 — empty storyScratchDirs → empty chunks
 *  AC6 — nonexistent scratch dir → empty chunks, never throws
 *  AC7 — malformed JSONL line + one valid tool-diagnostics entry → one chunk
 *  AC8 — two tool-diagnostics entries in a real scratch dir → one combined chunk
 *         naming both diagnostic files (real-filesystem round-trip per spec)
 *  AC9 — scratch dir with only verify-result entries → empty chunks
 *  AC10 — returned chunk has kind=diagnostics, scope=session, tokens > 0
 *
 * AC3/AC4 — kind weights pinned in scoring.test.ts (US-002 scoring coverage)
 * AC11/AC12/AC13 — factory / stage-config wiring
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolDiagnosticsProvider, _toolDiagnosticsDeps } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import { scratchFilePath } from "@/session";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-002",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "rectify",
    role: "implementer",
    budgetTokens: 4_000,
    ...overrides,
  };
}

const DIAG_ENTRY = (file: string, message: string, tool = "tsc") =>
  JSON.stringify({
    kind: "tool-diagnostics",
    timestamp: "2026-01-01T00:00:00.000Z",
    storyId: "US-002",
    diagnostics: [{ file, line: 12, severity: "error", message, tool }],
  });

const VERIFY_ENTRY = JSON.stringify({
  kind: "verify-result",
  timestamp: "2026-01-01T00:00:00.000Z",
  storyId: "US-002",
  stage: "verify",
  success: false,
  status: "TEST_FAILURE",
  passCount: 3,
  failCount: 1,
  rawOutputTail: "Expected true but got false",
});

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _toolDiagnosticsDeps.fileExists;
let origReadFile: typeof _toolDiagnosticsDeps.readFile;

beforeEach(() => {
  origFileExists = _toolDiagnosticsDeps.fileExists;
  origReadFile = _toolDiagnosticsDeps.readFile;
});

afterEach(() => {
  _toolDiagnosticsDeps.fileExists = origFileExists;
  _toolDiagnosticsDeps.readFile = origReadFile;
});

function mockScratchFile(content: string) {
  _toolDiagnosticsDeps.fileExists = async () => true;
  _toolDiagnosticsDeps.readFile = async () => content;
}

function mockNoFile() {
  _toolDiagnosticsDeps.fileExists = async () => false;
  _toolDiagnosticsDeps.readFile = async () => {
    throw new Error("readFile should not be called when file does not exist");
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 + AC2 — construction & identity
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — AC1 + AC2 construction & identity", () => {
  test("AC1: construction succeeds with no arguments", () => {
    expect(() => new ToolDiagnosticsProvider()).not.toThrow();
  });

  test("AC2: id is 'tool-diagnostics' and kind is 'diagnostics'", () => {
    const provider = new ToolDiagnosticsProvider();
    expect(provider.id).toBe("tool-diagnostics");
    expect(provider.kind).toBe("diagnostics");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — empty storyScratchDirs short-circuit
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — AC5 empty storyScratchDirs", () => {
  test("returns empty chunks when storyScratchDirs is undefined", async () => {
    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest());
    expect(result.chunks).toHaveLength(0);
    expect(result.pullTools).toEqual([]);
  });

  test("returns empty chunks when storyScratchDirs is an empty array", async () => {
    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: [] }));
    expect(result.chunks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — nonexistent scratch dir
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — AC6 nonexistent scratch dir", () => {
  test("returns empty chunks without throwing when scratch file is absent", async () => {
    mockNoFile();
    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/nonexistent"] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("skips a nonexistent dir but emits chunks for a present dir in the same request", async () => {
    const existsPaths: string[] = [];
    _toolDiagnosticsDeps.fileExists = async (path) => {
      existsPaths.push(path);
      return path.includes("present");
    };
    _toolDiagnosticsDeps.readFile = async (path) => {
      if (path.includes("present")) {
        return `${DIAG_ENTRY("src/a.ts", "Cannot find name 'foo'.")}\n`;
      }
      throw new Error("readFile on absent dir");
    };

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(
      makeRequest({
        storyScratchDirs: ["/sess/missing-dir", "/sess/present-dir"],
      }),
    );

    expect(existsPaths).toHaveLength(2);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].kind).toBe("diagnostics");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — malformed JSONL line + one valid tool-diagnostics entry
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — AC7 malformed JSONL tolerance", () => {
  test("returns one chunk when scratch JSONL contains one malformed line and one valid tool-diagnostics entry", async () => {
    const valid = DIAG_ENTRY("src/a.ts", "Cannot find name 'foo'.");
    mockScratchFile(`not-valid-json\n${valid}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
  });

  test("does not throw on unparseable JSONL", async () => {
    mockScratchFile(`garbage\nmore-garbage\n${DIAG_ENTRY("src/a.ts", "msg")}\n`);

    const provider = new ToolDiagnosticsProvider();
    await expect(provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }))).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — real scratch dir with two tool-diagnostics entries
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — AC8 real scratch dir round-trip", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-tool-diagnostics-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC8: two tool-diagnostics entries from a real scratch directory → one combined chunk naming both diagnostic files", async () => {
    const scratchDir = join(tempDir, "scratch");
    await mkdir(scratchDir, { recursive: true });
    const filePath = scratchFilePath(scratchDir);
    const entryA = DIAG_ENTRY("src/foo.ts", "Type 'string' is not assignable to type 'number'.");
    const entryB = DIAG_ENTRY("src/bar.ts", "Property 'baz' does not exist on type 'Qux'.");
    await writeFile(filePath, `${entryA}\n${entryB}\n`, "utf8");

    // The provider uses scratchFilePath(scratchDir) → "<dir>/scratch.jsonl".
    // Wire deps to read from real disk; no mocking.
    _toolDiagnosticsDeps.fileExists = async (path) => {
      try {
        return await Bun.file(path).exists();
      } catch {
        return false;
      }
    };
    _toolDiagnosticsDeps.readFile = async (path) => {
      return await Bun.file(path).text();
    };

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: [scratchDir] }));

    expect(result.chunks).toHaveLength(1);
    const content = result.chunks[0].content;
    expect(content).toContain("src/foo.ts");
    expect(content).toContain("src/bar.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — only non-tool-diagnostics entries → empty chunks
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — AC9 only verify-result entries", () => {
  test("returns empty chunks when scratch dir contains only verify-result entries", async () => {
    mockScratchFile(`${VERIFY_ENTRY}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty chunks when scratch dir contains rectify-attempt and tdd-session entries (no tool-diagnostics)", async () => {
    const rectifyEntry = JSON.stringify({
      kind: "rectify-attempt",
      timestamp: "2026-01-01T00:01:00.000Z",
      storyId: "US-002",
      stage: "rectify",
      attempt: 1,
      succeeded: false,
    });
    mockScratchFile(`${VERIFY_ENTRY}\n${rectifyEntry}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — chunk shape on success
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — AC10 returned chunk shape", () => {
  test("emitted chunk has kind=diagnostics, scope=session, and tokens > 0", async () => {
    mockScratchFile(`${DIAG_ENTRY("src/a.ts", "msg")}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    const chunk = result.chunks[0];
    expect(chunk.kind).toBe("diagnostics");
    expect(chunk.scope).toBe("session");
    expect(chunk.tokens).toBeGreaterThan(0);
  });

  test("emitted chunk role includes 'all' so it reaches every caller role", async () => {
    mockScratchFile(`${DIAG_ENTRY("src/a.ts", "msg")}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks[0].role).toContain("all");
  });

  test("chunk content includes the diagnostic file path and message", async () => {
    mockScratchFile(`${DIAG_ENTRY("src/important.ts", "Variable 'x' is not defined.")}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    const content = result.chunks[0].content;
    expect(content).toContain("src/important.ts");
    expect(content).toContain("Variable 'x' is not defined.");
  });

  test("emits one chunk per scratch dir that contains tool-diagnostics", async () => {
    // Two scratch dirs: both contain tool-diagnostics entries.
    const calls: string[] = [];
    _toolDiagnosticsDeps.fileExists = async () => true;
    _toolDiagnosticsDeps.readFile = async (path) => {
      calls.push(path);
      return `${DIAG_ENTRY("src/a.ts", "msg")}\n`;
    };

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir-a", "/sess/dir-b"] }));

    expect(result.chunks).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional defensive shape tests
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — defensive parsing", () => {
  test("an entry missing the diagnostics array is skipped without throwing", async () => {
    const malformed = JSON.stringify({
      kind: "tool-diagnostics",
      timestamp: "2026-01-01T00:00:00.000Z",
      storyId: "US-002",
      // diagnostics intentionally absent
    });
    mockScratchFile(`${malformed}\n${DIAG_ENTRY("src/a.ts", "msg")}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    // Skips the malformed entry, still emits a chunk from the valid one.
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("src/a.ts");
  });

  test("an empty diagnostics array is treated as 'no diagnostics' and yields no chunk for that entry", async () => {
    const emptyDiags = JSON.stringify({
      kind: "tool-diagnostics",
      timestamp: "2026-01-01T00:00:00.000Z",
      storyId: "US-002",
      diagnostics: [],
    });
    mockScratchFile(`${emptyDiags}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(0);
  });

  test("a non-tool-diagnostics entry is silently ignored", async () => {
    mockScratchFile(`${VERIFY_ENTRY}\n${DIAG_ENTRY("src/a.ts", "msg")}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    // Verify text must not leak into the diagnostics chunk.
    expect(result.chunks[0].content).not.toContain("Verify");
    expect(result.chunks[0].content).not.toContain("tool-diagnostics");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial-rectification: defensive tolerance beyond the spec's two cases
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolDiagnosticsProvider — adversarial-rectification defensive tolerance", () => {
  test("a null element inside the diagnostics array is skipped without throwing fetch()", async () => {
    // Syntactically valid JSON, but the diagnostics array contains a null element.
    // The spec's 'never throws' contract requires fetch() to skip the unreadable
    // unit and return whatever parsed.
    const entry = JSON.stringify({
      kind: "tool-diagnostics",
      timestamp: "2026-01-01T00:00:00.000Z",
      storyId: "US-002",
      diagnostics: [null, { file: "src/keep.ts", line: 1, severity: "error", message: "kept", tool: "tsc" }],
    });
    mockScratchFile(`${entry}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("src/keep.ts");
  });

  test("a non-object element inside the diagnostics array is skipped without throwing fetch()", async () => {
    const entry = JSON.stringify({
      kind: "tool-diagnostics",
      timestamp: "2026-01-01T00:00:00.000Z",
      storyId: "US-002",
      diagnostics: ["oops-string", 42, { file: "src/ok.ts", line: 1, severity: "error", message: "ok", tool: "tsc" }],
    });
    mockScratchFile(`${entry}\n`);

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("src/ok.ts");
  });

  test("fetch() does not throw and still emits chunks for other dirs when readFile rejects for one dir", async () => {
    // First dir's file exists but readFile throws (file vanished between checks).
    // Second dir's file exists and reads cleanly. fetch() must skip dir-1 and
    // return dir-2's chunk — never abort the whole fetch.
    _toolDiagnosticsDeps.fileExists = async () => true;
    _toolDiagnosticsDeps.readFile = async (path) => {
      if (path.includes("vanished")) {
        throw new Error("ENOENT: scratch file vanished after exists check");
      }
      return `${DIAG_ENTRY("src/ok.ts", "kept")}\n`;
    };

    const provider = new ToolDiagnosticsProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/vanished", "/sess/present"] }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("src/ok.ts");
  });
});

// Reference unused-import warning avoidance (tmpdir is used by AC8 setup helper).
void tmpdir;

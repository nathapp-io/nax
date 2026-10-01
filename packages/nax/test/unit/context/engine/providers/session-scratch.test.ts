import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _sessionScratchDeps, SessionScratchProvider } from "@/context/engine/providers/session-scratch";
import type { ContextRequest } from "@/context/engine/types";
import { _pathFilterDeps } from "@/utils/path-filters";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo",
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

const TDD_ENTRY = JSON.stringify({
  kind: "tdd-session",
  timestamp: "2026-01-01T00:02:00.000Z",
  storyId: "US-001",
  stage: "tdd-implementer",
  role: "implementer",
  success: true,
  filesChanged: ["src/index.ts"],
  outputTail: "Implemented the missing edge-case handling.",
});

const TOOL_DIAGNOSTICS_ENTRY = JSON.stringify({
  kind: "tool-diagnostics",
  timestamp: "2026-01-01T00:00:00.000Z",
  storyId: "US-001",
  diagnostics: [{ file: "src/a.ts", line: 12, severity: "error", message: "Cannot find name 'foo'.", tool: "tsc" }],
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _sessionScratchDeps.fileExists;
let origReadFile: typeof _sessionScratchDeps.readFile;
let origPathFilterFileExists: typeof _pathFilterDeps.fileExists;
let origPathFilterReadFile: typeof _pathFilterDeps.readFile;

beforeEach(() => {
  origFileExists = _sessionScratchDeps.fileExists;
  origReadFile = _sessionScratchDeps.readFile;
  origPathFilterFileExists = _pathFilterDeps.fileExists;
  origPathFilterReadFile = _pathFilterDeps.readFile;
});

afterEach(() => {
  _sessionScratchDeps.fileExists = origFileExists;
  _sessionScratchDeps.readFile = origReadFile;
  _pathFilterDeps.fileExists = origPathFilterFileExists;
  _pathFilterDeps.readFile = origPathFilterReadFile;
});

function mockScratchFile(content: string) {
  _sessionScratchDeps.fileExists = async () => true;
  _sessionScratchDeps.readFile = async () => content;
}

function mockNoFile() {
  _sessionScratchDeps.fileExists = async () => false;
}

function mockNoIgnoreFile() {
  _pathFilterDeps.fileExists = async () => false;
  _pathFilterDeps.readFile = async () => "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionScratchProvider", () => {
  beforeEach(() => {
    mockNoIgnoreFile();
  });

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
    mockScratchFile(`${VERIFY_ENTRY}\n${TDD_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("Verify");
    expect(result.chunks[0].content).toContain("TDD implementer");
  });

  test("renders TDD session entries with changed files and output", async () => {
    mockScratchFile(`${TDD_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("TDD implementer");
    expect(result.chunks[0].content).toContain("src/index.ts");
    expect(result.chunks[0].content).toContain("edge-case handling");
  });

  test("applies .naxignore filters to TDD changed-file listing", async () => {
    const ignoreFiles = new Map<string, string>([["/repo/.naxignore", "*.generated.ts\ncoverage/\n"]]);
    _pathFilterDeps.fileExists = async (path) => ignoreFiles.has(path);
    _pathFilterDeps.readFile = async (path) => ignoreFiles.get(path) ?? "";
    const entry = JSON.stringify({
      kind: "tdd-session",
      timestamp: "2026-01-01T00:02:00.000Z",
      storyId: "US-001",
      stage: "tdd-implementer",
      role: "implementer",
      success: true,
      filesChanged: ["src/index.ts", "src/types.generated.ts", "coverage/lcov.info"],
      outputTail: "updated files",
    });
    mockScratchFile(`${entry}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("src/index.ts");
    expect(result.chunks[0].content).not.toContain("src/types.generated.ts");
    expect(result.chunks[0].content).not.toContain("coverage/lcov.info");
  });

  // nax#2111 (path-filters follow-up): under execution.storyIsolation
  // "worktree", request.packageDir is rooted at the story's worktree checkout
  // (context.ts:175 / stage-assembler.ts:221 set packageDir: ctx.workdir,
  // documented as pointing at .nax-wt/<id>/ in worktree mode) while
  // request.repoRoot stays the main checkout. Without storyWorkdir threaded
  // through, resolveNaxIgnorePatterns's packagePrefix falls back to
  // relative(repoRoot, packageDir) = ".nax-wt/US-001/packages/api", and a root
  // .naxignore pattern that matches that prefix itself (".nax-wt/**" — a
  // natural thing to ignore worktree artifacts with) then falsely excludes
  // every changed file in the package.
  test("does not false-positive-exclude an ordinary changed file under worktree isolation", async () => {
    const ignoreFiles = new Map<string, string>([["/repo/.naxignore", ".nax-wt/**\n"]]);
    _pathFilterDeps.fileExists = async (path) => ignoreFiles.has(path);
    _pathFilterDeps.readFile = async (path) => ignoreFiles.get(path) ?? "";
    const entry = JSON.stringify({
      kind: "tdd-session",
      timestamp: "2026-01-01T00:02:00.000Z",
      storyId: "US-001",
      stage: "tdd-implementer",
      role: "implementer",
      success: true,
      filesChanged: ["src/index.ts"],
      outputTail: "updated files",
    });
    mockScratchFile(`${entry}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(
      makeRequest({
        repoRoot: "/repo",
        packageDir: "/repo/.nax-wt/US-001/packages/api",
        storyWorkdir: "packages/api",
        storyScratchDirs: ["/sess/dir"],
      }),
    );

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("src/index.ts");
  });

  test("skips malformed JSONL lines without throwing", async () => {
    mockScratchFile(`${VERIFY_ENTRY}\nnot-valid-json\n${TDD_ENTRY}\n`);
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
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir-a", "/sess/dir-b"] }));
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

// ─────────────────────────────────────────────────────────────────────────────
// AC-42: cross-agent scratch neutralization
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionScratchProvider — AC-42 cross-agent neutralization", () => {
  const TDD_CLAUDE_ENTRY = JSON.stringify({
    kind: "tdd-session",
    timestamp: "2026-01-01T00:02:00.000Z",
    storyId: "US-001",
    stage: "tdd-implementer",
    role: "implementer",
    success: true,
    filesChanged: ["src/index.ts"],
    outputTail: "I used the Read tool to inspect and the Bash tool to run tests.",
    writtenByAgent: "claude",
  });

  const TDD_NO_AGENT_ENTRY = JSON.stringify({
    kind: "tdd-session",
    timestamp: "2026-01-01T00:02:00.000Z",
    storyId: "US-001",
    stage: "tdd-implementer",
    role: "implementer",
    success: true,
    filesChanged: [],
    outputTail: "I used the Read tool to inspect.",
  });

  test("neutralizes claude tool references when target agent differs", async () => {
    mockScratchFile(`${TDD_CLAUDE_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"], agentId: "codex" }));

    expect(result.chunks).toHaveLength(1);
    const content = result.chunks[0].content;
    expect(content).not.toContain("the Read tool");
    expect(content).not.toContain("the Bash tool");
    expect(content).toContain("a file read");
    expect(content).toContain("a shell command");
  });

  test("does not neutralize when target agent matches source agent", async () => {
    mockScratchFile(`${TDD_CLAUDE_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"], agentId: "claude" }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("the Read tool");
    expect(result.chunks[0].content).toContain("the Bash tool");
  });

  test("does not neutralize when no agentId on request", async () => {
    mockScratchFile(`${TDD_CLAUDE_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("the Read tool");
  });

  test("does not neutralize when entry has no writtenByAgent", async () => {
    mockScratchFile(`${TDD_NO_AGENT_ENTRY}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"], agentId: "codex" }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toContain("the Read tool");
  });

  test("does not neutralize rawOutputTail in verify-result when writtenByAgent is absent (pure test runner output)", async () => {
    const entry = JSON.stringify({
      kind: "verify-result",
      timestamp: "2026-01-01T00:00:00.000Z",
      storyId: "US-001",
      stage: "verify",
      success: false,
      status: "FAIL",
      passCount: 0,
      failCount: 1,
      rawOutputTail: "Expected the Read tool to return value.",
      // no writtenByAgent — pure test runner output
    });
    mockScratchFile(`${entry}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"], agentId: "codex" }));

    // No writtenByAgent → writtenByAgent ?? "" === targetAgentId ?? "" is false,
    // but neutralizeForAgent("", "") is a no-op, so content preserved
    expect(result.chunks[0].content).toContain("the Read tool");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M1: AC-42 verify-result.rawOutputTail must also be neutralized
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionScratchProvider — #508-M1 verify-result rawOutputTail neutralization", () => {
  test("neutralizes rawOutputTail in verify-result when writtenByAgent differs from target agent", async () => {
    const entry = JSON.stringify({
      kind: "verify-result",
      timestamp: "2026-01-01T00:00:00.000Z",
      storyId: "US-001",
      stage: "verify",
      success: false,
      status: "FAIL",
      passCount: 0,
      failCount: 1,
      rawOutputTail: "I used the Read tool to inspect the file before failing.",
      writtenByAgent: "claude",
    });
    mockScratchFile(`${entry}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"], agentId: "codex" }));

    expect(result.chunks[0].content).not.toContain("the Read tool");
    expect(result.chunks[0].content).toContain("a file read");
  });

  test("does not neutralize rawOutputTail in verify-result when target matches source", async () => {
    const entry = JSON.stringify({
      kind: "verify-result",
      timestamp: "2026-01-01T00:00:00.000Z",
      storyId: "US-001",
      stage: "verify",
      success: false,
      status: "FAIL",
      passCount: 0,
      failCount: 1,
      rawOutputTail: "I used the Read tool here.",
      writtenByAgent: "claude",
    });
    mockScratchFile(`${entry}\n`);
    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"], agentId: "claude" }));

    expect(result.chunks[0].content).toContain("the Read tool");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nax#1757: budget fitting keeps the NEWEST entries
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionScratchProvider — content budget drops the oldest entries, not the newest", () => {
  /** A failing verify-result carrying the full 500-char output tail the writer emits. */
  function bigVerifyEntry(minute: number, marker: string): string {
    return JSON.stringify({
      kind: "verify-result",
      timestamp: `2026-01-01T00:0${minute}:00.000Z`,
      storyId: "US-001",
      stage: "verify",
      success: false,
      status: "TEST_FAILURE",
      passCount: 10,
      failCount: 3,
      rawOutputTail: `${marker}${"x".repeat(490)}`,
    });
  }

  const NEWEST_SELF_VERIFY = JSON.stringify({
    kind: "self-verification",
    timestamp: "2026-01-01T00:09:00.000Z",
    storyId: "US-001",
    stage: "execution",
    selfVerification: { lint: "pass", typecheck: "pass", preExistingFailures: [] },
  });

  test("keeps the newest entries when several 500-char verify tails exceed the ceiling", async () => {
    mockNoIgnoreFile();
    // Five oversized entries plus a newest self-verification: well past the
    // 2000-char ceiling, so something must be dropped.
    mockScratchFile(
      [
        bigVerifyEntry(1, "OLDEST-"),
        bigVerifyEntry(2, "SECOND-"),
        bigVerifyEntry(3, "THIRD-"),
        bigVerifyEntry(4, "FOURTH-"),
        bigVerifyEntry(5, "NEWEST-VERIFY-"),
        NEWEST_SELF_VERIFY,
      ].join("\n"),
    );

    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));
    const content = result.chunks[0]?.content ?? "";

    // The newest entries are the ones a retrying implementer needs.
    expect(content).toContain("Self-verify");
    expect(content).toContain("NEWEST-VERIFY-");
    // The oldest are what the ceiling should evict.
    expect(content).not.toContain("OLDEST-");
    expect(content.length).toBeLessThanOrEqual(500 * 4);
  });

  test("cuts on entry boundaries, leaving no half-rendered entry", async () => {
    mockNoIgnoreFile();
    // Five entries: comfortably past the 2000-char ceiling, so the fit loop
    // must actually drop some. Three would fit whole and pin nothing.
    mockScratchFile(
      [
        bigVerifyEntry(1, "OLDEST-"),
        bigVerifyEntry(2, "SECOND-"),
        bigVerifyEntry(3, "THIRD-"),
        bigVerifyEntry(4, "FOURTH-"),
        bigVerifyEntry(5, "NEWEST-"),
      ].join("\n"),
    );

    const provider = new SessionScratchProvider();
    const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));
    const content = result.chunks[0]?.content ?? "";

    // Every rendered verify entry opens a fenced block and must also close it.
    const fences = content.split("```").length - 1;
    expect(fences % 2).toBe(0);
    // Guard the guard: the fixture must actually have overflowed, or a
    // balanced-fence assertion proves nothing about the fit loop.
    expect(content).not.toContain("OLDEST-");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 SessionScratchProvider — tool-diagnostics filtering
//
// The `tool-diagnostics` scratch entry kind carries authoritative lint/typecheck
// provenance that the `ToolDiagnosticsProvider` and `query_scratch` consume. The
// push-style `SessionScratchProvider` must filter it OUT before its 20-entry
// recency cap so a flood of tool-diagnostics entries can't crowd out
// verify-result context for a rectifier.
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionScratchProvider — tool-diagnostics filtering", () => {
  beforeEach(() => {
    mockNoIgnoreFile();
  });

  describe("SessionScratchProvider — AC9: tool-diagnostics filtering", () => {
    test("AC9: scratch dir with one tool-diagnostics + one verify-result produces chunk that includes verify text and excludes the literal 'tool-diagnostics'", async () => {
      mockScratchFile(`${TOOL_DIAGNOSTICS_ENTRY}\n${VERIFY_ENTRY}\n`);

      const provider = new SessionScratchProvider();
      const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

      expect(result.chunks).toHaveLength(1);
      const content = result.chunks[0].content;
      expect(content).toContain("Verify");
      expect(content).toContain("FAIL");
      // The literal kind string must not leak into the rendered chunk.
      expect(content).not.toContain("tool-diagnostics");
    });
  });

  // AC10: 25 tool-diagnostics + 1 verify-result → verify text included
  // (pre-cap filtering — without it, the 20-entry cap would drop verify)
  describe("SessionScratchProvider — AC10: pre-cap filtering of tool-diagnostics", () => {
    test("AC10: 25 tool-diagnostics entries followed by one verify-result entry → output includes the verify text", async () => {
      const lines: string[] = [];
      for (let i = 0; i < 25; i++) {
        // Vary timestamp so each line is distinct
        lines.push(
          JSON.stringify({
            kind: "tool-diagnostics",
            timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
            storyId: "US-001",
            diagnostics: [{ file: `src/diag-${i}.ts`, line: 1, severity: "error", message: `m-${i}`, tool: "tsc" }],
          }),
        );
      }
      lines.push(VERIFY_ENTRY);
      mockScratchFile(`${lines.join("\n")}\n`);

      const provider = new SessionScratchProvider();
      const result = await provider.fetch(makeRequest({ storyScratchDirs: ["/sess/dir"] }));

      expect(result.chunks).toHaveLength(1);
      const content = result.chunks[0].content;
      // The verify entry sits at position 26 (index 25). Without pre-cap filtering
      // only the last 20 entries would be included — all tool-diagnostics — and
      // the verify text would be dropped. Pre-cap filtering must keep it.
      expect(content).toContain("Verify");
      expect(content).toContain("FAIL");
    });
  });
});

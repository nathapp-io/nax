/**
 * US-001 SessionScratchProvider — tool-diagnostics filtering
 *
 * The `tool-diagnostics` scratch entry kind carries authoritative
 * lint/typecheck provenance that the `ToolDiagnosticsProvider` and
 * `query_scratch` consume. The push-style `SessionScratchProvider` must
 * filter it OUT before its 20-entry recency cap so a flood of
 * tool-diagnostics entries can't crowd out verify-result context for a
 * rectifier.
 *
 * AC9 — chunk includes verify text and excludes the literal "tool-diagnostics"
 * AC10 — 25 tool-diagnostics entries + 1 verify-result entry → verify text
 *        still appears, proving pre-cap filtering.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _sessionScratchDeps, SessionScratchProvider } from "@/context/engine";
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
  _pathFilterDeps.fileExists = async () => false;
  _pathFilterDeps.readFile = async () => "";
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

// ─────────────────────────────────────────────────────────────────────────────
// AC9: tool-diagnostics + verify-result → verify text in, literal out
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// AC10: 25 tool-diagnostics + 1 verify-result → verify text included
// (pre-cap filtering — without it, the 20-entry cap would drop verify)
// ─────────────────────────────────────────────────────────────────────────────

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

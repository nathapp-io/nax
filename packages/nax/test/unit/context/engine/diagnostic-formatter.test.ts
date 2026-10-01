/**
 * Tests for the shared `formatDiagnostic` helper at
 * src/context/engine/diagnostic-formatter.ts.
 *
 * The helper was extracted from `ToolDiagnosticsProvider` and
 * `handleQueryScratch` to eliminate duplicate rendering of the same
 * `file:line:col [tool] (rule) — message` Markdown shape — see
 * docs/20260816-review-since-0.80.0-canary.3.md (ENH-5).
 *
 * Both consumers produce identical output for identical input; these
 * tests pin the contract so future divergence is caught.
 */

import { describe, expect, test } from "bun:test";
import { formatDiagnostic } from "@/context/engine";

describe("formatDiagnostic — shared helper (ENH-5)", () => {
  test("renders a fully-populated diagnostic with file, line, col, tool, rule", () => {
    const out = formatDiagnostic({
      file: "src/auth.ts",
      line: 12,
      column: 5,
      severity: "error",
      tool: "tsc",
      rule: "no-unused-vars",
      message: "Cannot find name 'foo'.",
    });
    expect(out).toBe("- **error** src/auth.ts:12:5 [tsc] (no-unused-vars) — Cannot find name 'foo'.");
  });

  test("renders a diagnostic with no rule (no parenthesised suffix)", () => {
    const out = formatDiagnostic({
      file: "src/a.ts",
      line: 1,
      severity: "warning",
      tool: "biome",
      message: "msg",
    });
    expect(out).toBe("- **warning** src/a.ts:1 [biome] — msg");
  });

  test("renders a diagnostic with no column (line only)", () => {
    const out = formatDiagnostic({
      file: "src/a.ts",
      line: 7,
      severity: "error",
      tool: "eslint",
      message: "msg",
    });
    expect(out).toBe("- **error** src/a.ts:7 [eslint] — msg");
  });

  test("renders a diagnostic with no file as '<unknown>'", () => {
    const out = formatDiagnostic({
      severity: "error",
      tool: "cargo",
      message: "msg",
    });
    expect(out).toBe("- **error** <unknown> [cargo] — msg");
  });

  test("defaults severity to 'error' when omitted", () => {
    const out = formatDiagnostic({
      file: "src/a.ts",
      tool: "go",
      message: "msg",
    });
    expect(out).toBe("- **error** src/a.ts [go] — msg");
  });

  test("handles a tool-diagnostics-shaped entry from query_scratch exactly", () => {
    // This is the exact shape produced by `tool-diagnostics` scratch entries
    // (`@/session.ToolDiagnosticsScratchEntry.diagnostics[number]`). The pull
    // path (handleQueryScratch) used to inline this rendering; the helper
    // must produce byte-identical output so push and pull look the same.
    const entry = {
      file: "src/x.ts",
      line: 3,
      column: 7,
      severity: "error" as const,
      tool: "biome",
      rule: "lint/some-rule",
      message: "details",
    };
    const fromProvider = formatDiagnostic(entry);
    expect(fromProvider).toContain("src/x.ts:3:7");
    expect(fromProvider).toContain("[biome]");
    expect(fromProvider).toContain("(lint/some-rule)");
    expect(fromProvider).toContain("— details");
  });
});

/**
 * Unit tests for src/quality/diagnostics.ts
 *
 * US-001 — Capture authoritative lint and typecheck diagnostics.
 * Mirrors acceptance criteria 1-6.
 */

import { describe, expect, test } from "bun:test";
import { detectTool, parseDiagnostics } from "@/quality";
import type { Diagnostic } from "@/quality/diagnostics";
import type { QualityCommandResult } from "@/quality/runner";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<QualityCommandResult> = {}): QualityCommandResult {
  return {
    commandName: "typecheck",
    command: "tsc --noEmit",
    success: true,
    exitCode: 0,
    output: "",
    durationMs: 0,
    timedOut: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: parseDiagnostics is importable and returns an array
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDiagnostics — AC1: importable and returns an array", () => {
  test("AC1: parseDiagnostics is a function importable from src/quality/diagnostics", () => {
    expect(typeof parseDiagnostics).toBe("function");
  });

  test("AC1: returns an array when called with successful QualityCommandResult and tool=tsc", async () => {
    const result = await parseDiagnostics(
      makeResult({ success: true, exitCode: 0, output: "" }),
      "tsc",
    );
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: tsc error parsing → one Diagnostic with file/line/severity
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDiagnostics — AC2: tsc error parsing", () => {
  test("AC2: tsc error for src/a.ts at line 12 returns one Diagnostic with file, line, severity", async () => {
    const output = "src/a.ts(12,5): error TS2304: Cannot find name 'foo'.";
    const result = await parseDiagnostics(
      makeResult({ success: false, exitCode: 2, output }),
      "tsc",
    );
    expect(result).toHaveLength(1);
    const [first] = result;
    expect(first.file).toBe("src/a.ts");
    expect(first.line).toBe(12);
    expect(first.severity).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: biome diagnostic → one Diagnostic with rule
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDiagnostics — AC3: biome diagnostic naming a rule", () => {
  test("AC3: returns one Diagnostic whose rule equals the rule name from the biome payload", async () => {
    const output = JSON.stringify({
      diagnostics: [
        {
          category: "lint/some-rule",
          severity: "error",
          description: "Some biome message",
          location: {
            path: { file: "src/x.ts" },
            span: { line: 1, column: 1 },
          },
        },
      ],
    });
    const result = await parseDiagnostics(
      makeResult({ success: false, exitCode: 1, output }),
      "biome",
    );
    expect(result).toHaveLength(1);
    const [first] = result;
    expect(first.rule).toBe("lint/some-rule");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: unknown-linter → one Diagnostic with non-empty message and tool
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDiagnostics — AC4: unknown-linter non-empty output", () => {
  test("AC4: unknown-linter non-empty output returns one Diagnostic with non-empty message and tool=unknown-linter", async () => {
    const output = "some error message from a tool we don't recognize";
    const result = await parseDiagnostics(
      makeResult({ success: false, exitCode: 1, output }),
      "unknown-linter",
    );
    expect(result).toHaveLength(1);
    const [first] = result;
    expect(first.message.length).toBeGreaterThan(0);
    expect(first.tool).toBe("unknown-linter");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: bounded tail limit
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDiagnostics — AC5: bounded tail limit for unknown-linter", () => {
  test("AC5: unknown-linter output longer than the bounded tail limit → message length does not exceed that limit", async () => {
    const output = "x".repeat(10_000);
    const result = await parseDiagnostics(
      makeResult({ success: false, exitCode: 1, output }),
      "unknown-linter",
    );
    expect(result).toHaveLength(1);
    const [first] = result;
    // The message should be a bounded tail — definitely not the full 10000 chars.
    expect(first.message.length).toBeLessThan(output.length);
    // The cap is a hard bound — any consistent limit ≤ MAX_RAW_TAIL_CHARS (or any
    // other reasonable constant the implementer picks) is acceptable. We assert
    // strictly less than the raw length AND ≤ 2000 (the documented bound).
    expect(first.message.length).toBeLessThanOrEqual(2_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: successful QualityCommandResult with empty output → empty array
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDiagnostics — AC6: successful with empty output", () => {
  test("AC6: successful QualityCommandResult with empty output returns empty array", async () => {
    const result = await parseDiagnostics(
      makeResult({ success: true, exitCode: 0, output: "" }),
      "tsc",
    );
    expect(result).toEqual([]);
  });

  test("AC6: successful QualityCommandResult with empty output returns empty array (biome tool too)", async () => {
    const result = await parseDiagnostics(
      makeResult({ success: true, exitCode: 0, output: "" }),
      "biome",
    );
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic type shape sanity (compile-time + runtime)
// ─────────────────────────────────────────────────────────────────────────────

describe("Diagnostic type shape", () => {
  test("Diagnostic interface exposes required fields", () => {
    const sample: Diagnostic = {
      file: "src/a.ts",
      line: 1,
      severity: "error",
      message: "msg",
      tool: "tsc",
    };
    expect(sample.file).toBe("src/a.ts");
    expect(sample.tool).toBe("tsc");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-4 regression — `\bgo\b` / `\bcargo\b` regexes mislabel script names
// containing "go"/"cargo" because `-` and `:` are word boundaries in regex.
// A lint script named `go-lint` or `lint:go` was labelled `tool: "go"`, a raw
// tail that the user then read as a Go toolchain failure. See
// docs/20260816-review-since-0.80.0-canary.3.md (BUG-4).
// ─────────────────────────────────────────────────────────────────────────────

describe("detectTool — BUG-4 regression: do not mislabel script names containing go/cargo", () => {
  test("does not label a `go-lint` script as 'go'", () => {
    // `bun run go-lint` → the script name contains `go` followed by `-`.
    // The previous `\bgo\b` regex matched at the `-` boundary and returned "go".
    expect(detectTool("bun run go-lint", "lint")).toBe("lint");
  });

  test("does not label a `lint:go` script as 'go'", () => {
    // `npm run lint:go` → the script name contains `:go`. The previous
    // `\bgo\b` regex matched at the `:` boundary and returned "go".
    expect(detectTool("npm run lint:go", "lint")).toBe("lint");
  });

  test("does not label a `cargo-build` script as 'cargo'", () => {
    expect(detectTool("bun run cargo-build", "lint")).toBe("lint");
  });

  test("does not label a `lint:cargo` script as 'cargo'", () => {
    expect(detectTool("npm run lint:cargo", "lint")).toBe("lint");
  });

  test("still labels an actual `go test` invocation as 'go'", () => {
    // Anchor to a known subcommand so a real `go build|test|run|vet|mod`
    // call is still labelled correctly.
    expect(detectTool("go test ./...", "lint")).toBe("go");
  });

  test("still labels an actual `cargo test` invocation as 'cargo'", () => {
    expect(detectTool("cargo test --workspace", "lint")).toBe("cargo");
  });
});

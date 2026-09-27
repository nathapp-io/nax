import { describe, expect, test } from "bun:test";
import { classifyAcceptanceCrash } from "@/test-runners";

const GO_MISSING_SYMBOL = "./acceptance_test.go:12:5: undefined: ParseConfig";
const GO_NO_FIELD = "./acceptance_test.go:9:14: cfg.Parse undefined (type *Config has no field or method Parse)";
const GO_SYNTAX_ERROR = "./acceptance_test.go:20:1: syntax error: unexpected }";

const RUST_E0425 = "error[E0425]: cannot find function `parse_config` in this scope";
const RUST_SUMMARY = 'error: could not compile `ex` (test "acceptance") due to 1 previous error';

describe("classifyAcceptanceCrash — Go", () => {
  test("AC1: returns expected-red when the only Go error line is undefined: <symbol>", () => {
    const output = `${GO_MISSING_SYMBOL}\nFAIL\texample.com/pkg [build failed]`;
    expect(classifyAcceptanceCrash(output, "go")).toBe("expected-red");
  });

  test("AC2: returns expected-red for a Go 'has no field or method' error", () => {
    expect(classifyAcceptanceCrash(GO_NO_FIELD, "go")).toBe("expected-red");
  });

  test("AC3: returns repairable when a missing symbol is joined by a syntax error", () => {
    const output = `${GO_MISSING_SYMBOL}\n${GO_SYNTAX_ERROR}`;
    expect(classifyAcceptanceCrash(output, "go")).toBe("repairable");
  });

  test("AC4: returns repairable for a Go panic with no <path>.go:<line>: error line", () => {
    expect(classifyAcceptanceCrash("panic: runtime error: invalid memory address", "go")).toBe("repairable");
  });

  test("AC13: returns repairable for undefined language even with Go-style missing-symbol output", () => {
    expect(classifyAcceptanceCrash(GO_MISSING_SYMBOL, undefined)).toBe("repairable");
  });

  test("treats the language case-insensitively", () => {
    expect(classifyAcceptanceCrash(GO_MISSING_SYMBOL, "GO")).toBe("expected-red");
    expect(classifyAcceptanceCrash(GO_MISSING_SYMBOL, "Go")).toBe("expected-red");
  });

  test("returns repairable when a Go error line carries a non-missing-symbol message", () => {
    const output = "./acceptance_test.go:31:9: cannot use limit (variable of type int) as string value";
    expect(classifyAcceptanceCrash(output, "go")).toBe("repairable");
  });

  test("returns repairable for empty output", () => {
    expect(classifyAcceptanceCrash("", "go")).toBe("repairable");
  });

  test("strips ANSI color codes before classifying (US-004 review fix)", () => {
    const colorized = `\x1b[31m${GO_MISSING_SYMBOL}\x1b[0m\n\x1b[31mFAIL\texample.com/pkg [build failed]\x1b[0m`;
    expect(classifyAcceptanceCrash(colorized, "go")).toBe("expected-red");
  });
});

describe("classifyAcceptanceCrash — Rust", () => {
  test("AC5: returns expected-red for a lone E0425 coded error despite the could-not-compile summary", () => {
    const output = `${RUST_E0425}\n${RUST_SUMMARY}`;
    expect(classifyAcceptanceCrash(output, "rust")).toBe("expected-red");
  });

  test.each([
    ["E0432", "error[E0432]: unresolved import `crate::config`"],
    ["E0433", "error[E0433]: failed to resolve: use of undeclared crate or module `foo`"],
    ["E0412", "error[E0412]: cannot find type `Config` in this scope"],
    ["E0599", "error[E0599]: no method named `parse` found for struct `Config`"],
  ])("AC6-AC9: returns expected-red when the only coded error line carries %s", (_code, line) => {
    expect(classifyAcceptanceCrash(line, "rust")).toBe("expected-red");
  });

  test("AC10: returns repairable for a coded error outside the missing-symbol set (E0308)", () => {
    expect(classifyAcceptanceCrash("error[E0308]: mismatched types", "rust")).toBe("repairable");
  });

  test("AC11: returns repairable for an uncoded syntax error line", () => {
    expect(classifyAcceptanceCrash("error: expected one of `;` or `}`, found `let`", "rust")).toBe("repairable");
  });

  test("treats the language case-insensitively", () => {
    expect(classifyAcceptanceCrash(RUST_E0425, "RUST")).toBe("expected-red");
    expect(classifyAcceptanceCrash(RUST_E0425, "Rust")).toBe("expected-red");
  });

  test("returns repairable when one coded error carries an allowed code and another does not", () => {
    const output = `${RUST_E0425}\nerror[E0308]: mismatched types`;
    expect(classifyAcceptanceCrash(output, "rust")).toBe("repairable");
  });

  test("returns repairable when only the ignored summary lines are present", () => {
    const output = `${RUST_SUMMARY}\nerror: aborting due to 1 previous error`;
    expect(classifyAcceptanceCrash(output, "rust")).toBe("repairable");
  });

  test("returns repairable for empty output", () => {
    expect(classifyAcceptanceCrash("", "rust")).toBe("repairable");
  });

  test("strips ANSI color codes before classifying (US-004 review fix)", () => {
    const colorized = `\x1b[31m${RUST_E0425}\x1b[0m\n\x1b[31m${RUST_SUMMARY}\x1b[0m`;
    expect(classifyAcceptanceCrash(colorized, "rust")).toBe("expected-red");
  });
});

describe("classifyAcceptanceCrash — other languages", () => {
  test("AC12: returns repairable for a TypeScript missing-module error", () => {
    expect(classifyAcceptanceCrash("error: Cannot find module '../src/new-module'", "typescript")).toBe("repairable");
  });

  test.each([
    ["python", "ModuleNotFoundError: No module named 'new_module'"],
    ["javascript", "Error: Cannot find module './new-module'"],
    ["", "error: Cannot find module 'x'"],
  ])("returns repairable for unsupported language %p", (language, output) => {
    expect(classifyAcceptanceCrash(output, language)).toBe("repairable");
  });
});

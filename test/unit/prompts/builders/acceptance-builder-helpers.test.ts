import { describe, expect, test } from "bun:test";
import { fenceLangFor, formatTestOutputForFix } from "../../../../src/prompts";

// ─── formatTestOutputForFix ───────────────────────────────────────────────────

describe("formatTestOutputForFix", () => {
  test("bun test output: structured failures extracted, (pass) lines excluded", () => {
    const raw = [
      "(pass) AC-1: should return empty array [1ms]",
      "(fail) AC-2: should handle edge case [2ms]",
      "  Error: Expected 0 but got 1",
      "",
      " 1 pass",
      " 1 fail",
    ].join("\n");

    const out = formatTestOutputForFix(raw);
    expect(out).toContain("AC-2");
    expect(out).toContain("Expected 0 but got 1");
    expect(out).not.toContain("(pass) AC-1");
  });

  test("result is significantly smaller than raw output with passing tests", () => {
    const passLines = Array.from({ length: 36 }, (_, i) => `(pass) AC-${i + 1}: test [1ms]`).join("\n");
    const failLine = "(fail) AC-37: broken test [2ms]\n  Error: nope";
    const raw = `${passLines}\n${failLine}\n\n 36 pass\n 1 fail`;

    const out = formatTestOutputForFix(raw);
    expect(out.length).toBeLessThan(raw.length);
    expect(out).toContain("AC-37");
    expect(out).not.toContain("(pass) AC-1");
  });

  test("unknown framework with failures falls back to tail lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    lines.push("FAILED: some test");
    lines.push("some_test.go:42: assertion failed");
    const raw = lines.join("\n");

    const out = formatTestOutputForFix(raw);
    expect(out).toContain("some_test.go:42");
    expect(out).not.toContain("line 0");
  });

  test("environmental failure (compile error, no tests ran)", () => {
    const raw = "error: cannot find module 'foo'\nat line 5\nBuild failed";
    const out = formatTestOutputForFix(raw);
    expect(out).toContain("environmental failure suspected");
  });

  test("output is bounded for very large raw input", () => {
    const raw = "x".repeat(500_000);
    const out = formatTestOutputForFix(raw);
    expect(out.length).toBeLessThan(10_000);
  });

  test("all tests passed (unexpected call to fix path) returns only header", () => {
    const raw = "(pass) AC-1: ok [1ms]\n(pass) AC-2: ok [1ms]\n\n 2 pass\n 0 fail";
    const out = formatTestOutputForFix(raw);
    expect(out).toContain("2 passed");
    expect(out).toContain("0 failed");
    expect(out).not.toContain("Failures:");
  });
});

// ─── fenceLangFor ─────────────────────────────────────────────────────────────

describe("fenceLangFor", () => {
  test.each([
    [".nax-acceptance.test.ts", "typescript"],
    ["foo_test.go", "go"],
    ["test_foo.py", "python"],
    ["some_spec.rs", "rust"],
    ["Module.java", "java"],
    ["Main.kt", "kotlin"],
    ["app.rb", "ruby"],
    ["weird.unknown", ""],
    [undefined, ""],
  ])("fenceLangFor(%s) → %s", (input, expected) => {
    expect(fenceLangFor(input as string | undefined)).toBe(expected);
  });
});

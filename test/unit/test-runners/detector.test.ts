/**
 * Tests for test framework detector utilities.
 */

import { describe, expect, test } from "bun:test";
import { buildTestFrameworkHint } from "../../../src/test-runners/detector";

describe("buildTestFrameworkHint", () => {
  test("returns Bun hint for empty command", () => {
    expect(buildTestFrameworkHint("")).toBe("Use Bun test (describe/test/expect)");
  });

  test("returns Bun hint for bun test command", () => {
    expect(buildTestFrameworkHint("bun test")).toBe("Use Bun test (describe/test/expect)");
    expect(buildTestFrameworkHint("bun test test/unit/")).toBe("Use Bun test (describe/test/expect)");
  });

  test("returns pytest hint", () => {
    expect(buildTestFrameworkHint("pytest")).toBe("Use pytest");
    expect(buildTestFrameworkHint("pytest -x src/")).toBe("Use pytest");
    expect(buildTestFrameworkHint("python -m pytest")).toBe("Use pytest");
  });

  test("returns cargo test hint", () => {
    expect(buildTestFrameworkHint("cargo test")).toBe("Use Rust's cargo test");
  });

  test("returns go test hint", () => {
    expect(buildTestFrameworkHint("go test ./...")).toBe("Use Go's testing package");
  });

  test("returns vitest hint", () => {
    expect(buildTestFrameworkHint("npx vitest")).toBe("Use Vitest (describe/test/expect)");
    expect(buildTestFrameworkHint("vitest run")).toBe("Use Vitest (describe/test/expect)");
  });

  test("returns jest hint for jest commands", () => {
    expect(buildTestFrameworkHint("npx jest")).toBe("Use Jest (describe/test/expect)");
    expect(buildTestFrameworkHint("npm test")).toBe("Use Jest (describe/test/expect)");
    expect(buildTestFrameworkHint("yarn test")).toBe("Use Jest (describe/test/expect)");
  });

  test("returns generic hint for unknown commands", () => {
    expect(buildTestFrameworkHint("ruby -Itest test/all.rb")).toBe("Use your project's test framework");
    expect(buildTestFrameworkHint("dotnet test")).toBe("Use your project's test framework");
  });

  test("trims leading/trailing whitespace before matching", () => {
    expect(buildTestFrameworkHint("  pytest -v  ")).toBe("Use pytest");
    expect(buildTestFrameworkHint("  go test ./...  ")).toBe("Use Go's testing package");
  });
});

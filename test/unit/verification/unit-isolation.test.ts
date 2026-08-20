// RE-ARCH: keep
/**
 * Tests for src/tdd/isolation.ts
 *
 * Covers: isTestFile, isSourceFile, matchesAllowedPath (via verify functions)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  _isolationDeps,
  LITE_STUB_ADDED_LINES_CEILING,
  isSourceFile,
  verifyTestWriterIsolation,
} from "@/tdd/isolation";
import { isTestFile } from "@/test-runners";

// ─────────────────────────────────────────────────────────────────────────────
// isTestFile
// ─────────────────────────────────────────────────────────────────────────────

describe("isTestFile", () => {
  it("detects test/ directory files", () => {
    expect(isTestFile("test/unit/foo.ts")).toBe(true);
    expect(isTestFile("test/integration/bar.test.ts")).toBe(true);
    expect(isTestFile("test/fixtures/data.json")).toBe(true);
  });

  it("detects tests/ directory files", () => {
    expect(isTestFile("tests/unit/foo.ts")).toBe(true);
    expect(isTestFile("tests/integration/bar.test.ts")).toBe(true);
  });

  it("detects __tests__/ directory files", () => {
    expect(isTestFile("__tests__/unit/foo.ts")).toBe(true);
    expect(isTestFile("src/__tests__/foo.test.ts")).toBe(true);
  });

  it("detects .spec extension", () => {
    expect(isTestFile("src/foo.spec.ts")).toBe(true);
    expect(isTestFile("src/utils/bar.spec.js")).toBe(true);
    expect(isTestFile("lib/baz.spec.tsx")).toBe(true);
  });

  it("detects .test extension", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("src/utils/bar.test.js")).toBe(true);
    expect(isTestFile("lib/baz.test.tsx")).toBe(true);
  });

  it("detects .e2e-spec extension (NestJS convention)", () => {
    expect(isTestFile("src/app.e2e-spec.ts")).toBe(true);
    expect(isTestFile("test/e2e/auth.e2e-spec.ts")).toBe(true);
  });

  it("returns false for source files", () => {
    expect(isTestFile("src/index.ts")).toBe(false);
    expect(isTestFile("lib/utils.ts")).toBe(false);
    expect(isTestFile("packages/core/foo.ts")).toBe(false);
  });

  it("returns false for config/doc files", () => {
    expect(isTestFile("package.json")).toBe(false);
    expect(isTestFile("README.md")).toBe(false);
    expect(isTestFile("tsconfig.json")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSourceFile
// ─────────────────────────────────────────────────────────────────────────────

describe("isSourceFile", () => {
  it("detects src/ directory files", () => {
    expect(isSourceFile("src/index.ts")).toBe(true);
    expect(isSourceFile("src/utils/foo.ts")).toBe(true);
    expect(isSourceFile("src/components/Bar.tsx")).toBe(true);
  });

  it("detects lib/ directory files", () => {
    expect(isSourceFile("lib/index.ts")).toBe(true);
    expect(isSourceFile("lib/utils/foo.ts")).toBe(true);
  });

  it("detects packages/ directory files (monorepo)", () => {
    expect(isSourceFile("packages/core/index.ts")).toBe(true);
    expect(isSourceFile("packages/utils/foo.ts")).toBe(true);
  });

  it("returns false for test files", () => {
    expect(isSourceFile("test/unit/foo.test.ts")).toBe(false);
    expect(isSourceFile("tests/integration/bar.test.ts")).toBe(false);
    expect(isSourceFile("__tests__/baz.ts")).toBe(false);
  });

  it("returns false for config/doc files", () => {
    expect(isSourceFile("package.json")).toBe(false);
    expect(isSourceFile("README.md")).toBe(false);
    expect(isSourceFile("tsconfig.json")).toBe(false);
  });

  it("returns false for root files", () => {
    expect(isSourceFile("index.ts")).toBe(false);
    expect(isSourceFile("utils.ts")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined behavior tests
// ─────────────────────────────────────────────────────────────────────────────

describe("combined isTestFile + isSourceFile", () => {
  it("test files in src/ are detected as both test and source", () => {
    const file = "src/foo.test.ts";
    expect(isTestFile(file)).toBe(true);
    expect(isSourceFile(file)).toBe(true);
  });

  it("spec files in src/ are detected as both test and source", () => {
    const file = "src/foo.spec.ts";
    expect(isTestFile(file)).toBe(true);
    expect(isSourceFile(file)).toBe(true);
  });

  it("regular src/ files are source but not test", () => {
    const file = "src/foo.ts";
    expect(isTestFile(file)).toBe(false);
    expect(isSourceFile(file)).toBe(true);
  });

  it("test/ directory files are test but not source (default)", () => {
    const file = "test/foo.ts";
    expect(isTestFile(file)).toBe(true);
    expect(isSourceFile(file)).toBe(false);
  });

  it("config files are neither test nor source", () => {
    const file = "package.json";
    expect(isTestFile(file)).toBe(false);
    expect(isSourceFile(file)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyTestWriterIsolation — strict vs. lite
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyTestWriterIsolation: strict vs. lite mode", () => {
  let origSpawn: typeof _isolationDeps.spawn;

  beforeEach(() => {
    origSpawn = _isolationDeps.spawn;
  });
  afterEach(() => {
    _isolationDeps.spawn = origSpawn;
  });

  // mockSpawn maps the arg list to a string payload so getChangedFiles and
  // getAddedLinesPerFile (numstat) can be answered with different shapes.
  function mockSpawn(handler: (args: string[]) => string): void {
    _isolationDeps.spawn = mock((args: string[]) => {
      const payload = handler(args);
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof _isolationDeps.spawn;
  }

  it("strict: src/ writes outside allowedPaths are HARD violations", async () => {
    mockSpawn((args) => {
      if (args.includes("--name-only")) return "packages/foo/src/foo.py\n";
      return "10\t0\tpackages/foo/src/foo.py\n";
    });
    const result = await verifyTestWriterIsolation(
      "/tmp",
      "HEAD",
      ["packages/*/tests/**"],
      ["**/test_*.py"],
      "strict",
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain("packages/foo/src/foo.py");
    expect(result.softViolations ?? []).not.toContain("packages/foo/src/foo.py");
  });

  it("lite: stub-sized src/ writes (≤ ceiling) become SOFT violations", async () => {
    const added = LITE_STUB_ADDED_LINES_CEILING; // exactly at the ceiling — allowed
    mockSpawn((args) => {
      if (args.includes("--name-only")) return "packages/foo/src/__init__.py\n";
      return `${added}\t0\tpackages/foo/src/__init__.py\n`;
    });
    const result = await verifyTestWriterIsolation(
      "/tmp",
      "HEAD",
      ["packages/*/tests/**"],
      ["**/test_*.py"],
      "lite",
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.softViolations).toContain("packages/foo/src/__init__.py");
  });

  it("lite: src/ writes exceeding the ceiling stay HARD violations", async () => {
    const added = LITE_STUB_ADDED_LINES_CEILING + 1;
    mockSpawn((args) => {
      if (args.includes("--name-only")) return "packages/foo/src/big.py\n";
      return `${added}\t0\tpackages/foo/src/big.py\n`;
    });
    const result = await verifyTestWriterIsolation(
      "/tmp",
      "HEAD",
      ["packages/*/tests/**"],
      ["**/test_*.py"],
      "lite",
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain("packages/foo/src/big.py");
  });

  it("lite: explicit allowedPaths still take priority over the line-count heuristic", async () => {
    mockSpawn((args) => {
      if (args.includes("--name-only")) return "src/index.ts\n";
      return "999\t0\tsrc/index.ts\n";
    });
    const result = await verifyTestWriterIsolation(
      "/tmp",
      "HEAD",
      ["src/index.ts"],
      ["**/*.test.ts"],
      "lite",
    );
    expect(result.passed).toBe(true);
    expect(result.softViolations).toContain("src/index.ts");
  });
});

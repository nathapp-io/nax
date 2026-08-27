/**
 * Unit tests for `nax prompts --export <role>` command (PT-003)
 *
 * Tests the exportPromptCommand function which dumps the full default prompt
 * for a given role to stdout or a file, using a stub story and empty context.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { exportPromptCommand } from "@/cli/prompts";

const VALID_ROLES = ["test-writer", "implementer", "verifier", "single-session", "tdd-simple"] as const;

describe("exportPromptCommand — stdout mode", () => {
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    consoleOutput = [];
    originalConsoleLog = console.log;
    originalProcessExit = process.exit;

    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    // Prevent process.exit from killing the test runner
    process.exit = mock((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("all valid roles print non-empty output to stdout", async () => {
    for (const role of VALID_ROLES) {
      consoleOutput.length = 0;
      await exportPromptCommand({ role });
      expect(consoleOutput.join("\n").length, `role: ${role}`).toBeGreaterThan(0);
    }
  });

  test("test-writer output contains isolation, story context, and conventions; tdd-simple has isolation; output is substantial and contains EXAMPLE", async () => {
    await exportPromptCommand({ role: "test-writer" });
    const out = consoleOutput.join("\n");
    const outLower = out.toLowerCase();
    expect(outLower).toMatch(/isolation/);
    const hasStoryContent =
      outLower.includes("story") ||
      outLower.includes("acceptance criteria") ||
      outLower.includes("example") ||
      outLower.includes("ac-1");
    expect(hasStoryContent).toBe(true);
    expect(outLower).toMatch(/convention/);
    expect(out.length).toBeGreaterThan(500);
    expect(out).toContain("EXAMPLE");

    consoleOutput.length = 0;
    await exportPromptCommand({ role: "tdd-simple" });
    expect(consoleOutput.join("\n").toLowerCase()).toMatch(/isolation/);
  });
});

describe("exportPromptCommand — file output mode (--out)", () => {
  let tempDir: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    tempDir = makeTempDir("nax-export-test-");
    consoleOutput = [];
    originalConsoleLog = console.log;
    originalProcessExit = process.exit;

    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    process.exit = mock((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    process.exit = originalProcessExit;
    mock.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes non-empty file with isolation section; prints [OK] with path; stdout is brief vs file", async () => {
    const outPath = join(tempDir, "dump.md");
    await exportPromptCommand({ role: "test-writer", out: outPath });

    expect(existsSync(outPath)).toBe(true);
    const content = await Bun.file(outPath).text();
    expect(content.length).toBeGreaterThan(0);
    expect(content.toLowerCase()).toMatch(/isolation/);
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toMatch(/\[OK\].*[Ee]xport/);
    expect(allOutput).toContain("dump.md");

    consoleOutput.length = 0;
    const tddPath = join(tempDir, "tdd-simple-export.md");
    await exportPromptCommand({ role: "tdd-simple", out: tddPath });
    const tddContent = await Bun.file(tddPath).text();
    expect(consoleOutput.join("\n").length).toBeLessThan(tddContent.length);
    expect(tddContent.length).toBeGreaterThan(500);
  });
});

describe("exportPromptCommand — invalid role", () => {
  let consoleOutput: string[];
  let consoleErrors: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    consoleOutput = [];
    consoleErrors = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;

    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(" "));
    };
    process.exit = mock((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("exits with code 1 for unknown-role, empty role, and misspelled role", async () => {
    for (const role of ["unknown-role", "", "test-write"]) {
      let exitCode: number | undefined;
      process.exit = mock((code?: number) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit;
      try {
        await exportPromptCommand({ role });
        expect(true).toBe(false);
      } catch {}
      expect(exitCode, `role: "${role}"`).toBe(1);
    }
  });

  test("error output for unknown-role mentions invalid/unknown and lists all valid roles", async () => {
    try {
      await exportPromptCommand({ role: "unknown-role" });
    } catch {}

    const allOutput = [...consoleOutput, ...consoleErrors].join("\n");
    const hasError = allOutput.toLowerCase().match(/error|invalid|unknown/);
    expect(hasError).toBeTruthy();
    for (const role of VALID_ROLES) {
      expect(allOutput).toContain(role);
    }
  });
});

describe("exportPromptCommand — all valid roles produce complete prompts", () => {
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    originalProcessExit = process.exit;
    process.exit = mock((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    mock.restore();
  });

  for (const role of VALID_ROLES) {
    test(`${role} prompt contains isolation and conventions sections`, async () => {
      const outLines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        outLines.push(args.map((a) => String(a)).join(" "));
      };

      try {
        await exportPromptCommand({ role });
      } finally {
        console.log = originalLog;
      }

      const output = outLines.join("\n").toLowerCase();
      expect(output).toMatch(/isolation/);
      expect(output).toMatch(/convention/);
    });
  }
});

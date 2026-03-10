/**
 * Unit tests for `nax prompts --export <role>` command (PT-003)
 *
 * Tests the exportPromptCommand function which dumps the full default prompt
 * for a given role to stdout or a file, using a stub story and empty context.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { exportPromptCommand } from "../../../src/cli/prompts";

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
    }) as never;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("exports test-writer role and prints non-empty output to stdout", async () => {
    await exportPromptCommand({ role: "test-writer" });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput.length).toBeGreaterThan(0);
  });

  test("exports tdd-simple role and prints non-empty output to stdout", async () => {
    await exportPromptCommand({ role: "tdd-simple" });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput.length).toBeGreaterThan(0);
  });

  test("exports implementer role and prints non-empty output to stdout", async () => {
    await exportPromptCommand({ role: "implementer" });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput.length).toBeGreaterThan(0);
  });

  test("exports verifier role and prints non-empty output to stdout", async () => {
    await exportPromptCommand({ role: "verifier" });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput.length).toBeGreaterThan(0);
  });

  test("exports single-session role and prints non-empty output to stdout", async () => {
    await exportPromptCommand({ role: "single-session" });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput.length).toBeGreaterThan(0);
  });

  test("output for test-writer contains isolation section", async () => {
    await exportPromptCommand({ role: "test-writer" });

    const allOutput = consoleOutput.join("\n").toLowerCase();
    expect(allOutput).toMatch(/isolation/);
  });

  test("output for test-writer contains story context section", async () => {
    await exportPromptCommand({ role: "test-writer" });

    const allOutput = consoleOutput.join("\n").toLowerCase();
    // Story section should mention the story or acceptance criteria
    const hasStoryContent =
      allOutput.includes("story") ||
      allOutput.includes("acceptance criteria") ||
      allOutput.includes("example") ||
      allOutput.includes("ac-1");
    expect(hasStoryContent).toBe(true);
  });

  test("output for test-writer contains conventions section", async () => {
    await exportPromptCommand({ role: "test-writer" });

    const allOutput = consoleOutput.join("\n").toLowerCase();
    expect(allOutput).toMatch(/convention/);
  });

  test("output for tdd-simple contains isolation section", async () => {
    await exportPromptCommand({ role: "tdd-simple" });

    const allOutput = consoleOutput.join("\n").toLowerCase();
    expect(allOutput).toMatch(/isolation/);
  });

  test("output is substantially long (not a stub)", async () => {
    await exportPromptCommand({ role: "test-writer" });

    const allOutput = consoleOutput.join("\n");
    // A real prompt with all sections should be at least 500 chars
    expect(allOutput.length).toBeGreaterThan(500);
  });

  test("stub story id EXAMPLE appears in output", async () => {
    await exportPromptCommand({ role: "test-writer" });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("EXAMPLE");
  });
});

describe("exportPromptCommand — file output mode (--out)", () => {
  let tempDir: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-export-test-"));
    consoleOutput = [];
    originalConsoleLog = console.log;
    originalProcessExit = process.exit;

    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    process.exit = mock((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    }) as never;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    process.exit = originalProcessExit;
    mock.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes prompt to file when --out is provided", async () => {
    const outPath = join(tempDir, "dump.md");

    await exportPromptCommand({ role: "test-writer", out: outPath });

    expect(existsSync(outPath)).toBe(true);
  });

  test("written file contains non-empty prompt content", async () => {
    const outPath = join(tempDir, "dump.md");

    await exportPromptCommand({ role: "test-writer", out: outPath });

    const content = await Bun.file(outPath).text();
    expect(content.length).toBeGreaterThan(0);
  });

  test("written file contains isolation section", async () => {
    const outPath = join(tempDir, "dump.md");

    await exportPromptCommand({ role: "test-writer", out: outPath });

    const content = await Bun.file(outPath).text();
    expect(content.toLowerCase()).toMatch(/isolation/);
  });

  test("prints [OK] Exported message after writing file", async () => {
    const outPath = join(tempDir, "dump.md");

    await exportPromptCommand({ role: "test-writer", out: outPath });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toMatch(/\[OK\].*[Ee]xport/);
  });

  test("printed [OK] message mentions the output file path", async () => {
    const outPath = join(tempDir, "dump.md");

    await exportPromptCommand({ role: "test-writer", out: outPath });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("dump.md");
  });

  test("does NOT print prompt to stdout when --out is provided", async () => {
    const outPath = join(tempDir, "dump.md");

    await exportPromptCommand({ role: "tdd-simple", out: outPath });

    // stdout should only have the [OK] confirmation, not the full prompt
    const allOutput = consoleOutput.join("\n");
    // The full prompt is in the file; stdout should be brief
    const fileContent = await Bun.file(outPath).text();
    // stdout should be much shorter than the file content
    expect(allOutput.length).toBeLessThan(fileContent.length);
  });

  test("writes tdd-simple prompt to file correctly", async () => {
    const outPath = join(tempDir, "tdd-simple-export.md");

    await exportPromptCommand({ role: "tdd-simple", out: outPath });

    const content = await Bun.file(outPath).text();
    expect(content.length).toBeGreaterThan(500);
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
    }) as never;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    mock.restore();
  });

  test("exits with code 1 for unknown-role", async () => {
    let exitCode: number | undefined;
    process.exit = mock((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    try {
      await exportPromptCommand({ role: "unknown-role" });
      expect(true).toBe(false); // should not reach here
    } catch {
      // expected
    }
    expect(exitCode).toBe(1);
  });

  test("prints error message for unknown-role", async () => {
    try {
      await exportPromptCommand({ role: "unknown-role" });
    } catch {
      // expected
    }

    const allOutput = [...consoleOutput, ...consoleErrors].join("\n").toLowerCase();
    const hasError = allOutput.includes("error") || allOutput.includes("invalid") || allOutput.includes("unknown");
    expect(hasError).toBe(true);
  });

  test("error message lists all valid roles", async () => {
    try {
      await exportPromptCommand({ role: "unknown-role" });
    } catch {
      // expected
    }

    const allOutput = [...consoleOutput, ...consoleErrors].join("\n");
    for (const role of VALID_ROLES) {
      expect(allOutput).toContain(role);
    }
  });

  test("exits with code 1 for empty string role", async () => {
    let exitCode: number | undefined;
    process.exit = mock((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    try {
      await exportPromptCommand({ role: "" });
      expect(true).toBe(false); // should not reach here
    } catch {
      // expected
    }
    expect(exitCode).toBe(1);
  });

  test("exits with code 1 for misspelled role", async () => {
    let exitCode: number | undefined;
    process.exit = mock((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    try {
      await exportPromptCommand({ role: "test-write" });
      expect(true).toBe(false); // should not reach here
    } catch {
      // expected
    }
    expect(exitCode).toBe(1);
  });
});

describe("exportPromptCommand — all valid roles produce complete prompts", () => {
  let originalProcessExit: typeof process.exit;

  beforeEach(() => {
    originalProcessExit = process.exit;
    process.exit = mock((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    }) as never;
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    mock.restore();
  });

  for (const role of VALID_ROLES) {
    test(`${role} prompt contains isolation section`, async () => {
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
    });

    test(`${role} prompt contains conventions section`, async () => {
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
      expect(output).toMatch(/convention/);
    });
  }
});

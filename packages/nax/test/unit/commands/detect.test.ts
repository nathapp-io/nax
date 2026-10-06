/**
 * `src/commands/detect.ts` was invisible to the coverage gate (#2329): the
 * command is wired in bin/nax.ts, which the gated suites never execute. These
 * tests run `detectCommand` in-process against fixture trees.
 *
 * Fixture contract (probed 2026-10-07): resolveProject demands
 * `.nax/config.json`; tier-1 detection needs a literal
 * `test: { include: [...] }` in vitest.config.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { detectCommand } from "@/commands/detect";
import { resetLogger } from "@/logger";

describe("detectCommand", () => {
  let dir = "";
  let logs: string[] = [];
  let logSpy: ReturnType<typeof spyOn> | undefined;
  let prevExitCode = 0;

  beforeEach(() => {
    // detectCommand calls initLogger(), which throws on an existing singleton.
    resetLogger();
  });

  afterEach(() => {
    logSpy?.mockRestore();
    logSpy = undefined;
    process.exitCode = prevExitCode;
    if (dir) cleanupTempDir(dir);
    dir = "";
  });

  function startCapture(): string[] {
    logs = [];
    prevExitCode = process.exitCode ?? 0;
    logSpy = spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    return logs;
  }

  function seedProject(): void {
    dir = makeTempDir("detect-cmd-");
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), "{}\n");
  }

  test("--json reports tier-1 patterns and exits 0", async () => {
    seedProject();
    writeFileSync(
      join(dir, "vitest.config.ts"),
      'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n',
    );
    const out = startCapture();
    await detectCommand({ json: true, dir });
    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as {
      workdir: string;
      root: { detected: { patterns: readonly string[]; confidence: string } };
    };
    // macOS tmpdir() is `/var/folders/...` while its realpath is
    // `/private/var/folders/...` — resolveProject realpaths the dir, so
    // compare against the realpath (same convention as resume-log-filename.test.ts).
    expect(parsed.workdir).toBe(realpathSync(dir));
    expect(parsed.root.detected.confidence).toBe("high");
    expect(parsed.root.detected.patterns).toContain("tests/**/*.test.ts");
  });

  test("--json exits 1 when detection finds no signals", async () => {
    seedProject();
    const out = startCapture();
    await detectCommand({ json: true, dir });
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(out.join("\n")) as { root: { detected: { confidence: string } } };
    expect(parsed.root.detected.confidence).toBe("empty");
  });
});

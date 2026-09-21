import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeNaxConfig } from "@test/helpers";
import { _unlockDeps, unlockCommand } from "@/commands/unlock";
import { collectFromMetrics } from "@/plugins/builtin/curator/collect";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator/types";
import { isSameProject } from "@/runtime";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function curatorContext(outputDir: string, warnings: Array<{ message: string; data?: Record<string, unknown> }>): CuratorPostRunContext {
  return {
    runId: "current-run",
    feature: "current-feature",
    workdir: outputDir,
    prdPath: join(outputDir, "prd.json"),
    branch: "main",
    totalDurationMs: 0,
    totalCost: 0,
    storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "test",
    pluginConfig: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message, data) => warnings.push({ message, data }),
      error: () => {},
    },
    config: makeNaxConfig(),
    outputDir,
    globalDir: join(outputDir, "global"),
    projectKey: "project-under-test",
    curatorRollupPath: join(outputDir, "rollup.jsonl"),
  };
}

describe("project-identity-run-locking acceptance", () => {
  test("AC-1: missing feature lock reports its path and leaves checkout lock untouched", async () => {
    const workdir = temporaryDirectory("nax-unlock-workdir-");
    const outputDir = temporaryDirectory("nax-unlock-output-");
    const feature = "unknown-feature";
    const checkoutLockPath = join(workdir, "nax.lock");
    const checkoutLock = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
    writeFileSync(checkoutLockPath, checkoutLock);

    const savedDeps = { ..._unlockDeps };
    const originalLog = console.log;
    const originalError = console.error;
    const originalExit = process.exit;
    const output: string[] = [];
    let exitCode: number | undefined;
    try {
      _unlockDeps.findProjectDir = () => join(workdir, ".nax");
      _unlockDeps.loadConfig = async () => makeNaxConfig({ name: "project-under-test" });
      _unlockDeps.projectOutputDir = () => outputDir;
      console.log = (...values: unknown[]) => output.push(values.join(" "));
      console.error = (...values: unknown[]) => output.push(values.join(" "));
      process.exit = ((code?: number): never => {
        exitCode = code ?? 0;
        throw new ExitSignal(exitCode);
      }) as typeof process.exit;

      try {
        await unlockCommand({ dir: workdir, feature });
      } catch (error) {
        if (!(error instanceof ExitSignal)) throw error;
      }

      const missingLockPath = join(outputDir, "features", feature, "nax.lock");
      expect(exitCode).toBe(0);
      expect(output.join("\n")).toContain(missingLockPath);
      expect(output.join("\n")).toContain(feature);
      expect(output.join("\n")).toContain("nax.lock");
      expect(existsSync(checkoutLockPath)).toBe(true);
      await expect(Bun.file(checkoutLockPath).text()).resolves.toBe(checkoutLock);
    } finally {
      Object.assign(_unlockDeps, savedDeps);
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
    }
  });

  test("AC-2: ssh URL with a port does not match scp-style URL", () => {
    expect(isSameProject("ssh://git@host:2222/o/r", "host:o/r")).toBe(false);
  });

  test("AC-3: missing metrics file warns and produces no observations", async () => {
    const outputDir = temporaryDirectory("nax-curator-missing-metrics-");
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];

    const observations = await collectFromMetrics(curatorContext(outputDir, warnings));

    expect(observations).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("metrics.json");
  });

  test("AC-4: invalid metrics JSON warns and produces no observations", async () => {
    const outputDir = temporaryDirectory("nax-curator-corrupt-metrics-");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "metrics.json"), '[{"runId":"prior-run","stories":[{"storyId":"US-001","success":true}]');
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];

    const observations = await collectFromMetrics(curatorContext(outputDir, warnings));

    expect(observations).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("metrics.json");
    expect(warnings[0]?.message.toLowerCase()).toMatch(/parse|invalid|malformed|read/);
  });
});
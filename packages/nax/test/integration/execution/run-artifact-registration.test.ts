/**
 * US-003 — registry metadata records the actual log basename and the run start instant.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir, waitForFile } from "@test/helpers";
import { globalConfigDir } from "@/config/paths";
import { buildRunId } from "@/execution/run-id";
import { resetLogger } from "@/logger";
import { PipelineEventBus } from "@/pipeline/event-bus";
import { type MetaJson, wireRegistry } from "@/pipeline/subscribers/registry";
// biome-ignore lint/style/noRestrictedImports: CLI entry helpers live in bin/, outside the @/ source alias.
import { initRunLogging } from "../../../bin/run-action";

describe("registry metadata for a run", () => {
  let out: string;
  let metaFile: string;
  const runId = "run-reg-1";
  beforeEach(() => {
    out = makeTempDir("run-artifact-reg-");
    metaFile = join(globalConfigDir(), "runs", `${out.split("/").pop()}-feat-${runId}`, "meta.json");
  });
  afterEach(async () => {
    await rm(join(metaFile, ".."), { recursive: true, force: true });
    cleanupTempDir(out);
  });

  test("AC-2/AC-13: logFileName is only the basename; registeredAt is the start instant, not delivery time", async () => {
    const bus = new PipelineEventBus();
    const startTime = Date.parse("2020-05-05T05:05:05.005Z");
    const logFilePath = join(out, "features", "feat", "runs", "custom-name.jsonl");
    wireRegistry(bus, "feat", runId, out, out, { logFilePath, startTime });
    bus.emit({ type: "run:started", feature: "feat", totalStories: 1, workdir: out });
    await waitForFile(metaFile, 1000);
    const meta: MetaJson = JSON.parse(await readFile(metaFile, "utf8"));
    expect(meta.logFileName).toBe("custom-name.jsonl");
    expect(meta.registeredAt).toBe("2020-05-05T05:05:05.005Z");
  });

  test("AC-1: initRunLogging names the log by buildRunId of the workdir and logger-setup instant", () => {
    const setup = new Date("2026-11-28T10:00:00.123Z");
    setSystemTime(setup);
    try {
      resetLogger();
      const r = initRunLogging({
        options: { feature: "feat", headless: true, dryRun: false, dir: out },
        config: makeNaxConfig({ outputDir: out }),
        workdir: out,
        isTTY: false,
        logLevel: "info",
        formatterMode: "normal",
      });
      expect(r.runId).toBe(buildRunId(out, setup));
      expect(r.logFilePath.endsWith(`${r.runId}.jsonl`)).toBe(true);
      expect(r.runId).toMatch(/\.123$/);
    } finally {
      setSystemTime();
      resetLogger();
    }
  });
});

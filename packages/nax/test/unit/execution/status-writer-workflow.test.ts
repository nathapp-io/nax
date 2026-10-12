import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { StatusWriter } from "@/execution";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("nax-status-writer-workflow-");
});
afterEach(() => cleanupTempDir(dir));

function writer(): StatusWriter {
  return new StatusWriter(join(dir, "status.json"), DEFAULT_CONFIG, {
    runId: "r1",
    feature: "f",
    startedAt: new Date().toISOString(),
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
}

describe("StatusWriter — workflow block (spec §9)", () => {
  test("absent unless set; set -> written to status.json", async () => {
    const w = writer();
    w.setPrd(makePRD());
    await w.update(0, 1);
    expect((await Bun.file(join(dir, "status.json")).json()).workflow).toBeUndefined();
    const block = { step: "publish", stories: { "US-001": { state: "complete", round: 1 } }, outcome: "draft" };
    w.setWorkflowStatus(block);
    await w.update(0, 1);
    expect((await Bun.file(join(dir, "status.json")).json()).workflow).toEqual(block);
  });
});

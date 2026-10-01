/**
 * Unit tests for StatusWriter live-cost retention (#2006 companion fix).
 *
 * The crash handlers read the runner's `getTotalCost()` — which used to read a
 * local assigned only after the whole execution phase returned, so a
 * SIGINT-terminated run wrote `run.complete` with `totalCost: 0` even after a
 * story had spent real money. The status writer receives the reconciled run
 * total at every boundary (`update(totalCost, iterations)`), so it retains the
 * latest value for the runner's getter to fall back on.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTempDir } from "@test/helpers";
import { StatusWriter } from "@/execution/status-writer";

function makeWriter(): StatusWriter {
  const workdir = makeTempDir("nax-test-status-writer-live-cost-");
  const writer = new StatusWriter(`${workdir}/status.json`, makeNaxConfig(), {
    runId: "run-live-cost-test",
    feature: "live-cost-feature",
    startedAt: new Date().toISOString(),
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
  return writer;
}

describe("StatusWriter.lastTotalCost — #2006 live run cost for the crash path", () => {
  test("starts at zero", () => {
    const writer = makeWriter();
    expect(writer.lastTotalCost).toBe(0);
  });

  test("retains the most recent update() total", async () => {
    const writer = makeWriter();
    // setPrd first — update() no-ops without a PRD.
    writer.setPrd({
      project: "test-project",
      feature: "live-cost-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [],
    });
    await writer.update(3.016, 1);
    expect(writer.lastTotalCost).toBeCloseTo(3.016);
    await writer.update(3.42, 1);
    expect(writer.lastTotalCost).toBeCloseTo(3.42);
  });

  test("never regresses — update() with a lower total keeps the higher one", async () => {
    const writer = makeWriter();
    writer.setPrd({
      project: "test-project",
      feature: "live-cost-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [],
    });
    await writer.update(5, 2);
    await writer.update(4, 2);
    expect(writer.lastTotalCost).toBe(5);
  });
});

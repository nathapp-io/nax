/**
 * dispatchStatusView — Status command view routing (US-002)
 *
 * AC-6: dispatchStatusView with { cost: true, json: true, last: true } invokes
 *       deps.emitCostReportJson and does NOT invoke deps.displayLastRunMetrics
 *       (JSON mode wins over --last).
 * AC-7: dispatchStatusView with { cost: true, json: true, model: true } invokes
 *       deps.emitCostReportJson and does NOT invoke deps.displayModelEfficiency
 *       (JSON mode wins over --model).
 * AC-8: dispatchStatusView with { cost: false, json: true } invokes
 *       deps.displayFeatureStatus with the feature-status options and does NOT
 *       invoke deps.emitCostReportJson.
 */

import { describe, expect, mock, test } from "bun:test";
import { dispatchStatusView, type StatusViewDeps } from "@/cli/status-dispatch";

function makeDeps(): StatusViewDeps {
  return {
    displayCostMetrics: mock(async () => {}),
    displayLastRunMetrics: mock(async () => {}),
    displayModelEfficiency: mock(async () => {}),
    emitCostReportJson: mock(async () => {}),
    displayFeatureStatus: mock(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// AC-6: --cost --json --last → JSON mode wins
// ---------------------------------------------------------------------------

describe("dispatchStatusView — AC6: --cost --json --last", () => {
  test("AC6: with { cost: true, json: true, last: true }, invokes emitCostReportJson and does NOT invoke displayLastRunMetrics", async () => {
    const deps = makeDeps();
    const options = { cost: true, json: true, last: true };

    await dispatchStatusView("/tmp/workdir", options, deps);

    expect((deps.emitCostReportJson as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((deps.displayLastRunMetrics as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-7: --cost --json --model → JSON mode wins
// ---------------------------------------------------------------------------

describe("dispatchStatusView — AC7: --cost --json --model", () => {
  test("AC7: with { cost: true, json: true, model: true }, invokes emitCostReportJson and does NOT invoke displayModelEfficiency", async () => {
    const deps = makeDeps();
    const options = { cost: true, json: true, model: true };

    await dispatchStatusView("/tmp/workdir", options, deps);

    expect((deps.emitCostReportJson as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((deps.displayModelEfficiency as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-8: --json without --cost → feature status path
// ---------------------------------------------------------------------------

describe("dispatchStatusView — AC8: --json without --cost", () => {
  test("AC8: with { cost: false, json: true }, invokes displayFeatureStatus with the feature-status options and does NOT invoke emitCostReportJson", async () => {
    const deps = makeDeps();
    const options = { cost: false, json: true };

    await dispatchStatusView("/tmp/workdir", options, deps);

    expect((deps.displayFeatureStatus as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((deps.emitCostReportJson as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});
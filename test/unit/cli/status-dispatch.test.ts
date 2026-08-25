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
 *
 * Plus commander-level wiring coverage so `status --json` is exercised end-to-end.
 */

import { describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import {
  dispatchStatusView,
  registerStatusCommand,
  runStatusAction,
  type StatusCommandActionDeps,
  type StatusViewDeps,
} from "@/cli";

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
    const options = { cost: false, json: true, feature: "feat-x", dir: "/tmp/workdir" };

    await dispatchStatusView("/tmp/workdir", options, deps);

    expect((deps.displayFeatureStatus as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((deps.emitCostReportJson as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    const forwarded = (deps.displayFeatureStatus as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(forwarded.feature).toBe("feat-x");
    expect(forwarded.dir).toBe("/tmp/workdir");
  });
});

// ---------------------------------------------------------------------------
// Commander-level wiring: status subcommand registers --json and routes
// to dispatchStatusView via runStatusAction (extracted from bin/nax.ts).
// ---------------------------------------------------------------------------

describe("registerStatusCommand — commander wiring for --json", () => {
  test("registers a subcommand named 'status' that exposes --json, --cost, --last, and --model", () => {
    const program = new Command();
    registerStatusCommand(program);

    const sub = program.commands.find((c) => c.name() === "status");
    expect(sub).toBeDefined();
    if (!sub) throw new Error("status subcommand not registered");
    const help = sub.helpInformation();
    expect(help).toContain("--json");
    expect(help).toContain("--cost");
    expect(help).toContain("--last");
    expect(help).toContain("--model");
  });
});

function makeActionDeps(viewDeps: StatusViewDeps = makeDeps()): StatusCommandActionDeps {
  return {
    validateDirectory: (dir: string) => dir,
    findProjectDir: () => "/tmp/.nax",
    dispatchStatusView: mock(async (_workdir: string, opts: Parameters<typeof dispatchStatusView>[1]) => {
      await dispatchStatusView(_workdir, opts, viewDeps);
    }) as StatusCommandActionDeps["dispatchStatusView"],
  };
}

describe("runStatusAction — --cost --json --last routes through JSON mode", () => {
  test("with --cost --json --last, dispatches to emitCostReportJson and skips displayLastRunMetrics", async () => {
    const viewDeps = makeDeps();
    const actionDeps = makeActionDeps(viewDeps);

    await runStatusAction({ cost: true, json: true, last: true, dir: "/tmp/workdir" }, actionDeps);

    expect((viewDeps.emitCostReportJson as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((viewDeps.displayLastRunMetrics as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});

describe("runStatusAction — --json without --cost falls back to feature status", () => {
  test("with --json only, invokes displayFeatureStatus and does NOT invoke emitCostReportJson", async () => {
    const viewDeps = makeDeps();
    const actionDeps = makeActionDeps(viewDeps);

    await runStatusAction({ json: true, feature: "feat-x", dir: "/tmp/workdir" }, actionDeps);

    expect((viewDeps.displayFeatureStatus as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((viewDeps.emitCostReportJson as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});

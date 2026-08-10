/**
 * The two gate nodes, driven directly.
 *
 * `flow-graph.test.ts` exercises them through `flow.nodes.*` for the wiring;
 * these cover the "nothing ran" holes, where a gate reports green having
 * verified nothing — the failure mode the whole node exists to prevent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _acceptanceDeps } from "@flows/nax-finish/steps/acceptance";
import { acceptanceGateNode, qualityGatesNode } from "@flows/nax-finish/steps/gates";
import { _qualityDeps } from "@flows/nax-finish/steps/quality";
import { makeFlowCtx } from "@test/helpers";
import type { FlowNodeContext } from "acpx/flows";

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };
const ctxOf = (outputs: Record<string, unknown>): FlowNodeContext => makeFlowCtx({ input: INPUT, outputs });

const GROUP = {
  packageDir: "",
  testPath: ".nax/features/x/a.test.ts",
  exists: true,
  command: "bun test {{FILE}}",
  language: "typescript",
};

const originalAcceptanceRun = _acceptanceDeps.runShell;
const originalQualityRun = _qualityDeps.runShell;
const originalReadText = _qualityDeps.readText;
afterEach(() => {
  _acceptanceDeps.runShell = originalAcceptanceRun;
  _qualityDeps.runShell = originalQualityRun;
  _qualityDeps.readText = originalReadText;
});

describe("acceptanceGateNode", () => {
  // `resolveFeatureAcceptance` returns `{ status: "ok", groups: [] }` whenever
  // the PRD loads but groups to nothing — so "ok" does NOT imply a target
  // exists. `runAcceptanceGate` reports `passed: true, ran: 0` for that, which
  // routed `proceed` and opened a ready PR with the feature's contract
  // unverified: #1398's failure mode on the one path its guard did not cover.
  test("escalates when the status is ok but no group was runnable — nothing verified the contract", async () => {
    let ran = 0;
    _acceptanceDeps.runShell = async () => {
      ran += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const out = await acceptanceGateNode(ctxOf({ load_ctx: { groups: [], acceptanceStatus: "ok" } }));
    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("No acceptance test target resolved");
    expect(out.reason).toContain("nothing verified its contract");
    expect(ran).toBe(0);
  });

  test("a runnable green group still proceeds", async () => {
    _acceptanceDeps.runShell = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const out = await acceptanceGateNode(ctxOf({ load_ctx: { groups: [GROUP], acceptanceStatus: "ok" } }));
    expect(out.route).toBe("proceed");
  });
});

describe("qualityGatesNode", () => {
  const commands = JSON.stringify({ quality: { commands: { test: "bun test" } } });

  // The `acceptance` node honours the repo's opt-out; this node re-ran the gate
  // regardless. Today `disabled` also carries `groups: []` so it is inert, but
  // the two nodes disagreeing about who owns the opt-out is what would put the
  // flow into a fix loop for tests the repo explicitly turned off.
  test("honours acceptance.enabled=false instead of re-running the disabled gate", async () => {
    let acceptanceRuns = 0;
    _acceptanceDeps.runShell = async () => {
      acceptanceRuns += 1;
      return { exitCode: 1, stdout: "", stderr: "would fail" };
    };
    _qualityDeps.readText = async () => commands;
    _qualityDeps.runShell = async () => ({ exitCode: 0, stdout: "green", stderr: "" });

    const out = await qualityGatesNode(ctxOf({ load_ctx: { groups: [GROUP], acceptanceStatus: "disabled" } }));
    expect(acceptanceRuns).toBe(0);
    expect(out.route).toBe("green");
    expect(out.ran).toEqual(["test"]);
  });

  test("still re-runs the acceptance gate when acceptance is enabled", async () => {
    let acceptanceRuns = 0;
    _acceptanceDeps.runShell = async () => {
      acceptanceRuns += 1;
      return { exitCode: 1, stdout: "", stderr: "broken by a later fix" };
    };
    _qualityDeps.readText = async () => commands;

    const out = await qualityGatesNode(ctxOf({ load_ctx: { groups: [GROUP], acceptanceStatus: "ok" } }));
    expect(acceptanceRuns).toBe(1);
    expect(out.route).toBe("fix");
    expect(out.failing).toEqual(["acceptance"]);
  });
});

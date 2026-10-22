import { describe, expect, test } from "bun:test";
import { type BotFixState, renderFixSummary } from "@/bot";
import { BOT_FIX_GRAPH } from "@/bot/fix-run";
import { parseNaxBotMarker } from "@/forge";
import { validateStepGraph } from "@/step-graph";
import { safeCode } from "@/workflow/pr-body-safe";

const state: BotFixState = { step: "report", timings: {} };

describe("renderFixSummary", () => {
  test("AC-14 renders the cost boundary with two decimal places", () => {
    expect(renderFixSummary({ ...state, outcome: "cost-limit", costSpentUsd: 1.5, costLimitUsd: 1 })).toContain(
      "Cost limit reached: 1.50 of 1.00 USD; nothing pushed.",
    );
  });
  test("US-008 AC-9 reports tracked prepare changes", () => {
    expect(renderFixSummary({ ...state, outcome: "prepare-touched-tracked" })).toContain(
      "The prepare turn changed tracked files; nothing pushed.",
    );
  });
  test("US-008 AC-10 records the prepare turn", () => {
    expect(
      renderFixSummary({ ...state, outcome: "baseline-red", repairMode: "prepare", gateRepairRounds: 1 }),
    ).toContain("Repair turn: prepare, round 1.");
  });
  test.each([
    ["pushed", "Pushed abcdef1: 3 agreed items fixed in one round; gates passed."],
    ["nothing", "Nothing to fix: the latest review agreed with no item."],
    ["no-change", "The fix session changed nothing; nothing pushed."],
    ["protected", "The fix changed protected files; nothing pushed."],
    ["no-gates", "No gates are configured on the base branch; nothing pushed."],
    ["gates-failed", "Gates failed: test, lint; nothing pushed."],
    ["push-rejected", "The push was rejected (the PR changed or access was denied); nothing pushed."],
  ] satisfies readonly (readonly [BotFixState["outcome"], string])[])("renders %s outcome", (outcome, expected) => {
    expect(
      renderFixSummary({ ...state, outcome, pushedSha: "abcdef12", agreedCount: 3, failingGates: ["test", "lint"] }),
    ).toContain(expected);
  });
  test("lists protected paths inside code spans", () => {
    expect(renderFixSummary({ ...state, outcome: "protected", protectedFiles: [".nax/config.json"] })).toContain(
      "- `.nax/config.json`",
    );
    expect(renderFixSummary({ ...state, outcome: "protected", protectedFiles: ["a`b\n.ts"] })).not.toContain(
      "a`b\n.ts",
    );
  });
  test.each([
    ".github/[click](http://evil.example/x).yml",
    ".github/@alice#12.yml",
    ".github/`[click](http://evil.example/x)`.yml",
  ])("keeps hostile protected path %s inside code spans", (path) => {
    const body = renderFixSummary({ ...state, outcome: "protected", protectedFiles: [path] });
    expect(body).toContain(`- \`${safeCode(path)}\``);
    expect(safeCode(path)).not.toContain("`");
  });
  test.each([
    "/repo/.nax-wt/[click](http://evil.example/x)",
    "/repo/.nax-wt/@alice#12",
    "/repo/.nax-wt/`[click](http://evil.example/x)`",
  ])("keeps hostile recovery path %s inside code spans", (path) => {
    const body = renderFixSummary({ ...state, outcome: "dirty", recoveryPath: path });
    expect(body).toContain(`\`${safeCode(path)}\``);
    expect(safeCode(path)).not.toContain("`");
  });
  test("includes fix failure", () => {
    expect(renderFixSummary({ ...state, outcome: "no-change", fixFailure: "boom" })).toContain("Fix session: boom");
  });
  test("neutralises and caps untrusted failure text", () => {
    const body = renderFixSummary({
      ...state,
      outcome: "no-change",
      fixFailure: `@alice #42 https://example.com ${"x".repeat(600)}`,
    });
    expect(body).not.toContain("@alice");
    expect(body).not.toContain("https://");
    expect(body).not.toContain("x".repeat(501));
  });
  test("marks the summary identity", () => {
    expect(parseNaxBotMarker(renderFixSummary({ ...state, outcome: "nothing" }))).toEqual({ key: "fix-summary" });
  });
  test("AC-17: says why the PR stayed a draft", () => {
    const body = renderFixSummary({ ...state, outcome: "nothing", readyHeld: "CI failed: x" });
    expect(body.split("\n")).toContain("Kept as draft: CI failed: x");
  });
  test("keeps the workflow hold readable", () => {
    const body = renderFixSummary({
      ...state,
      outcome: "nothing",
      readyHeld: "no nax item index on this PR",
    });
    expect(body.split("\n")).toContain("Kept as draft: no nax item index on this PR");
  });
  test("neutralises and caps the untrusted reason the PR stayed a draft", () => {
    const body = renderFixSummary({
      ...state,
      outcome: "nothing",
      readyHeld: `CI failed: @alice ${"x".repeat(600)}`,
    });
    expect(body).not.toContain("@alice");
    expect(body).not.toContain("x".repeat(501));
  });
  test("AC-18: says the PR was marked ready", () => {
    const body = renderFixSummary({ ...state, outcome: "pushed", markedReady: true });
    expect(body.split("\n")).toContain("Marked ready.");
  });
});

describe("repair declarations and summary", () => {
  test("AC-17 repair node validates", () => {
    expect(BOT_FIX_GRAPH.nodes.repair).toMatchObject({ kind: "agent", commits: true });
    expect(validateStepGraph(BOT_FIX_GRAPH).errors).toEqual([]);
  });
  test("AC-18 summary records repair mode and round", () => {
    expect(
      renderFixSummary({
        step: "report",
        timings: {},
        outcome: "gates-failed",
        repairMode: "repair",
        gateRepairRounds: 1,
      }),
    ).toContain("Repair turn: repair, round 1.");
  });
  test("AC-21 summary explains cost skip", () => {
    expect(
      renderFixSummary({ step: "report", timings: {}, outcome: "gates-failed", repairSkippedForCost: true }),
    ).toContain("Repair turn skipped: cost limit reached.");
  });
});

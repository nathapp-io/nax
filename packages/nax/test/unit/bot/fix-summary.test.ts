import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { relative } from "node:path";
import { type BotFixState, renderFixSummary } from "@/bot";
import { BOT_FIX_GRAPH } from "@/bot/fix-run";
import { fitDetails } from "@/bot/fix-summary";
import { parseNaxBotMarker } from "@/forge";
import { validateStepGraph } from "@/step-graph";
import { safeCode } from "@/workflow/pr-body-safe";

const state: BotFixState = { step: "report", timings: {} };

describe("renderFixSummary", () => {
  test.each([{ costSpentUsd: 1 }, { costLimitUsd: 5 }, {}])("rejects incomplete cost-stop state %j", (cost) => {
    expect(() => renderFixSummary({ ...state, outcome: "cost-limit", ...cost })).toThrow(
      expect.objectContaining({ code: "BOT_FIX_OUTCOME_MISSING" }),
    );
  });
  test("reports an unreadable prepare tree without claiming changes", () => {
    const summary = renderFixSummary({ ...state, outcome: "prepare-touched-tracked", prepareTreeUnreadable: true });
    expect(summary).toContain("could not be read");
    expect(summary).not.toContain("changed tracked files");
  });
  test("US-011 AC-11 identifies the reused fix with a seven-character sha", () => {
    expect(renderFixSummary({ ...state, outcome: "protected", reusedFix: "abcdef1234567890" })).toContain(
      "Reused the saved fix abcdef1; no new fix session.",
    );
  });
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
  // B2: the protected list is as long as the fix's diff, and one uncapped list made the whole comment
  // exceed the forge's limit — which refuses the write outright, so no push was ever recorded.
  test("B2: names at most twenty protected paths and counts the rest", () => {
    const files = Array.from({ length: 25 }, (_unused, index) => `.nax/protected/${index}.md`);
    const body = renderFixSummary({ ...state, outcome: "protected", protectedFiles: files });
    expect(body).toContain("- `.nax/protected/19.md`");
    expect(body).not.toContain("- `.nax/protected/20.md`");
    expect(body).toContain("- and 5 more");
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
    const body = renderFixSummary({ ...state, outcome: "dirty", recoveryPath: path }, [], "/repo");
    const shown = relative("/repo", path);
    expect(body).toContain(`\`${safeCode(shown)}\``);
    expect(safeCode(shown)).not.toContain("`");
  });
  // nax#2681: the comment is public; the absolute path exposes the local username and layout.
  test("renders the recovery checkout relative to the repo root, never absolute", () => {
    const body = renderFixSummary(
      { ...state, outcome: "dirty", recoveryPath: "/Users/me/src/app/.nax-wt/bot-pr-7-ab" },
      [],
      "/Users/me/src/app",
    );
    expect(body).toContain("`.nax-wt/bot-pr-7-ab`");
    expect(body).not.toContain("/Users/me");
  });
  test("without a repo root, or outside it, only the checkout directory name is shown", () => {
    const noRoot = renderFixSummary({ ...state, outcome: "dirty", recoveryPath: "/Users/me/app/.nax-wt/bot-1" });
    const outside = renderFixSummary({ ...state, outcome: "dirty", recoveryPath: "/tmp/other/bot-2" }, [], "/Users/me");
    expect(noRoot).toContain("`bot-1`");
    expect(noRoot).not.toContain("/Users/me");
    expect(outside).toContain("`bot-2`");
    expect(outside).not.toContain("/tmp/other");
  });
  test("a checkout that disappeared says so and names no recovery path", () => {
    const body = renderFixSummary(
      { ...state, outcome: "dirty", recoveryPath: "/repo/.nax-wt/bot-1", checkoutMissing: true },
      [],
      "/repo",
    );
    expect(body).toContain("The fix checkout disappeared during the session");
    expect(body).not.toContain("Recovery checkout retained");
    expect(body).not.toContain(".nax-wt/bot-1");
  });
  test("the repo root is stripped from the fix failure text", () => {
    const body = renderFixSummary(
      { ...state, outcome: "dirty", fixFailure: "ENOENT: no such file '/Users/me/app/.nax-wt/bot-1/src'" },
      [],
      "/Users/me/app",
    );
    expect(body).toContain("'.nax-wt/bot-1/src'");
    expect(body).not.toContain("/Users/me");
  });
  test("a sibling directory sharing the root's prefix is left intact", () => {
    const body = renderFixSummary(
      { ...state, outcome: "no-change", fixFailure: "see '/srv/app-old/x'" },
      [],
      "/srv/app",
    );
    expect(body).toContain("'/srv/app-old/x'");
  });
  test.each([
    ["failed in /opt/repo.", "failed in ."],
    ["see `/opt/repo`;", "see '.';"],
    ["cd /opt/repo/src; ok", "cd src; ok"],
    ["backup /opt/repo.bak/x", "backup /opt/repo.bak/x"],
  ])("strips the root at any path boundary: %p", (failure, expected) => {
    expect(renderFixSummary({ ...state, outcome: "no-change", fixFailure: failure }, [], "/opt/repo")).toContain(
      `Fix session: ${expected}`,
    );
  });
  test("the home directory is shown as ~ in the fix failure text", () => {
    const body = renderFixSummary(
      { ...state, outcome: "no-change", fixFailure: `ENOENT '${homedir()}/.nax/config.json'` },
      [],
      "/srv/app",
    );
    expect(body).toContain("'~/.nax/config.json'");
    expect(body).not.toContain(homedir());
  });
  test("an empty repo root leaves the failure text unchanged", () => {
    expect(renderFixSummary({ ...state, outcome: "no-change", fixFailure: "boom" }, [], "")).toContain(
      "Fix session: boom",
    );
  });
  test("a checkout directory whose name starts with .. is still shown relative to the root", () => {
    const body = renderFixSummary({ ...state, outcome: "dirty", recoveryPath: "/repo/..wt/bot-1" }, [], "/repo");
    expect(body).toContain("`..wt/bot-1`");
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
  test("US-005 AC-8: a failed fix session says it failed rather than that it changed nothing", () => {
    expect(renderFixSummary({ ...state, outcome: "fix-failed", fixFailure: "boom" })).toContain(
      "The fix session failed before changing anything; nothing pushed.",
    );
  });
  test("US-005 AC-8: the fix-failed line replaces the no-change wording", () => {
    const body = renderFixSummary({ ...state, outcome: "fix-failed", fixFailure: "boom" });
    expect(body).not.toContain("The fix session changed nothing; nothing pushed.");
  });
  test("marks the summary identity", () => {
    expect(parseNaxBotMarker(renderFixSummary({ ...state, outcome: "nothing" }))).toEqual({ key: "fix-summary" });
  });
  // US-004: `outcomeText` moved to `bot/fix-outcome-text.ts` unchanged — the line a reader sees is
  // pinned here so the move cannot quietly reword the public comment.
  test.each([
    ["pushed", "Pushed abcdef1: 2 agreed items fixed in one round; gates passed."],
    ["nothing", "Nothing to fix: the latest review agreed with no item."],
    ["no-change", "The fix session changed nothing; nothing pushed."],
    ["push-rejected", "The push was rejected (the PR changed or access was denied); nothing pushed."],
  ] satisfies readonly (readonly [BotFixState["outcome"], string])[])(
    "US-004 AC-10 keeps the %s outcome line as the summary's first line",
    (outcome, expected) => {
      const body = renderFixSummary({ ...state, outcome, pushedSha: "abcdef1", agreedCount: 2 });
      expect(body.split("\n")[2]).toBe(expected);
    },
  );
  test("US-007 AC-13: lists ten follow-ups and counts the rest", () => {
    const followUps = Array.from({ length: 12 }, (_unused, index) => ({
      key: `f-${index}`,
      severity: "minor" as const,
      trigger: "normal" as const,
    }));
    const body = renderFixSummary({ ...state, outcome: "nothing", followUps });
    expect(body).toContain("Left for follow-up: f-0 (Minor, normal), f-1 (Minor, normal)");
    expect(body).toContain("and 2 more");
    expect(body).not.toContain("f-10");
  });
  test("US-007 AC-14: a review that agreed with no item still reads as nothing to fix", () => {
    expect(renderFixSummary({ ...state, outcome: "nothing" })).toContain(
      "Nothing to fix: the latest review agreed with no item.",
    );
  });
  test("US-007 AC-12: names what the non-blocking agreed list left for follow-up", () => {
    const body = renderFixSummary({
      ...state,
      outcome: "nothing",
      followUps: [{ key: "f-1", severity: "minor", trigger: "normal" }],
    });
    expect(body).toContain(
      "No fix session: no agreed item can hold readiness. Left for follow-up: f-1 (Minor, normal).",
    );
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
  test("US-007 AC-13: names the CI waiver that readied the PR", () => {
    const body = renderFixSummary({
      ...state,
      outcome: "pushed",
      markedReady: true,
      ciWaived: { checks: ["a", "b"], reason: "r" },
    });
    expect(body.split("\n")).toContain("Marked ready with a CI waiver: 2 check(s) never got a runner: a; b. Reason: r");
  });
  test("US-007: a summary with no waiver says nothing about one", () => {
    expect(renderFixSummary({ ...state, outcome: "pushed", markedReady: true })).not.toContain("CI waiver");
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

/**
 * B2: the comment is one public comment under the forge's limit, so the lines a report varies are
 * capped against the room the fixed text leaves. These pin the cap on its own.
 */
describe("fitDetails", () => {
  test("keeps every line that fits, each costing its own newline", () => {
    expect(fitDetails(["ab", "cd"], 6)).toEqual(["ab", "cd"]);
    expect(fitDetails(["ab", "cd"], 5)).toEqual(["ab"]);
  });
  test("truncates the line it cannot fit whole, so a reader sees there was more", () => {
    const [kept] = fitDetails(["abcdefghij"], 6);
    // Five characters plus the ellipsis and its newline is exactly the room available.
    expect(kept).toBe("abcd…");
    expect(kept?.endsWith("…")).toBe(true);
  });
  test("drops the details entirely when the fixed text already used the room", () => {
    expect(fitDetails(["abc"], 0)).toEqual([]);
    expect(fitDetails(["abc"], -40)).toEqual([]);
    expect(fitDetails([], 100)).toEqual([]);
  });
});

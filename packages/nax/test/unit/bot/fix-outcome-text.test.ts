import { describe, expect, test } from "bun:test";
import type { BotFixState } from "@/bot";
import { outcomeText } from "@/bot/fix-outcome-text";

const state: BotFixState = { step: "report", timings: {} };

describe("outcomeText setup-failed", () => {
  const setupFailed = "bun install --frozen-lockfile";
  const setupHint =
    "Set execution.preRun in the base branch's .nax/config.json to choose the install step; after it is merged, the next nax bot fix 42 re-reads it, or run nax bot review 42 to refresh the saved checks.";

  test("AC-11 renders the failed command on the first line", () => {
    const text = outcomeText({ ...state, outcome: "setup-failed", setupFailed, setupHint }, undefined);
    expect(text.split("\n")[0]).toBe("Setup failed at `bun install --frozen-lockfile`; nothing ran.");
  });
  test("AC-12 renders the setup hint on the line after it", () => {
    const text = outcomeText({ ...state, outcome: "setup-failed", setupFailed, setupHint }, undefined);
    expect(text.split("\n")[1]).toBe(setupHint);
  });
  test("renders the sentence alone when no hint was built", () => {
    expect(outcomeText({ ...state, outcome: "setup-failed", setupFailed }, undefined)).toBe(
      "Setup failed at `bun install --frozen-lockfile`; nothing ran.",
    );
  });
});

import { describe, expect, test } from "bun:test";
import type { BotChecks } from "@/bot";
import { buildSetupHint } from "@/bot/fix-setup";
import { NaxError } from "@/errors";

const failure = new NaxError("[bot] install failed", "PRE_RUN_FAILED", {
  stage: "bot",
  command: "bun install --frozen-lockfile",
});

function checks(install: BotChecks["install"]): BotChecks {
  return {
    source: "detected",
    gates: [{ name: "test", command: "bun run test" }],
    preRun: [{ command: "bun install --frozen-lockfile", timeoutSeconds: 600 }],
    ...(install === undefined ? {} : { install }),
  };
}

describe("buildSetupHint", () => {
  test("AC-19 renders a hostile lockfile name through safeCode, never as an unbalanced code span", () => {
    const hint = buildSetupHint({
      checks: checks({ lockfile: "a`b.lock", reason: "lockfile-order", fallbacks: [] }),
      error: failure,
      pr: 42,
    });
    expect(hint).toContain("`a'b.lock`");
    expect(hint).not.toContain("a`b.lock");
    // Every code span is opened and closed: an even number of backticks in the whole hint.
    expect(hint.match(/`/g)?.length ?? 0).toBeGreaterThan(0);
    expect((hint.match(/`/g)?.length ?? 0) % 2).toBe(0);
  });
  test("names the lockfile and why it was chosen, for both reasons", () => {
    const order = buildSetupHint({
      checks: checks({ lockfile: "bun.lock", reason: "lockfile-order", fallbacks: [] }),
      error: failure,
      pr: 7,
    });
    const manager = buildSetupHint({
      checks: checks({ lockfile: "package-lock.json", reason: "package-manager", fallbacks: [] }),
      error: failure,
      pr: 7,
    });
    expect(order).toContain(
      "The install step was derived from `bun.lock` (the first lockfile found) on the base branch.",
    );
    expect(manager).toContain("(the packageManager field)");
  });
  test("lists only the commands tried after the first one", () => {
    const tried = new NaxError("[bot] every install failed", "PRE_RUN_FAILED", {
      stage: "bot",
      command: "bun install --frozen-lockfile",
      tried: ["bun install --frozen-lockfile", "npm ci"],
    });
    const hint = buildSetupHint({ checks: checks(undefined), error: tried, pr: 7 });
    expect(hint).toContain("Also tried: `npm ci`.");
    expect(hint).not.toContain("Also tried: `bun install --frozen-lockfile`");
  });
  test("always names the config key and the two commands a reader can run", () => {
    const hint = buildSetupHint({ checks: checks(undefined), error: failure, pr: 314 });
    expect(hint).toContain("Set execution.preRun in the base branch's .nax/config.json");
    expect(hint).toContain("the next nax bot fix 314 re-reads it");
    expect(hint).toContain("nax bot review 314");
  });
  test("says nothing about a derivation when the install is not lockfile-derived", () => {
    expect(buildSetupHint({ checks: checks(undefined), error: failure, pr: 7 })).not.toContain("derived from");
  });
});

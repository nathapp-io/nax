import { describe, expect, test } from "bun:test";
import { type BotChecks, REVIEW_BUILD_TIMEOUT_SECONDS, reviewBuildSteps } from "@/bot";
import { DEFAULT_GATE_TIMEOUT_MS } from "@/finish";

function gatesOf(...gates: BotChecks["gates"]): BotChecks {
  return { source: "config", gates, preRun: [] };
}

describe("reviewBuildSteps", () => {
  test("AC-1: takes the build gate's command, not the test gate's", () => {
    expect(
      reviewBuildSteps(gatesOf({ name: "test", command: "npm run test" }, { name: "build", command: "bun run build" })),
    ).toEqual([{ command: "bun run build", timeoutSeconds: 900 }]);
  });
  test("AC-3: a list command becomes one step per element, in order", () => {
    expect(reviewBuildSteps(gatesOf({ name: "build", command: ["c", "d"] }))).toEqual([
      { command: "c", timeoutSeconds: 900 },
      { command: "d", timeoutSeconds: 900 },
    ]);
  });
  test("AC-4: no build gate yields no steps", () => {
    expect(reviewBuildSteps(gatesOf({ name: "test", command: "npm run test" }))).toEqual([]);
    expect(reviewBuildSteps(gatesOf())).toEqual([]);
  });
  test("AC-5: only the root gate named exactly build counts", () => {
    expect(reviewBuildSteps(gatesOf({ name: "build@packages/lib", command: "bun run build" }))).toEqual([]);
  });
});

describe("REVIEW_BUILD_TIMEOUT_SECONDS", () => {
  test("AC-2: same bound as the gate runner's default timeout", () => {
    expect(REVIEW_BUILD_TIMEOUT_SECONDS).toBe(DEFAULT_GATE_TIMEOUT_MS / 1000);
    expect(REVIEW_BUILD_TIMEOUT_SECONDS).toBe(900);
  });
});

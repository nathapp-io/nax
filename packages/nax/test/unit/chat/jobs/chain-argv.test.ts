import { describe, expect, test } from "bun:test";
import { buildChainStepArgv, CHAIN_STEP_FIELDS, parseChainStepInput, resolveStepArgv } from "@/chat/jobs/chain-argv";
import { buildJobArgv, parseJobInput } from "@/chat/jobs/job-argv";

const ctx = { naxEntry: ["bun", "/n.ts"], repoRoot: "/r" };
const argv = ["bun", "/n.ts", "bot", "review", "<pr>", "-d", "/r"];

describe("parseChainStepInput", () => {
  test("AC-12 omits absent PR without losing profiles", () => {
    expect(parseChainStepInput("bot_review", { profiles: ["p"] })).toEqual({ kind: "bot_review", profiles: ["p"] });
  });
  test("AC-13 rejects invalid present PR", () => {
    expect(parseChainStepInput("bot_fix", { pr: 0 })).toEqual({ error: "[chat] pr must be a positive integer" });
  });
  test("AC-14 delegates run validation", () => {
    const raw = { feature: "f1", maxIterations: 40 };
    expect(parseChainStepInput("run", raw)).toEqual(parseJobInput("run", raw));
  });
  test("AC-15 rejects unknown run keys", () => {
    expect(parseChainStepInput("run", { feature: "f1", bogus: 1 })).toEqual({ error: "[chat] unknown field bogus" });
  });
  test("AC-16 rejects unknown keys before validating bot inputs", () => {
    expect(parseChainStepInput("bot_review", { decisions: "d.json", trust: true })).toEqual({
      error: "[chat] unknown field trust",
    });
  });
  test("preserves default profiles and validates PR-less bot options", () => {
    expect(parseChainStepInput("bot_fix", {})).toEqual({ kind: "bot_fix", profiles: [] });
    expect(parseChainStepInput("bot_fix", { trust: "yes" })).toEqual({ error: "[chat] trust must be a boolean" });
    expect(parseChainStepInput("bot_review", { pr: null })).toEqual({ error: "[chat] pr must be a positive integer" });
  });
  test("defines exactly the launch schema fields", () => {
    expect(CHAIN_STEP_FIELDS).toEqual({
      plan: ["feature", "spec", "profiles"],
      run: ["feature", "profiles", "maxIterations", "maxCost"],
      bot_review: ["pr", "profiles", "model", "decisions"],
      bot_fix: ["pr", "profiles", "model", "trust", "noRereview"],
    });
  });
});
describe("buildChainStepArgv", () => {
  test("AC-17 places PR placeholder at the exact bot argument index", () => {
    expect(buildChainStepArgv({ kind: "bot_review", profiles: [] }, ctx)).toEqual(argv);
  });
  test("AC-18 delegates fully specified bot argv", () => {
    const input = { kind: "bot_fix", pr: 12, profiles: [], trust: true } as const;
    expect(buildChainStepArgv(input, ctx)).toEqual(buildJobArgv(input, ctx));
  });
  test("delegates plan and run argv and handles variable entry lengths", () => {
    const input = { kind: "plan", feature: "f", spec: "/r/spec.md", profiles: ["p"] } as const;
    expect(buildChainStepArgv(input, ctx)).toEqual(buildJobArgv(input, ctx));
    const run = { kind: "run", feature: "f", profiles: [] } as const;
    expect(buildChainStepArgv(run, ctx)).toEqual(buildJobArgv(run, ctx));
    expect(buildChainStepArgv({ kind: "bot_fix", profiles: [], trust: true }, { ...ctx, naxEntry: ["nax"] })).toEqual([
      "nax",
      "bot",
      "fix",
      "<pr>",
      "-d",
      "/r",
      "--trust",
    ]);
  });
});
describe("resolveStepArgv", () => {
  test("AC-19 resolves only the designated token without mutating input", () => {
    expect(resolveStepArgv(argv, 4, 12)).toEqual(["bun", "/n.ts", "bot", "review", "12", "-d", "/r"]);
    expect(argv[4]).toBe("<pr>");
  });
  test("AC-20 preserves other placeholder-looking tokens", () => {
    expect(resolveStepArgv([...argv, "--decisions", "<pr>"], 4, 12)).toEqual([
      "bun",
      "/n.ts",
      "bot",
      "review",
      "12",
      "-d",
      "/r",
      "--decisions",
      "<pr>",
    ]);
  });
  test("AC-21 leaves argv unchanged without index", () => {
    expect(resolveStepArgv(argv, undefined, 12)).toBe(argv);
    expect(resolveStepArgv(argv, 4)).toBe(argv);
  });
});

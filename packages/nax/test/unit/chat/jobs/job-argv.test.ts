import { describe, expect, test } from "bun:test";
import { buildJobArgv, parseJobInput } from "@/chat/jobs/job-argv";
import type { ChatJobKind } from "@/chat/jobs/job-types";
import { validateFeatureName } from "@/utils/feature-name";

const ctx = { naxEntry: ["bun", "/n.ts"], repoRoot: "/r" };

describe("buildJobArgv", () => {
  test("rejects an unresolved plan spec", () => {
    expect(() => buildJobArgv({ kind: "plan", feature: "f1", profiles: [] }, ctx)).toThrow(
      "[chat] plan spec must be resolved before building argv",
    );
  });
  test("AC-1 plan", () => {
    expect(
      buildJobArgv({ kind: "plan", feature: "f1", spec: ".nax/features/f1/spec.md", profiles: ["a", "b"] }, ctx),
    ).toEqual([
      "bun",
      "/n.ts",
      "plan",
      "-f",
      "f1",
      "--from",
      ".nax/features/f1/spec.md",
      "-d",
      "/r",
      "--profile",
      "a",
      "--profile",
      "b",
    ]);
  });
  test("AC-2 run without limits", () => {
    expect(buildJobArgv({ kind: "run", feature: "f1", profiles: [] }, ctx)).toEqual([
      "bun",
      "/n.ts",
      "run",
      "-f",
      "f1",
      "-d",
      "/r",
      "--headless",
    ]);
  });
  test("AC-3 run limits after profiles", () => {
    expect(
      buildJobArgv({ kind: "run", feature: "f1", profiles: ["a"], maxIterations: 40, maxCost: 12.5 }, ctx),
    ).toEqual([
      "bun",
      "/n.ts",
      "run",
      "-f",
      "f1",
      "-d",
      "/r",
      "--headless",
      "--profile",
      "a",
      "-m",
      "40",
      "--max-cost",
      "12.5",
    ]);
  });
  test("AC-4 review", () => {
    expect(buildJobArgv({ kind: "bot_review", pr: 12, profiles: [], model: "opus", decisions: "d.json" }, ctx)).toEqual(
      ["bun", "/n.ts", "bot", "review", "12", "-d", "/r", "--model", "opus", "--decisions", "d.json"],
    );
  });
  test("AC-5 fix true flags", () => {
    expect(
      buildJobArgv({ kind: "bot_fix", pr: 12, profiles: ["a"], model: "opus", trust: true, noRereview: true }, ctx),
    ).toEqual([
      "bun",
      "/n.ts",
      "bot",
      "fix",
      "12",
      "-d",
      "/r",
      "--profile",
      "a",
      "--model",
      "opus",
      "--trust",
      "--no-rereview",
    ]);
  });
  test("AC-6 fix false flags", () => {
    expect(buildJobArgv({ kind: "bot_fix", pr: 12, profiles: [], trust: false, noRereview: false }, ctx)).toEqual([
      "bun",
      "/n.ts",
      "bot",
      "fix",
      "12",
      "-d",
      "/r",
    ]);
  });
});

const invalid: [string, ChatJobKind, Record<string, unknown>, string][] = [
  ["AC-8 missing", "run", {}, "feature must be a string"],
  ["AC-8 numeric", "run", { feature: 12 }, "feature must be a string"],
  ["AC-10 string", "run", { feature: "f1", profiles: "a" }, "profiles must be an array of strings"],
  ["AC-10 member", "run", { feature: "f1", profiles: [1] }, "profiles must be an array of strings"],
  ["AC-11", "run", { feature: "f1", profiles: ["--evil"] }, "profile --evil is not a valid profile name"],
  ...[0, 2.5, 1001].map((maxIterations): [string, ChatJobKind, Record<string, unknown>, string] => [
    maxIterations === 0 ? "AC-12" : "AC-13",
    "run",
    { feature: "f1", maxIterations },
    "maxIterations must be an integer from 1 to 1000",
  ]),
  ...[-1, 0, NaN, Infinity].map((maxCost): [string, ChatJobKind, Record<string, unknown>, string] => [
    "AC-14",
    "run",
    { feature: "f1", maxCost },
    "maxCost must be a positive number",
  ]),
  ...[0, 2.5, null, true, "", "1e2", " 12 ", "0x10", Number.MAX_SAFE_INTEGER + 1].map(
    (pr): [string, ChatJobKind, Record<string, unknown>, string] => [
      "AC-16",
      "bot_fix",
      { pr },
      "pr must be a positive integer",
    ],
  ),
  ["AC-17", "bot_review", { pr: 1, model: "-x" }, "model -x is not a valid model id"],
  ["AC-18", "bot_review", { pr: 1, decisions: "../d.json" }, "decisions must be a repo-relative path"],
  ["AC-19", "plan", { feature: "f1", spec: "/etc/passwd" }, "spec must be a repo-relative path"],
  ["AC-20", "bot_fix", { pr: 1, trust: "yes" }, "trust must be a boolean"],
  ["AC-23", "bot_fix", { pr: 1, noRereview: "yes" }, "noRereview must be a boolean"],
];

describe("parseJobInput", () => {
  test.each(invalid)("%s rejects %s %j", (_ac, kind, raw, message) => {
    expect(parseJobInput(kind, raw)).toEqual({ error: `[chat] ${message}` });
  });
  test("AC-7 defaults profiles", () => {
    expect(parseJobInput("run", { feature: "f1" })).toEqual({ kind: "run", feature: "f1", profiles: [] });
  });
  test("AC-9 preserves feature validation message", () => {
    let message = "";
    try {
      validateFeatureName("../x");
    } catch (err) {
      if (err instanceof Error) message = err.message;
    }
    expect(message).not.toBe("");
    expect(parseJobInput("run", { feature: "../x" })).toEqual({ error: message });
  });
  test("AC-15 normalizes PR strings", () => {
    expect(parseJobInput("bot_fix", { pr: "12" })).toEqual({ kind: "bot_fix", pr: 12, profiles: [] });
  });
  test("AC-21 unresolved plan spec", () => {
    expect(parseJobInput("plan", { feature: "f1" })).toEqual({ kind: "plan", feature: "f1", profiles: [] });
  });
  test.each(["/abs", "-flag", "a/../b", "../b", "C:\\abs", "a\\..\\b", "\\\\server\\share", "", 12, null])(
    "AC-22 unsafe path %j",
    (path) => {
      expect(parseJobInput("plan", { feature: "f1", spec: path })).toEqual({
        error: "[chat] spec must be a repo-relative path",
      });
      expect(parseJobInput("bot_review", { pr: 1, decisions: path })).toEqual({
        error: "[chat] decisions must be a repo-relative path",
      });
    },
  );
  test("preserves valid optionals and strips excluded flags", () => {
    expect(
      parseJobInput("run", {
        feature: "f1",
        profiles: ["a", "B_2.3-x"],
        maxIterations: 1000,
        maxCost: 0.01,
        headless: false,
      }),
    ).toEqual({ kind: "run", feature: "f1", profiles: ["a", "B_2.3-x"], maxIterations: 1000, maxCost: 0.01 });
    expect(parseJobInput("plan", { feature: "f1", spec: "docs/my spec.md" })).toEqual({
      kind: "plan",
      feature: "f1",
      profiles: [],
      spec: "docs/my spec.md",
    });
    expect(parseJobInput("bot_review", { pr: 1, model: "agent:provider/model-v1.2", decisions: "d.json" })).toEqual({
      kind: "bot_review",
      pr: 1,
      profiles: [],
      model: "agent:provider/model-v1.2",
      decisions: "d.json",
    });
    expect(parseJobInput("bot_fix", { pr: 1, model: "opus", trust: false, noRereview: true, fresh: true })).toEqual({
      kind: "bot_fix",
      pr: 1,
      profiles: [],
      model: "opus",
      trust: false,
      noRereview: true,
    });
  });
});

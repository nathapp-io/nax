import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { describeFindings, logWorkflow, startStep } from "@/workflow/run-log";

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

describe("describeFindings", () => {
  test("counts by severity and lists ids with a short issue", () => {
    const text = describeFindings([
      { id: "F1", severity: "important", issue: "first gap" },
      { id: "F2", severity: "important", issue: "second gap" },
      { id: "F3", severity: "minor", issue: "nit" },
    ]);
    expect(text).toBe("2 important, 1 minor (F1 first gap, F2 second gap, F3 nit)");
  });

  test("no findings reads as none", () => {
    expect(describeFindings([])).toBe("no findings");
  });

  test("long issues are cut and multi-line issues folded", () => {
    const text = describeFindings([{ id: "F1", severity: "critical", issue: `a\nb ${"x".repeat(200)}` }]);
    expect(text.startsWith("1 critical (F1 a b xxx")).toBe(true);
    expect(text.length).toBeLessThan(120);
  });
});

describe("logWorkflow / startStep", () => {
  test("logWorkflow logs at info under the workflow tag with storyId first", () => {
    logWorkflow("US-001", "US-001 hello", { n: 1 });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("info");
    expect(logs[0]?.stage).toBe("workflow");
    expect(Object.keys(logs[0]?.data ?? {})[0]).toBe("storyId");
  });

  test("startStep logs a start line, then a result line with the elapsed time", () => {
    let t = 1000;
    const step = startStep("US-003", "story-review", { now: () => t });
    t += 26_000;
    step.done("spec pass, quality approved");
    expect(logs.map((e) => e.message)).toEqual([
      "US-003 story-review start",
      "US-003 story-review: spec pass, quality approved  26.0s",
    ]);
    expect(logs[1]?.data).toMatchObject({ storyId: "US-003", step: "story-review", durationMs: 26_000 });
  });

  test("the feature scope omits the story id and can skip the start line", () => {
    const step = startStep("_run", "repo-gates", { announce: false, bare: true, now: () => 0 });
    step.done("green");
    expect(logs.map((e) => e.message)).toEqual(["repo-gates green  0ms"]);
    expect(logs[0]?.data?.storyId).toBe("_run");
  });
});

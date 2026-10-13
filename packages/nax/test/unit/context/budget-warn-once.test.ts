/** nax#2491 P7: a budget warning that every story would repeat is raised once per run, then logged at debug. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { truncateToContextBudget } from "@/context/feature-context-filter";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "debug" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

describe("feature context budget warning", () => {
  test("the second truncation in a run is a debug record, not another warning", () => {
    const big = "x".repeat(4_000);
    truncateToContextBudget(big, 10, "feat");
    truncateToContextBudget(big, 10, "feat");
    const budget = logs.filter((e) => e.stage === "feature-context");
    expect(budget.map((e) => e.level)).toEqual(["warn", "debug"]);
    expect(budget[1]?.data).toMatchObject({ occurrence: 2 });
  });
});

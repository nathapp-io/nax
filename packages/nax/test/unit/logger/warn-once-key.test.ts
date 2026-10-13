import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSink, getLogger, initLogger, type LogEntry, resetLogger } from "@/logger";

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "debug" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

describe("warnOnce with a key", () => {
  test("distinct keys under one message each warn once; repeats of a key go to debug", () => {
    const logger = getLogger();
    logger.warnOnce("config", "tier crosses a protocol boundary", { agent: "a" }, "a|fast");
    logger.warnOnce("config", "tier crosses a protocol boundary", { agent: "b" }, "b|fast");
    logger.warnOnce("config", "tier crosses a protocol boundary", { agent: "a" }, "a|fast");
    expect(logs.map((e) => e.level)).toEqual(["warn", "warn", "debug"]);
  });

  test("without a key the message alone dedupes, as before", () => {
    const logger = getLogger();
    logger.warnOnce("s", "m");
    logger.warnOnce("s", "m");
    expect(logs.map((e) => e.level)).toEqual(["warn", "debug"]);
  });
});

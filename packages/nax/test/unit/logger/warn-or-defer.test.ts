import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { warnOrDefer } from "@/logger";
import * as logging from "@/logger/logger";

const onExit = mock((_handler: () => void) => {});
const writeStderr = mock((_text: string) => {});
let restoreDeps: (() => void) | undefined;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  logging.resetLogger();
  logging._resetDeferredWarnings();
  onExit.mockClear();
  writeStderr.mockClear();
  const original = { ...logging._loggerDeps };
  Object.assign(logging._loggerDeps, { onExit, writeStderr });
  restoreDeps = () => Object.assign(logging._loggerDeps, original);
  warn = spyOn(logging.Logger.prototype, "warn");
});
afterEach(() => {
  logging.resetLogger();
  logging._resetDeferredWarnings();
  warn.mockRestore();
  restoreDeps?.();
});
const init = () => logging.initLogger({ level: "warn", suppressConsole: true });

describe("warnOrDefer", () => {
  test("AC-1: does not call even the no-op logger before initialization", () => {
    warnOrDefer("config", "m");
    expect(warn).not.toHaveBeenCalled();
  });
  test("AC-2: drains warnings in order to the new logger and empties the queue", () => {
    warnOrDefer("config", "first");
    warnOrDefer("config", "second");
    const logger = init();
    expect(warn.mock.calls).toEqual([
      ["config", "first"],
      ["config", "second"],
    ]);
    expect(warn.mock.contexts).toEqual([logger, logger]);
    logging.resetLogger();
    warn.mockClear();
    init();
    expect(warn).not.toHaveBeenCalled();
    onExit.mock.calls[0][0]();
    expect(writeStderr).not.toHaveBeenCalled();
  });
  test("AC-3: deduplicates by both stage and message without delimiter collisions", () => {
    for (const [stage, message] of [
      ["config", "m"],
      ["config", "m"],
      ["other", "m"],
      ["a|b", "c"],
      ["a", "b|c"],
    ]) {
      warnOrDefer(stage, message);
    }
    init();
    expect(warn.mock.calls).toEqual([
      ["config", "m"],
      ["other", "m"],
      ["a|b", "c"],
      ["a", "b|c"],
    ]);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
  // US-004 — warnOrDefer now routes to the logger's warnOnce, so the same config
  // warning raised by a second loadConfig in one run is written once.
  test("US-004 AC-3: an initialized logger writes a repeated warning once", () => {
    const logger = init();
    warnOrDefer("config", "x removed");
    warnOrDefer("config", "x removed");
    expect(warn.mock.calls).toEqual([["config", "x removed"]]);
    expect(warn.mock.contexts).toEqual([logger]);
    expect(onExit).not.toHaveBeenCalled();
  });
  test("US-004 AC-4: an initialized logger writes distinct warnings separately", () => {
    const logger = init();
    warnOrDefer("config", "a");
    warnOrDefer("config", "b");
    expect(warn.mock.calls).toEqual([
      ["config", "a"],
      ["config", "b"],
    ]);
    expect(warn.mock.contexts).toEqual([logger, logger]);
  });
  test("AC-5: exit writes every pending warning with exact formatting", () => {
    warnOrDefer("config", "first");
    warnOrDefer("config", "second");
    expect(onExit).toHaveBeenCalledTimes(1);
    onExit.mock.calls[0][0]();
    expect(writeStderr.mock.calls).toEqual([["nax warning (config): first\n"], ["nax warning (config): second\n"]]);
  });
  test("AC-6: pending warnings survive resetLogger", () => {
    warnOrDefer("config", "m");
    logging.resetLogger();
    init();
    expect(warn.mock.calls).toEqual([["config", "m"]]);
  });
  test("AC-7: explicit deferred reset empties pending warnings", () => {
    logging._resetDeferredWarnings();
    warnOrDefer("config", "m");
    logging._resetDeferredWarnings();
    init();
    expect(warn).not.toHaveBeenCalled();
  });
});

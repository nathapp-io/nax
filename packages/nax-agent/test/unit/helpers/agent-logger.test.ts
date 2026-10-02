import { afterEach, describe, expect, test } from "bun:test";
import { type AgentLogger, getSafeLogger, setAgentLogger } from "#src/infra/index";
import { makeLogger, withWarnSpy } from "#test/helpers/index";

const silent: AgentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

describe("makeLogger", () => {
  test("records every call in order with its level, and reset clears them", () => {
    const logger = makeLogger();
    logger.warn("tools", "first", { a: 1 });
    logger.debug("sandbox", "second");
    expect(logger.calls).toEqual([
      { level: "warn", stage: "tools", message: "first", data: { a: 1 } },
      { level: "debug", stage: "sandbox", message: "second", data: undefined },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    logger.reset();
    expect(logger.calls).toEqual([]);
  });
});

describe("withWarnSpy", () => {
  afterEach(() => setAgentLogger(null));

  test("a warn emitted through getSafeLogger() reaches the spy; other levels do not", async () => {
    await withWarnSpy(async (spy) => {
      getSafeLogger()?.warn("tools", "tool-audit partial flush failed", { runId: "r" });
      getSafeLogger()?.info("tools", "not a warn");
      expect(spy.mock.calls).toEqual([["tools", "tool-audit partial flush failed", { runId: "r" }]]);
    });
  });

  test("keeps the spy's calls after the callback resolves", async () => {
    let captured: { mock: { calls: unknown[][] } } | undefined;
    await withWarnSpy(async (spy) => {
      getSafeLogger()?.warn("s", "m");
      captured = spy;
    });
    expect(captured?.mock.calls).toHaveLength(1);
  });

  test("restores the previously installed logger after the callback resolves", async () => {
    setAgentLogger(silent);
    await withWarnSpy(async () => {});
    expect(getSafeLogger()).toBe(silent);
  });

  test("restores the previously installed logger when the callback throws", async () => {
    setAgentLogger(silent);
    await expect(
      withWarnSpy(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(getSafeLogger()).toBe(silent);
  });
});

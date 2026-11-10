import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSafeLogger, setAgentLogger } from "#src/infra/index";
import { logTurnTailWarnings } from "#src/native/session/turn-result";
import { type MockLogger, makeLogger } from "#test/helpers/index";

const halt = { tool: "submit_verdict", property: "refs", expected: "array", actual: "null" };

const base = {
  sessionName: "nax-implementer-US-001",
  completedNormally: true,
  spinStopped: false,
  roundTrips: 7,
  timedOut: false,
  spinBreaker: undefined,
};

describe("logTurnTailWarnings", () => {
  let logger: MockLogger;
  const previousLogger = getSafeLogger();
  beforeEach(() => {
    logger = makeLogger();
    setAgentLogger(logger);
  });
  afterEach(() => {
    setAgentLogger(previousLogger);
  });

  test("a turn that completed normally logs nothing", () => {
    logTurnTailWarnings(base);
    expect(logger.calls).toEqual([]);
  });

  test("outstanding tool calls warn, flagging an exceeded invalid-call budget", () => {
    logTurnTailWarnings({ ...base, completedNormally: false, timedOut: true, invalidCallHalt: halt });
    expect(logger.calls[0]).toEqual({
      level: "warn",
      stage: "native-adapter",
      message: "turn ended with tool calls outstanding",
      data: { sessionName: base.sessionName, roundTrips: 7, timedOut: true, invalidCallBudgetExceeded: true },
    });
  });

  test("outstanding tool calls without a budget halt omit the budget flag", () => {
    logTurnTailWarnings({ ...base, completedNormally: false });
    expect(logger.calls).toEqual([
      {
        level: "warn",
        stage: "native-adapter",
        message: "turn ended with tool calls outstanding",
        data: { sessionName: base.sessionName, roundTrips: 7, timedOut: false },
      },
    ]);
  });

  test("a spin-breaker stop logs an error", () => {
    logTurnTailWarnings({ ...base, spinStopped: true });
    expect(logger.calls).toEqual([
      {
        level: "error",
        stage: "native-adapter",
        message: "turn ended by the spin breaker",
        data: { sessionName: base.sessionName, roundTrips: 7 },
      },
    ]);
  });

  test("an invalid-call budget halt names the tool and the rejected property", () => {
    logTurnTailWarnings({ ...base, invalidCallHalt: halt });
    expect(logger.calls).toEqual([
      {
        level: "error",
        stage: "native-adapter",
        message: "turn ended by the invalid tool call budget",
        data: { sessionName: base.sessionName, roundTrips: 7, ...halt },
      },
    ]);
  });
});

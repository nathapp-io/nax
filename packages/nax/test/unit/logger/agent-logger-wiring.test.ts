import { afterEach, describe, expect, test } from "bun:test";
import * as agentInfra from "@/agents/infra";
import { initLogger, resetLogger } from "@/logger";

describe("initLogger fills the agent logger slot", () => {
  afterEach(() => resetLogger());

  test("the slot serves the instance initLogger created", () => {
    resetLogger();
    const logger = initLogger({ level: "silent" });
    expect(agentInfra.getSafeLogger()).toBe(logger);
  });

  test("resetLogger clears the slot", () => {
    resetLogger();
    initLogger({ level: "silent" });
    resetLogger();
    expect(agentInfra.getSafeLogger()).toBeNull();
  });

  test("a second init after reset serves the new instance", () => {
    resetLogger();
    initLogger({ level: "silent" });
    resetLogger();
    const second = initLogger({ level: "silent" });
    expect(agentInfra.getSafeLogger()).toBe(second);
  });
});

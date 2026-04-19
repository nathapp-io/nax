import { describe, expect, mock, test } from "bun:test";
import { applyAgentConfigMigration } from "../../../src/config/agent-migration";

function makeLogger() {
  return { warn: mock(() => {}), info: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) };
}

describe("applyAgentConfigMigration", () => {
  test("migrates autoMode.defaultAgent → agent.default", () => {
    const logger = makeLogger();
    const out = applyAgentConfigMigration({ autoMode: { defaultAgent: "claude" } }, logger);
    expect((out.agent as any).default).toBe("claude");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("migrates autoMode.fallbackOrder:[A,B,C] → agent.fallback.map:{A:[B,C]}", () => {
    const logger = makeLogger();
    const out = applyAgentConfigMigration(
      { autoMode: { defaultAgent: "claude", fallbackOrder: ["claude", "codex", "gemini"] } },
      logger,
    );
    expect((out.agent as any).fallback.map).toEqual({ claude: ["codex", "gemini"] });
    expect((out.agent as any).fallback.enabled).toBe(true);
  });

  test("migrates context.v2.fallback → agent.fallback", () => {
    const logger = makeLogger();
    const out = applyAgentConfigMigration(
      { context: { v2: { fallback: { enabled: true, map: { claude: ["codex"] } } } } },
      logger,
    );
    expect((out.agent as any).fallback.map).toEqual({ claude: ["codex"] });
    expect((out.agent as any).fallback.enabled).toBe(true);
  });

  test("canonical-only config passes through unchanged, no warnings", () => {
    const logger = makeLogger();
    const input = { agent: { default: "claude", fallback: { enabled: true, map: {} } } };
    const out = applyAgentConfigMigration(structuredClone(input), logger);
    expect(out).toEqual(input);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("mixed legacy + canonical — canonical wins, warning still fires", () => {
    const logger = makeLogger();
    const out = applyAgentConfigMigration(
      {
        agent: { default: "codex" },
        autoMode: { defaultAgent: "claude" },
      },
      logger,
    );
    expect((out.agent as any).default).toBe("codex");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("fallbackOrder with length 1 is a no-op (no fallback candidates)", () => {
    const logger = makeLogger();
    const out = applyAgentConfigMigration(
      { autoMode: { defaultAgent: "claude", fallbackOrder: ["claude"] } },
      logger,
    );
    expect((out.agent as any)?.fallback).toBeUndefined();
  });
});

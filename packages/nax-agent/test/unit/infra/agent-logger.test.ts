import { afterEach, describe, expect, test } from "bun:test";
import { type AgentLogger, getLogger, getSafeLogger, setAgentLogger } from "#src/infra/index";

function recordingLogger(): AgentLogger & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    error: (stage, message) => calls.push(`error:${stage}:${message}`),
    warn: (stage, message) => calls.push(`warn:${stage}:${message}`),
    info: (stage, message) => calls.push(`info:${stage}:${message}`),
    debug: (stage, message) => calls.push(`debug:${stage}:${message}`),
  };
}

describe("agent logger slot", () => {
  afterEach(() => setAgentLogger(null));

  test("getSafeLogger is null when unset", () => {
    setAgentLogger(null);
    expect(getSafeLogger()).toBeNull();
  });

  test("getLogger returns a silent no-op when unset and does not throw", () => {
    setAgentLogger(null);
    expect(() => getLogger().warn("stage", "message", { a: 1 })).not.toThrow();
  });

  test("both accessors serve the installed logger", () => {
    const logger = recordingLogger();
    setAgentLogger(logger);
    getSafeLogger()?.info("s", "one");
    getLogger().debug("s", "two");
    expect(logger.calls).toEqual(["info:s:one", "debug:s:two"]);
  });

  test("re-init replaces the slot", () => {
    const first = recordingLogger();
    const second = recordingLogger();
    setAgentLogger(first);
    setAgentLogger(second);
    getLogger().error("s", "m");
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(["error:s:m"]);
  });
});

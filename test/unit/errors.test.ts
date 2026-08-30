/**
 * The typed NaxError hierarchy — every subclass sets its own `name`, `code`,
 * and structured `context`, and chains through the `NaxError` base so callers
 * can catch by class or by `instanceof NaxError`.
 */
import { describe, expect, test } from "bun:test";
import {
  AgentNotFoundError,
  AgentNotInstalledError,
  LockAcquisitionError,
  NaxError,
  StoryLimitExceededError,
} from "@/errors";

describe("NaxError", () => {
  test("sets message, code, context, and name", () => {
    const err = new NaxError("boom", "SOME_CODE", { stage: "test" });
    expect(err.message).toBe("boom");
    expect(err.code).toBe("SOME_CODE");
    expect(err.context).toEqual({ stage: "test" });
    expect(err.name).toBe("NaxError");
    expect(err).toBeInstanceOf(Error);
  });

  test("context is optional", () => {
    const err = new NaxError("boom", "SOME_CODE");
    expect(err.context).toBeUndefined();
  });
});

describe("AgentNotFoundError", () => {
  test("carries agentName and binary in context, with the AGENT_NOT_FOUND code", () => {
    const err = new AgentNotFoundError("claude", "claude-bin");
    expect(err).toBeInstanceOf(NaxError);
    expect(err.name).toBe("AgentNotFoundError");
    expect(err.code).toBe("AGENT_NOT_FOUND");
    expect(err.message).toBe('Agent "claude" not found or not installed');
    expect(err.context).toEqual({ agentName: "claude", binary: "claude-bin" });
  });

  test("binary is optional", () => {
    const err = new AgentNotFoundError("claude");
    expect(err.context).toEqual({ agentName: "claude", binary: undefined });
  });
});

describe("AgentNotInstalledError", () => {
  test("carries agentName and binary in context, with the AGENT_NOT_INSTALLED code", () => {
    const err = new AgentNotInstalledError("claude", "/usr/local/bin/claude");
    expect(err).toBeInstanceOf(NaxError);
    expect(err.name).toBe("AgentNotInstalledError");
    expect(err.code).toBe("AGENT_NOT_INSTALLED");
    expect(err.message).toBe('Agent "claude" is not installed or not in PATH: /usr/local/bin/claude');
    expect(err.context).toEqual({ agentName: "claude", binary: "/usr/local/bin/claude" });
  });
});

describe("StoryLimitExceededError", () => {
  test("carries totalStories and limit in context, with the STORY_LIMIT_EXCEEDED code", () => {
    const err = new StoryLimitExceededError(50, 30);
    expect(err).toBeInstanceOf(NaxError);
    expect(err.name).toBe("StoryLimitExceededError");
    expect(err.code).toBe("STORY_LIMIT_EXCEEDED");
    expect(err.message).toBe("Feature exceeds story limit: 50 stories (max: 30)");
    expect(err.context).toEqual({ totalStories: 50, limit: 30 });
  });
});

describe("LockAcquisitionError", () => {
  test("carries workdir in context, with the LOCK_ACQUISITION_FAILED code", () => {
    const err = new LockAcquisitionError("/repo");
    expect(err).toBeInstanceOf(NaxError);
    expect(err.name).toBe("LockAcquisitionError");
    expect(err.code).toBe("LOCK_ACQUISITION_FAILED");
    expect(err.message).toBe("Another nax process is already running in this directory");
    expect(err.context).toEqual({ workdir: "/repo" });
  });
});

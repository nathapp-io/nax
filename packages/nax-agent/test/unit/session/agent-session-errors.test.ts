/**
 * S3-4: the facade's public error. A NaxError subclass so nax-agent's own
 * `instanceof NaxError` checks keep working, with a typed code for embedders
 * (NaxError itself is not on `.`).
 */
import { describe, expect, test } from "bun:test";
import { AgentSessionError } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";

describe("AgentSessionError", () => {
  test("is a NaxError with a typed code and the agent-session stage", () => {
    const err = new AgentSessionError("busy", "AGENT_SESSION_BUSY", { sessionId: "s1" });
    expect(err).toBeInstanceOf(NaxError);
    expect(err).toBeInstanceOf(AgentSessionError);
    expect(err.name).toBe("AgentSessionError");
    expect(err.code).toBe("AGENT_SESSION_BUSY");
    expect(err.message).toBe("busy");
    expect(err.context).toEqual({ stage: "agent-session", sessionId: "s1" });
  });

  test("context defaults to the stage alone", () => {
    expect(new AgentSessionError("x", "AGENT_SESSION_CLOSED").context).toEqual({ stage: "agent-session" });
  });
});

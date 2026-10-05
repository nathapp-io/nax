/**
 * S3-4: the facade's public error. A NaxError subclass so nax-agent's own
 * `instanceof NaxError` checks keep working, with a typed code for embedders
 * (NaxError itself is on `.` since S4-2, for backends).
 */
import { describe, expect, test } from "bun:test";
// Namespace import rather than a capitalized import rename: the escape-hatches
// ratchet would count a rename here as a loose cast (regex, no parser).
import * as publicEntry from "@nathapp/nax-agent";
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

  test("NaxError is on the public entry and is the class nax-agent throws (S4-2, spec §5.6)", () => {
    expect(publicEntry.NaxError).toBe(NaxError);
    expect(new AgentSessionError("x", "AGENT_SESSION_CLOSED")).toBeInstanceOf(publicEntry.NaxError);
  });

  test("the S4 codes construct AgentSessionErrors in the agent-session stage", () => {
    for (const code of [
      "AGENT_SESSION_BACKEND_UNAVAILABLE",
      "AGENT_SESSION_AUTH_REQUIRED",
      "AGENT_SESSION_CAPABILITY_UNSUPPORTED",
      "AGENT_SESSION_BACKEND_MISMATCH",
    ] as const) {
      const err = new AgentSessionError("x", code, { capability: "tools" });
      expect(err.code).toBe(code);
      expect(err.context).toMatchObject({ stage: "agent-session", capability: "tools" });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentSessionError, NaxError } from "@nathapp/nax-agent";
import {
  ACP_STOP_CODES,
  agentTextExcerpt,
  backendUnavailable,
  capabilityUnsupported,
  closedDuringOpen,
  EXCERPT_BYTES,
  openRequestError,
  promptRequestError,
  rpcErrorOf,
  stopReasonError,
} from "#src/client/errors";

const SECRET = "s3cr3t-token-value-0123";

describe("agentTextExcerpt (spec §7)", () => {
  test("replaces secret values, keeps newlines and tabs, strips other control characters", () => {
    const out = agentTextExcerpt(`line1\n\tvalue ${SECRET}\u0007\u001b[31m`, [SECRET]);
    expect(out).toBe("line1\n\tvalue [REDACTED][31m");
  });

  test("secrets shorter than 8 characters are not replaced verbatim", () => {
    expect(agentTextExcerpt("a short pw", ["short"])).toBe("a short pw");
  });

  test("caps at 4096 bytes without a broken trailing character", () => {
    const out = agentTextExcerpt("é".repeat(EXCERPT_BYTES), []);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(out.endsWith("�")).toBe(false);
  });
});

describe("stopReasonError (spec §5.7)", () => {
  test.each([
    ["max_tokens", "ACP_STOP_MAX_TOKENS"],
    ["max_turn_requests", "ACP_STOP_MAX_TURN_REQUESTS"],
    ["refusal", "ACP_STOP_REFUSAL"],
    ["cancelled", "ACP_STOP_CANCELLED"],
  ])("%s -> %s", (reason, code) => {
    const err = stopReasonError(reason);
    expect(err).toBeInstanceOf(NaxError);
    expect(err.code).toBe(code);
    expect(err.context).toMatchObject({ stage: "acp", stopReason: reason });
  });

  test.each(["pause", "__proto__", "toString", "constructor", "end_turn\u0000x"])(
    "an unknown stop reason %p is AGENT_SESSION_TURN_FAILED",
    (reason) => {
      expect(stopReasonError(reason).code).toBe("AGENT_SESSION_TURN_FAILED");
    },
  );

  test("the code table is frozen and complete", () => {
    expect(Object.isFrozen(ACP_STOP_CODES)).toBe(true);
    expect(Object.keys(ACP_STOP_CODES).sort()).toEqual(["cancelled", "max_tokens", "max_turn_requests", "refusal"]);
  });
});

describe("request errors (spec §6.3, §7)", () => {
  test("rpcErrorOf recognises only RequestError", () => {
    const rpc = new RequestError(-32603, "x");
    expect(rpcErrorOf(rpc)).toBe(rpc);
    expect(rpcErrorOf(new Error("x"))).toBeUndefined();
  });

  test("an auth error at open is AGENT_SESSION_AUTH_REQUIRED", () => {
    const err = openRequestError("session/new", RequestError.authRequired(), []);
    expect(err.code).toBe("AGENT_SESSION_AUTH_REQUIRED");
    expect(err.context).toMatchObject({ step: "session/new" });
  });

  test("any other open error is AGENT_SESSION_BACKEND_UNAVAILABLE with a redacted message", () => {
    const err = openRequestError("initialize", new RequestError(-32603, `bad ${SECRET}`), [SECRET]);
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("[REDACTED]");
    expect(err.message).not.toContain(SECRET);
    expect(err.context).toMatchObject({ step: "initialize", rpcCode: -32603 });
  });

  test("a prompt auth error is AGENT_SESSION_AUTH_REQUIRED; any other is AGENT_SESSION_TURN_FAILED", () => {
    expect(promptRequestError(RequestError.authRequired(), []).code).toBe("AGENT_SESSION_AUTH_REQUIRED");
    const failed = promptRequestError(new RequestError(-32603, `overloaded ${SECRET}`), [SECRET]);
    expect(failed).toBeInstanceOf(NaxError);
    expect(failed.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(failed.message).not.toContain(SECRET);
  });
});

describe("session errors", () => {
  test("capabilityUnsupported names the capability", () => {
    const err = capabilityUnsupported("tools", "no HTTP MCP");
    expect(err).toBeInstanceOf(AgentSessionError);
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
  });

  test("backendUnavailable carries its details", () => {
    expect(backendUnavailable("gone", { exitCode: 3 }).context).toMatchObject({ exitCode: 3 });
  });

  test("closedDuringOpen is AGENT_SESSION_CLOSED", () => {
    expect(closedDuringOpen("s-1").code).toBe("AGENT_SESSION_CLOSED");
  });
});

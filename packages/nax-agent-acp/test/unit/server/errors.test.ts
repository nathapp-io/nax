import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentSessionError, NaxError } from "@nathapp/nax-agent";
import {
  authRequired,
  guard,
  invalidParams,
  isAuthFailureCode,
  loginHint,
  TURN_IN_PROGRESS,
  toRequestError,
  turnInProgress,
  unknownSession,
} from "#src/server/errors";
import { recordingLogger } from "#test/helpers/recording-logger";

describe("error constructors (spec §7)", () => {
  test("turn in progress is invalid_request", () => {
    const error = turnInProgress();
    expect(error.code).toBe(-32600);
    expect(error.message).toBe(`Invalid request: ${TURN_IN_PROGRESS}`);
  });

  test("an unknown session is resource_not_found naming the id", () => {
    const error = unknownSession("s-1");
    expect(error.code).toBe(-32002);
    expect(error.data).toEqual({ uri: "s-1" });
  });

  test("invalidParams carries the message", () => {
    expect(invalidParams("cwd must be absolute").message).toBe("Invalid params: cwd must be absolute");
  });
});

describe("toRequestError", () => {
  test("passes a RequestError through unchanged", () => {
    const { logger } = recordingLogger();
    const original = RequestError.invalidParams(undefined, "x");
    expect(toRequestError(original, logger)).toBe(original);
  });

  test("maps AGENT_SESSION_INVALID_OPTIONS to invalid_params with its message", () => {
    const { logger, lines } = recordingLogger();
    const error = toRequestError(new AgentSessionError("bad model id", "AGENT_SESSION_INVALID_OPTIONS"), logger);
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("bad model id");
    expect(lines).toEqual([]);
  });

  test("maps AGENT_SESSION_BUSY to turn in progress", () => {
    const { logger } = recordingLogger();
    expect(toRequestError(new AgentSessionError("busy", "AGENT_SESSION_BUSY"), logger).message).toContain(
      TURN_IN_PROGRESS,
    );
  });

  test("anything else is internal_error with the message only, logged with its stack", () => {
    const { logger, lines } = recordingLogger();
    const error = toRequestError(new Error("boom"), logger);
    expect(error.code).toBe(-32603);
    expect(error.message).toBe("Internal error: boom");
    expect(error.data).toBeUndefined();
    expect(lines[0]).toMatchObject({ level: "error", message: "request failed", data: { error: "boom" } });
    expect(String(lines[0]?.data?.stack)).toContain("boom");
  });

  test("an unmapped facade error is internal too (auth_required lands in S5-4)", () => {
    const { logger } = recordingLogger();
    const error = toRequestError(new AgentSessionError("log in", "AGENT_SESSION_AUTH_REQUIRED"), logger);
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("log in");
  });

  test("a secret in an unexpected error's message never reaches the client (final review I-3)", () => {
    const { logger } = recordingLogger();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    const error = toRequestError(new Error(`401 Incorrect API key provided: ${secret}`), logger);
    expect(error.message).toContain("401 Incorrect API key provided");
    expect(error.message).not.toContain(secret);
  });

  test("a non-Error throw is stringified", () => {
    const { logger } = recordingLogger();
    expect(toRequestError("plain", logger).message).toBe("Internal error: plain");
  });
});

describe("guard", () => {
  test("returns the result and rethrows failures mapped", async () => {
    const { logger } = recordingLogger();
    expect(await guard(logger, async () => 7)).toBe(7);
    const caught = await guard(logger, async () => {
      throw new AgentSessionError("busy", "AGENT_SESSION_BUSY");
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RequestError);
    expect(caught instanceof RequestError ? caught.code : 0).toBe(-32600);
  });
});

describe("credential failures (S5-4 M-32)", () => {
  test("fail-auth and the credential-store codes are auth failures; others are not", () => {
    for (const code of [
      "fail-auth",
      "CREDENTIAL_HELPER_FAILED",
      "CREDENTIAL_HELPER_INVALID",
      "CREDENTIAL_CHANGED",
      "CREDENTIAL_FILE_UNREADABLE",
      "CREDENTIALS_NOT_CONFIGURED",
    ]) {
      expect(isAuthFailureCode(code)).toBe(true);
    }
    expect(isAuthFailureCode("fail-rate-limit")).toBe(false);
    expect(isAuthFailureCode("AGENT_SESSION_TURN_FAILED")).toBe(false);
  });

  test("authRequired is -32000 with the login hint and the data", () => {
    const error = authRequired('no credentials for provider "anthropic"', { provider: "anthropic" });
    expect(error.code).toBe(-32000);
    expect(error.message).toContain('no credentials for provider "anthropic"');
    expect(error.message).toContain(loginHint("anthropic"));
    expect(error.data).toEqual({ provider: "anthropic" });
  });

  test("a message ending in a full stop gets exactly one", () => {
    expect(authRequired("Credential authentication failed.", {}).message).not.toContain("..");
  });

  test("loginHint names both commands", () => {
    expect(loginHint("anthropic")).toBe(
      "Log in with `nax-agent login anthropic` (or `nax auth login anthropic`), then retry.",
    );
    expect(loginHint()).toBe("Log in with `nax-agent login <provider>` (or `nax auth login <provider>`), then retry.");
  });

  test("toRequestError maps a credential NaxError to auth_required, redacted", () => {
    const { logger } = recordingLogger();
    const mapped = toRequestError(
      new NaxError("helper printed sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "CREDENTIAL_HELPER_FAILED"),
      logger,
    );
    expect(mapped.code).toBe(-32000);
    expect(mapped.message).not.toContain("abcdefghijklmnop");
    expect(mapped.data).toEqual({ code: "CREDENTIAL_HELPER_FAILED" });
  });
});

import { describe, expect, test } from "bun:test";
import { parseAgentError } from "../../../../src/agents/acp/parse-agent-error";

describe("parseAgentError", () => {
  test("detects rate-limit from direct JSON type", () => {
    const result = parseAgentError('{"type":"rate-limit","retryAfterSeconds":60}');
    expect(result.type).toBe("rate-limit");
    expect(result.retryAfterSeconds).toBe(60);
  });

  test("detects auth from direct JSON type", () => {
    const result = parseAgentError('{"type":"auth"}');
    expect(result.type).toBe("auth");
  });

  test("detects rate-limit from JSON statusCode", () => {
    const result = parseAgentError('{"statusCode":429}');
    expect(result.type).toBe("rate-limit");
  });

  test("detects auth from JSON statusCode", () => {
    const result = parseAgentError('{"statusCode":401}');
    expect(result.type).toBe("auth");
  });

  test("detects rate-limit from bracketed acpx codes", () => {
    const result = parseAgentError("acpx session failed [ACPX_RATE_LIMIT/TOO_MANY_REQUESTS]");
    expect(result.type).toBe("rate-limit");
  });

  test("detects auth from bracketed acpx codes", () => {
    const result = parseAgentError("acpx auth failed [AUTH_FAILED/PERMISSION_DENIED]");
    expect(result.type).toBe("auth");
  });

  test("detects structured key-value status codes", () => {
    const rateLimit = parseAgentError("statusCode=429");
    const auth = parseAgentError("code=403");
    expect(rateLimit.type).toBe("rate-limit");
    expect(auth.type).toBe("auth");
  });

  test("does not infer rate-limit from free-text phrases", () => {
    const result = parseAgentError("Rate limit hit, retry after 60");
    expect(result.type).toBe("unknown");
  });

  test("does not infer auth from free-text phrases", () => {
    const result = parseAgentError("Unauthorized request");
    expect(result.type).toBe("unknown");
  });

  test("returns unknown for empty or unstructured errors", () => {
    expect(parseAgentError("").type).toBe("unknown");
    expect(parseAgentError("something went wrong").type).toBe("unknown");
  });
});

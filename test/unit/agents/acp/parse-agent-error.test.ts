import { describe, expect, test } from "bun:test";
import { parseAgentError } from "../../../../src/agents/acp/parse-agent-error";

describe("parseAgentError", () => {
  test("detects 429 status code as rate-limit", () => {
    const result = parseAgentError("429 Too Many Requests");
    expect(result.type).toBe("rate-limit");
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  test("detects lowercase 'rate limit' as rate-limit", () => {
    const result = parseAgentError("rate limit exceeded");
    expect(result.type).toBe("rate-limit");
  });

  test("detects capitalized 'Rate limit' as rate-limit", () => {
    const result = parseAgentError("Rate limit hit, retry after 60");
    expect(result.type).toBe("rate-limit");
  });

  test("extracts retryAfterSeconds when present in rate limit message", () => {
    const result = parseAgentError("Rate limit hit, retry after 60 seconds");
    expect(result.type).toBe("rate-limit");
    expect(result.retryAfterSeconds).toBe(60);
  });

  test("extracts retryAfterSeconds from different numeric patterns", () => {
    const result = parseAgentError("rate limit, please retry after 120 seconds");
    expect(result.type).toBe("rate-limit");
    expect(result.retryAfterSeconds).toBe(120);
  });

  test("detects 401 status code as auth", () => {
    const result = parseAgentError("401 Unauthorized");
    expect(result.type).toBe("auth");
  });

  test("detects 403 status code as auth", () => {
    const result = parseAgentError("403 Forbidden");
    expect(result.type).toBe("auth");
  });

  test("detects lowercase 'unauthorized' as auth", () => {
    const result = parseAgentError("unauthorized access");
    expect(result.type).toBe("auth");
  });

  test("detects capitalized 'Unauthorized' as auth", () => {
    const result = parseAgentError("Unauthorized request");
    expect(result.type).toBe("auth");
  });

  test("detects lowercase 'forbidden' as auth", () => {
    const result = parseAgentError("forbidden resource");
    expect(result.type).toBe("auth");
  });

  test("detects capitalized 'Forbidden' as auth", () => {
    const result = parseAgentError("Forbidden access denied");
    expect(result.type).toBe("auth");
  });

  test("returns unknown for unrecognized error patterns", () => {
    const result = parseAgentError("process exited with code 1");
    expect(result.type).toBe("unknown");
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  test("returns unknown for empty string", () => {
    const result = parseAgentError("");
    expect(result.type).toBe("unknown");
  });

  test("returns unknown for generic error message", () => {
    const result = parseAgentError("something went wrong");
    expect(result.type).toBe("unknown");
  });

  test("prioritizes first recognized pattern", () => {
    const result = parseAgentError("rate limit and 401 auth error");
    expect(result.type).toBe("rate-limit");
  });
});

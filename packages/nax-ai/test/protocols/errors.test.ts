import { describe, expect, it } from "vitest";
import { classifyHttpError, classifyThrown, parseRetryAfter } from "../../src/protocols/errors.ts";

describe("classifyHttpError", () => {
  it.each([
    [undefined, "unknown"],
    [401, "auth"],
    [403, "auth"],
    [429, "rate-limit"],
    [503, "overloaded"],
    [529, "overloaded"],
    [400, "bad-request"],
    [404, "bad-request"],
    [500, "transport"],
    [502, "transport"],
    [200, "unknown"],
  ] as const)("classifies %s as %s", (status, kind) => {
    expect(classifyHttpError(status)).toBe(kind);
  });

  it("prefers the specific classification over the range for 429 and 503", () => {
    expect(classifyHttpError(429)).not.toBe("bad-request");
    expect(classifyHttpError(503)).not.toBe("transport");
  });
});

describe("parseRetryAfter", () => {
  it("reads a numeric retry-after in seconds", () => {
    expect(parseRetryAfter({ "retry-after": "30" })).toBe(30);
  });

  it("is case-insensitive on the header name", () => {
    expect(parseRetryAfter({ "Retry-After": "12" })).toBe(12);
  });

  it("returns undefined for an HTTP-date value rather than guessing", () => {
    expect(parseRetryAfter({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).toBeUndefined();
  });

  it("returns undefined when absent or when headers are absent", () => {
    expect(parseRetryAfter({})).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("returns undefined for a negative value", () => {
    expect(parseRetryAfter({ "retry-after": "-5" })).toBeUndefined();
  });
});

describe("classifyThrown", () => {
  it("classifies an arbitrary throw as a transport fault, preserving cause and message", () => {
    const cause = new Error("socket hang up");
    const error = classifyThrown(cause);
    expect(error.kind).toBe("transport");
    expect(error.message).toBe("socket hang up");
    expect(error.cause).toBe(cause);
  });

  it("stringifies a non-Error throw rather than losing it", () => {
    const error = classifyThrown("connection reset");
    expect(error.kind).toBe("transport");
    expect(error.message).toBe("connection reset");
    expect(error.cause).toBe("connection reset");
  });
});

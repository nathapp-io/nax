import { describe, expect, it } from "vitest";
import {
  classifyHttpError,
  classifyProviderError,
  classifyThrown,
  parseRetryAfter,
} from "../../src/protocols/errors.ts";

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

describe("classifyProviderError", () => {
  // Phrasings observed in provider documentation and error payloads. They are
  // upstream wire strings and will drift; this table is the contract, and a
  // provider that rewords its message shows up here as a failing case rather
  // than as a silently terminal run.
  it.each([
    ["anthropic", "prompt is too long: 205780 tokens > 200000 maximum"],
    ["anthropic max_tokens", "input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000"],
    [
      "openai",
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
    ],
    ["openai code", "context_length_exceeded"],
    ["google", "The input token count (1052) exceeds the maximum number of tokens allowed (1024)."],
    ["bedrock", "Input is too long for requested model."],
    ["groq", "Please reduce the length of the messages or completion."],
    ["cohere", "too many tokens in the request"],
  ])("classifies %s's overflow message as context-overflow", (_provider, message) => {
    expect(classifyProviderError(400, message)).toBe("context-overflow");
  });

  it("matches regardless of case, because providers do not agree on it", () => {
    expect(classifyProviderError(400, "PROMPT IS TOO LONG: 205780 tokens > 200000 maximum")).toBe("context-overflow");
  });

  it("leaves an unrecognised 4xx as bad-request rather than guessing", () => {
    expect(classifyProviderError(400, "tools.0.custom.name: String should match pattern")).toBe("bad-request");
    expect(classifyProviderError(404, "model not found")).toBe("bad-request");
  });

  it("falls back to the status verdict when there is no message", () => {
    expect(classifyProviderError(400, undefined)).toBe("bad-request");
    expect(classifyProviderError(429, undefined)).toBe("rate-limit");
    // An absent status is the one case with no status verdict to fall back to;
    // nax#1869 gives it the broken-stream answer instead. Asserted in
    // "a stream that broke under a non-failing status" below.
  });

  it("refines only bad-request, so a token-shaped message on a failing status keeps its kind", () => {
    // A rate limit that mentions tokens is still a rate limit: the caller
    // should wait, not compact.
    expect(classifyProviderError(429, "rate limit reached: too many tokens per minute")).toBe("rate-limit");
    expect(classifyProviderError(500, "prompt is too long")).toBe("transport");
    // Not context-overflow: an overflow always arrives on a failing status, so
    // declining to guess one from a broken stream still costs nothing.
    expect(classifyProviderError(undefined, "prompt is too long")).not.toBe("context-overflow");
  });

  it("agrees with classifyHttpError on every failing status when no message is given", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 529]) {
      expect(classifyProviderError(status, undefined)).toBe(classifyHttpError(status));
    }
  });

  // nax#1869. An error event under a status that is not itself a failure means
  // the response headers were fine and the stream broke afterwards -- the exact
  // shape OpenRouter's "Upstream idle timeout exceeded" arrives in, inside a
  // 200 OK SSE body. classifyHttpError sees only the status and must answer
  // "unknown" for it; that verdict cost a real run its agent swap and nax-ai's
  // own transport retry, because both are keyed on "transport".
  describe("a stream that broke under a non-failing status", () => {
    it.each([200, 201, 204, 301, 399])("classifies an error event on %s as transport", (status) => {
      expect(classifyProviderError(status, "Upstream idle timeout exceeded")).toBe("transport");
    });

    it("classifies an error event with no observed response as transport", () => {
      // The sibling path for the same fault -- a raw throw with no response --
      // is classifyThrown, which answers "transport". An error event that
      // arrived without one is the same fault and gets the same answer.
      expect(classifyProviderError(undefined, "Upstream idle timeout exceeded")).toBe("transport");
      expect(classifyProviderError(undefined, undefined)).toBe("transport");
    });

    // nax-ai retries "transport" internally (retry.ts). Rate limits and
    // overload capacity are consumer policy and must never be retried here
    // (protocol architecture spec, §10.1), so a mid-stream error that carries
    // policy content keeps its policy kind even under a 200.
    it.each([
      ["rate-limit", "Rate limit exceeded: free-models-per-day"],
      ["rate-limit", "429 Too Many Requests"],
      ["rate-limit", "You exceeded your current quota, please check your plan and billing details."],
      ["overloaded", "The upstream provider is overloaded. Please try again later."],
      ["overloaded", "Model is currently overloaded_error"],
    ] as const)("keeps a mid-stream %s payload out of transport", (kind, message) => {
      expect(classifyProviderError(200, message)).toBe(kind);
    });

    it("matches policy markers regardless of case", () => {
      expect(classifyProviderError(200, "RATE LIMIT EXCEEDED")).toBe("rate-limit");
    });

    it("does not read policy markers from a failing status it already classified", () => {
      // 503 is overloaded by status; a rate-limit phrase in its body must not
      // relabel it, because the status is the stronger signal.
      expect(classifyProviderError(503, "rate limit exceeded")).toBe("overloaded");
    });
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

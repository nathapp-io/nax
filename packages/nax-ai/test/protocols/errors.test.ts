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

  it("refines only bad-request or a broken stream, so a token-shaped message on a genuine 5xx keeps transport", () => {
    // A rate limit that mentions tokens is still a rate limit: the caller
    // should wait, not compact.
    expect(classifyProviderError(429, "rate limit reached: too many tokens per minute")).toBe("rate-limit");
    // 500 has its own verdict (transport) that outranks bad-request-only
    // refinement, so the message is never consulted here.
    expect(classifyProviderError(500, "prompt is too long")).toBe("transport");
  });

  it("reads overflow markers from an absent status too (nax#44)", () => {
    // Corrected premise: an overflow does NOT always arrive on a failing
    // status (see nax#44), so an absent status is no longer exempted -- it is
    // classified the same way a non-failing status is, via classifyBrokenStream.
    expect(classifyProviderError(undefined, "prompt is too long")).toBe("context-overflow");
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

  // nax#44. OpenRouter (and other OpenAI-compatible aggregators) answer HTTP
  // 200 and relay an upstream provider's 4xx as a stream `error` event, with
  // `code: 400` inside the JSON payload -- so a genuine context overflow can
  // arrive under a status that is not itself a failure. Before this fix,
  // isNonFailingStatus(200) short-circuited straight to classifyBrokenStream
  // and the overflow markers were never consulted; the oversized prompt was
  // filed as `transport` and simply retried by transport, never compacted.
  describe("an overflow relayed in-stream under a non-failing status (nax#44)", () => {
    const verbatimOverflowMessage =
      "Requested token count exceeds the model's maximum context length of 1048576 tokens. " +
      "You requested a total of 1050647 tokens: 177022 tokens from the input messages and " +
      "873625 tokens for the completion. Please reduce the number of tokens in the input " +
      "messages or the completion to fit within the limit.";

    it("classifies the verbatim aggregator-relayed message as context-overflow under 200", () => {
      expect(classifyProviderError(200, verbatimOverflowMessage)).toBe("context-overflow");
    });

    it("keeps classifying the same message as context-overflow under its real 400 (no #29 regression)", () => {
      expect(classifyProviderError(400, verbatimOverflowMessage)).toBe("context-overflow");
    });

    it("classifies a bare overflow code as context-overflow under 200", () => {
      expect(classifyProviderError(200, "context_length_exceeded")).toBe("context-overflow");
    });

    it("does not widen bad-request: an ordinary malformed 400 stays bad-request", () => {
      expect(classifyProviderError(400, "tools.0.custom.name: String should match pattern")).toBe("bad-request");
    });

    it("keeps a genuine idle-timeout transport fault out of context-overflow under 200 (no #29 regression)", () => {
      expect(classifyProviderError(200, "Upstream idle timeout exceeded")).toBe("transport");
    });

    it("keeps a real rate-limit status authoritative even when the body's wording overlaps an overflow marker", () => {
      // "Too many tokens" here is throttling language, not an overflow -- but
      // it happens to contain the existing (pre-#44, out-of-scope-to-fix)
      // "too many tokens" overflow marker. A genuinely failing 429 has its own
      // verdict and short-circuits before any message is consulted, so status
      // precedence protects this case.
      //
      // Note: this message is now also kept out of context-overflow under a
      // NON-failing status, and under a plain 400, by NON_OVERFLOW_MARKERS --
      // status precedence is no longer the only thing protecting it.
      expect(classifyProviderError(429, "ThrottlingException: Too many tokens, please wait before trying again")).toBe(
        "rate-limit",
      );
    });

    it("keeps a throttle out of context-overflow under a non-failing status and a plain 400", () => {
      // The exclusion, not status precedence. Both of these consult the
      // overflow table, and "too many tokens" matches it verbatim.
      const throttle = "ThrottlingException: Too many tokens, please wait before trying again";
      expect(classifyProviderError(200, throttle)).toBe("transport");
      expect(classifyProviderError(400, throttle)).toBe("bad-request");
    });
  });

  // Marker coverage. Each entry is a real phrasing documented by the provider
  // or captured from its payload; one case per phrasing, so a reworded message
  // shows up as a failing case rather than a run that silently gives up on a
  // recoverable fault. Asserted under 200 (the aggregator-relay shape of
  // nax#44) and 400 (the direct shape), because both must reach the table.
  describe("context-overflow phrasings across providers", () => {
    const cases: readonly (readonly [provider: string, message: string])[] = [
      ["Anthropic", "prompt is too long: 213462 tokens > 200000 maximum"],
      ["Anthropic 413", '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}'],
      ["OpenAI", "Your input exceeds the context window of this model"],
      ["OpenAI/LiteLLM", "Requested token count exceeds the model's maximum context length of 131072 tokens"],
      ["OpenAI-compatible", "Input length (265330) exceeds model's maximum context length (262144)."],
      ["Google Gemini", "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"],
      ["xAI Grok", "This model's maximum prompt length is 131072 but the request contains 537812 tokens"],
      ["Groq", "Please reduce the length of the messages or completion"],
      [
        "OpenRouter",
        "This endpoint's maximum context length is 131072 tokens. However, you requested about 200000 tokens",
      ],
      ["OpenRouter/Poolside", "Input length 265330 exceeds the maximum allowed input length of 262144 tokens."],
      ["Together AI", "The input (265330 tokens) is longer than the model's context length (262144 tokens)."],
      ["llama.cpp", "the request exceeds the available context size, try increasing it"],
      ["LM Studio", "tokens to keep from the initial prompt is greater than the context length"],
      ["GitHub Copilot", "prompt token count of 265330 exceeds the limit of 262144"],
      ["MiniMax", "invalid params, context window exceeds limit"],
      ["Kimi For Coding", "Your request exceeded model token limit: 262144 (requested: 265330)"],
      ["DS4 server", "Prompt has 265330 tokens, but the configured context size is 262144 tokens"],
      ["Mistral", "Prompt contains 265330 tokens, too large for model with 262144 maximum context length"],
      ["DashScope/Qwen", "Range of input length should be [1, 129024]"],
      ["Ollama", "prompt too long; exceeded max context length by 3186 tokens"],
      ["z.ai", "model_context_window_exceeded"],
    ];

    for (const [provider, message] of cases) {
      it(`recognises ${provider}`, () => {
        expect(classifyProviderError(200, message)).toBe("context-overflow");
        expect(classifyProviderError(400, message)).toBe("context-overflow");
      });
    }

    it("leaves unrelated failures alone", () => {
      // None of these name a context limit; widening the table must not drag
      // them in. The 5xx and 429 are covered by status precedence; the 400 and
      // the 200 actually reach the marker table.
      expect(classifyProviderError(400, "tools.0.custom.name: String should match pattern")).toBe("bad-request");
      expect(classifyProviderError(200, "Upstream idle timeout exceeded")).toBe("transport");
      expect(classifyProviderError(200, "Provider returned error")).toBe("transport");
      expect(classifyProviderError(401, "invalid api key")).toBe("auth");
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

describe("classifyThrown", () => {
  it("classifies a throw carrying a 429 status as rate-limit, with its retryAfter", () => {
    const thrown = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "retry-after": "30" },
    });
    const error = classifyThrown(thrown);
    expect(error.kind).toBe("rate-limit");
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(30);
  });

  it("classifies a throw carrying a 401 status as auth", () => {
    const thrown = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(classifyThrown(thrown).kind).toBe("auth");
  });

  it("reads a status from statusCode and from response.status", () => {
    expect(classifyThrown(Object.assign(new Error("x"), { statusCode: 429 })).kind).toBe("rate-limit");
    expect(classifyThrown(Object.assign(new Error("x"), { response: { status: 429 } })).kind).toBe("rate-limit");
  });

  it("reads retryAfter from response.headers", () => {
    const thrown = Object.assign(new Error("x"), {
      response: { status: 429, headers: { "Retry-After": "12" } },
    });
    expect(classifyThrown(thrown).retryAfter).toBe(12);
  });

  it("still classifies a throw with no status as transport", () => {
    expect(classifyThrown(new Error("ECONNRESET")).kind).toBe("transport");
    expect(classifyThrown("boom").kind).toBe("transport");
    expect(classifyThrown(undefined).kind).toBe("transport");
  });

  it("classifies a non-numeric or out-of-range status as transport", () => {
    expect(classifyThrown(Object.assign(new Error("x"), { status: "429" })).kind).toBe("transport");
    expect(classifyThrown(Object.assign(new Error("x"), { status: Number.NaN })).kind).toBe("transport");
  });

  it("preserves the original thrown value as cause", () => {
    const thrown = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(classifyThrown(thrown).cause).toBe(thrown);
  });
});

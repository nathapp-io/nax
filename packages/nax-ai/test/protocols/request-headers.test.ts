/**
 * Per-request headers.
 *
 * A neutral map, and the escape hatch for anything this package does not model.
 * Session affinity later became modelled (see session-id.test.ts), so the
 * original framing here — "not a `sessionId` and certainly not a vendor's
 * header name" — no longer holds and has been dropped rather than left to
 * contradict the code.
 */
import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AuthResolver } from "../../src/auth/resolver.ts";
import { createPiDeps, toPiOptions } from "../../src/protocols/pi-client.ts";
import { assertValidHeaders, assertValidSessionId, mergeRequestHeaders } from "../../src/protocols/request-headers.ts";
import type { ProtocolRequest } from "../../src/protocols/types.ts";

const BASE: ProtocolRequest = { model: "m", messages: [] };

async function* emptyStream(): AsyncGenerator<AssistantMessageEvent> {}

describe("toPiOptions headers", () => {
  it("forwards a request's headers under pi's name", () => {
    expect(toPiOptions({ ...BASE, headers: { "x-opencode-session": "s-1" } }).headers).toEqual({
      "x-opencode-session": "s-1",
    });
  });

  it("omits headers entirely when none were supplied", () => {
    expect("headers" in toPiOptions(BASE)).toBe(false);
  });
});

describe("mergeRequestHeaders", () => {
  it("keeps request headers when there are no auth headers", () => {
    expect(mergeRequestHeaders({ "x-opencode-session": "s-1" }, undefined)).toEqual({
      "x-opencode-session": "s-1",
    });
  });

  it("keeps auth headers when there are no request headers", () => {
    expect(mergeRequestHeaders(undefined, { authorization: "Bearer k" })).toEqual({
      authorization: "Bearer k",
    });
  });

  it("carries both when they do not collide", () => {
    expect(mergeRequestHeaders({ "x-opencode-session": "s-1" }, { authorization: "Bearer k" })).toEqual({
      "x-opencode-session": "s-1",
      authorization: "Bearer k",
    });
  });

  it("lets auth win a collision, so a caller cannot clobber a credential header", () => {
    expect(mergeRequestHeaders({ authorization: "Bearer caller" }, { authorization: "Bearer real" })).toEqual({
      authorization: "Bearer real",
    });
  });

  it("returns undefined when neither side has any, so the option stays absent", () => {
    expect(mergeRequestHeaders(undefined, undefined)).toBeUndefined();
  });

  it('drops a null auth header, pi-ai\'s "do not send this" convention', () => {
    expect(mergeRequestHeaders({ "x-opencode-session": "s-1" }, { authorization: null })).toEqual({
      "x-opencode-session": "s-1",
    });
  });

  it("lets a null auth header suppress a request header of the same name", () => {
    expect(mergeRequestHeaders({ authorization: "Bearer caller" }, { authorization: null })).toEqual({});
  });
});

describe("assertValidHeaders", () => {
  it("accepts an ordinary header", () => {
    expect(() => assertValidHeaders({ "x-opencode-session": "s-1" })).not.toThrow();
  });

  it("rejects a newline in a value, which would splice in a second header", () => {
    expect(() => assertValidHeaders({ "x-opencode-session": "s-1\r\nx-injected: 1" })).toThrow(/value/i);
  });

  it("rejects a bare linefeed too, not just CRLF", () => {
    expect(() => assertValidHeaders({ "x-opencode-session": "s-1\nx-injected: 1" })).toThrow(/value/i);
  });

  it("rejects a name that is not a token", () => {
    expect(() => assertValidHeaders({ "x opencode session": "s-1" })).toThrow(/name/i);
  });

  it("rejects an empty name", () => {
    expect(() => assertValidHeaders({ "": "s-1" })).toThrow(/name/i);
  });

  it("names the offending header, so the error is actionable", () => {
    expect(() => assertValidHeaders({ "x-bad": "a\nb" })).toThrow(/x-bad/);
  });
});

describe("createPiDeps header wiring", () => {
  it("puts a request's headers on the pi call", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_model, _context, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("deepseek-v4-flash", "opencode-go");

    for await (const _ of deps.stream(
      model,
      { messages: [] },
      { headers: { "x-opencode-session": "s-1" } },
      () => {},
    )) {
      // drain
    }

    expect(seen?.headers).toMatchObject({ "x-opencode-session": "s-1" });
  });
});

/**
 * The merge itself, exercised with auth headers actually present.
 *
 * The original wiring test could not observe the bug it was written for: the
 * default resolver returns `{}` for every provider unless a credential store is
 * configured, so `auth.headers` was always undefined and the buggy branch —
 * spreading auth OVER the options object — never fired. Reverting the fix left
 * that test green. These inject a resolver so the merge is reachable.
 */
describe("createPiDeps auth/request header merge", () => {
  const resolverWith = (headers: Record<string, string>): AuthResolver => ({
    resolve: async () => ({ apiKey: "k", headers }),
  });

  async function optionsFrom(resolver: AuthResolver, req: SimpleStreamOptions) {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps(
      {},
      (_m, _c, options) => {
        seen = options;
        return emptyStream();
      },
      resolver,
    );
    const model = await deps.resolveModel("deepseek-v4-flash", "opencode-go");
    for await (const _ of deps.stream(model, { messages: [] }, req, () => {})) {
      // drain
    }
    return seen;
  }

  it("keeps a request header when auth also supplies one", async () => {
    const seen = await optionsFrom(resolverWith({ authorization: "Bearer real" }), {
      headers: { "x-trace": "t-1" },
    });
    expect(seen?.headers).toEqual({ "x-trace": "t-1", authorization: "Bearer real" });
  });

  it("keeps the vendor session header when auth also supplies one", async () => {
    const seen = await optionsFrom(resolverWith({ authorization: "Bearer real" }), { sessionId: "s-1" });
    expect(seen?.headers).toMatchObject({ "x-opencode-session": "s-1", authorization: "Bearer real" });
  });

  it("lets auth win a collision that differs only in case", async () => {
    const seen = await optionsFrom(resolverWith({ authorization: "Bearer real" }), {
      headers: { Authorization: "Bearer caller" },
    });
    expect(seen?.headers).toEqual({ authorization: "Bearer real" });
  });
});

describe("header option absence", () => {
  it("sends no headers option at all when there is nothing to send", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("gpt-5.4", "openai-codex");

    for await (const _ of deps.stream(model, { messages: [] }, {}, () => {})) {
      // drain
    }

    expect(seen && "headers" in seen).toBe(false);
  });
});

describe("assertValidHeaders — cases the message promises but nothing covered", () => {
  it("rejects a NUL, which the error message names", () => {
    expect(() => assertValidHeaders({ "x-a": "a\0b" })).toThrow(/NUL/);
  });

  it("rejects a non-string value instead of dropping it silently", () => {
    expect(() => assertValidHeaders({ "x-a": 1 as unknown as string })).toThrow(/expected a string/);
  });

  it.each(["x_foo", "a!#$%&'*+-.^_`|~", "X-Trace-Id"])("accepts %s, a legal token", (name) => {
    expect(() => assertValidHeaders({ [name]: "v" })).not.toThrow();
  });
});

describe("assertValidSessionId", () => {
  it("accepts an ordinary id", () => {
    expect(() => assertValidSessionId("abc123")).not.toThrow();
  });

  it("accepts absence", () => {
    expect(() => assertValidSessionId(undefined)).not.toThrow();
  });

  it("rejects a value that would splice a header, as the header path does", () => {
    expect(() => assertValidSessionId("s-1\r\nx-injected: 1")).toThrow(/sessionId/);
  });
});

describe("mergeRequestHeaders case handling", () => {
  it("drops the request spelling of a name auth also sets, whatever the case", () => {
    expect(mergeRequestHeaders({ Authorization: "Bearer caller" }, { authorization: "Bearer real" })).toEqual({
      authorization: "Bearer real",
    });
  });

  it("leaves unrelated names alone", () => {
    expect(mergeRequestHeaders({ "X-Trace": "t" }, { authorization: "a" })).toEqual({
      "X-Trace": "t",
      authorization: "a",
    });
  });
});

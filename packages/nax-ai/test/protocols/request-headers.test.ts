/**
 * Per-request headers.
 *
 * nax-ai's scope boundary (src/index.ts) says this package "deliberately knows
 * nothing about any consumer's domain concepts (stories, operations, sessions,
 * permission policy)". So the surface here is a neutral header map, not a
 * `sessionId` and certainly not a vendor's header name: the consumer decides
 * that a request carries `x-opencode-session`, and this package only carries it.
 */
import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPiDeps, toPiOptions } from "../../src/protocols/pi-client.ts";
import { assertValidHeaders, mergeRequestHeaders } from "../../src/protocols/request-headers.ts";
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

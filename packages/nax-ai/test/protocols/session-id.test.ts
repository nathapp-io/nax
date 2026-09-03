/**
 * Per-request session id.
 *
 * A session id is a wire concern, not a consumer concept: pi-ai already models
 * it (`SimpleStreamOptions.sessionId` — "providers can use this to enable
 * prompt caching, request routing, or other session-aware features"), and this
 * package's job is to reach it. What a session *is* stays the consumer's to
 * decide; nax-ai only carries the id and knows which vendors want it spelled
 * out in a header of their own.
 *
 * Forwarding the id is most of the value: pi-ai selects `x-session-id`,
 * `session_id`, `x-client-request-id` and `x-session-affinity` from a per-MODEL
 * compat flag, and keys prompt caching off the same value. OpenCode is the
 * exception pi-ai has no support for at all.
 */
import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPiDeps, toPiOptions } from "../../src/protocols/pi-client.ts";
import { vendorSessionHeaders } from "../../src/protocols/session-id.ts";
import type { ProtocolRequest } from "../../src/protocols/types.ts";

const BASE: ProtocolRequest = { model: "m", messages: [] };

async function* emptyStream(): AsyncGenerator<AssistantMessageEvent> {}

describe("toPiOptions sessionId", () => {
  it("forwards the session id, which is what drives pi's own affinity and caching", () => {
    expect(toPiOptions({ ...BASE, sessionId: "s-1" }).sessionId).toBe("s-1");
  });

  it("omits it entirely when the caller supplied none", () => {
    expect("sessionId" in toPiOptions(BASE)).toBe(false);
  });
});

describe("vendorSessionHeaders", () => {
  it.each(["opencode", "opencode-go"])("adds x-opencode-session for %s, which pi-ai never sends", (provider) => {
    expect(vendorSessionHeaders(provider, "s-1")).toEqual({ "x-opencode-session": "s-1" });
  });

  it.each(["openrouter", "openai", "anthropic", "deepseek"])(
    "adds nothing for %s, whose headers pi-ai already derives from sessionId",
    (provider) => {
      expect(vendorSessionHeaders(provider, "s-1")).toBeUndefined();
    },
  );

  it("adds nothing when there is no session id", () => {
    expect(vendorSessionHeaders("opencode-go", undefined)).toBeUndefined();
  });
});

describe("createPiDeps session wiring", () => {
  it("passes the session id through to pi", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("deepseek-v4-flash", "opencode-go");

    for await (const _ of deps.stream(model, { messages: [] }, { sessionId: "s-1" }, () => {})) {
      // drain
    }

    expect(seen?.sessionId).toBe("s-1");
  });

  it("adds the opencode header alongside it, since pi-ai has none", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("deepseek-v4-flash", "opencode-go");

    for await (const _ of deps.stream(model, { messages: [] }, { sessionId: "s-1" }, () => {})) {
      // drain
    }

    expect(seen?.headers).toMatchObject({ "x-opencode-session": "s-1" });
  });

  it("leaves a non-opencode provider's headers alone", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("gpt-5.4", "openai-codex");

    for await (const _ of deps.stream(model, { messages: [] }, { sessionId: "s-1" }, () => {})) {
      // drain
    }

    expect(seen?.headers?.["x-opencode-session"]).toBeUndefined();
    expect(seen?.sessionId).toBe("s-1");
  });
});

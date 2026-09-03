/**
 * Session affinity on the native path.
 *
 * Two separable things, deliberately not one:
 *
 *  - the session id is provider-agnostic. Every native session has one, derived
 *    the same way whoever ends up serving the request.
 *  - which header carries it is per-provider, because vendors disagree on the
 *    name. OpenCode documents `x-opencode-session`; pi-ai sends `x-session-id`
 *    for openrouter.
 *
 * Keeping the id independent is what stops this being an opencode special case:
 * adding a vendor is a row in a table, not a new concept.
 */
import { describe, expect, test } from "bun:test";
import { nativeSessionId, sessionAffinityHeaders } from "@/agents/native/session-affinity";

describe("nativeSessionId", () => {
  test("is stable for the same session, which is the whole point of affinity", () => {
    expect(nativeSessionId("impl-US-001")).toBe(nativeSessionId("impl-US-001"));
  });

  test("differs between sessions", () => {
    expect(nativeSessionId("impl-US-001")).not.toBe(nativeSessionId("impl-US-002"));
  });

  test("does not leak the session key, which names a role, story and feature", () => {
    const id = nativeSessionId("implementer-US-001-auth-system");
    expect(id).not.toContain("US-001");
    expect(id).not.toContain("auth-system");
    expect(id).not.toContain("implementer");
  });

  test("is a legal header value whatever the key contained", () => {
    expect(nativeSessionId("weird\r\nkey: injected")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("sessionAffinityHeaders", () => {
  test.each(["opencode", "opencode-go"])("sends x-opencode-session to %s", (provider) => {
    expect(sessionAffinityHeaders(provider, "s-1")).toEqual({
      "x-opencode-session": nativeSessionId("s-1"),
    });
  });

  test("sends openrouter its own spelling of the same id", () => {
    expect(sessionAffinityHeaders("openrouter", "s-1")).toEqual({
      "x-session-id": nativeSessionId("s-1"),
    });
  });

  test("carries the same id across vendors, differing only in header name", () => {
    const go = sessionAffinityHeaders("opencode-go", "s-1")?.["x-opencode-session"];
    const or = sessionAffinityHeaders("openrouter", "s-1")?.["x-session-id"];
    expect(go).toBe(or);
  });

  test.each(["anthropic", "openai", "deepseek", "unknown"])(
    "sends nothing to %s, whose header is a per-model property nax cannot see",
    (provider) => {
      expect(sessionAffinityHeaders(provider, "s-1")).toBeUndefined();
    },
  );
});

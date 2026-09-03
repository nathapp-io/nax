/**
 * Session identity on the native path.
 *
 * nax derives the id and stops. Which header carries it — and the whole
 * per-model affinity and prompt-cache mapping beneath it — belongs to nax-ai,
 * which is the layer that knows providers. An earlier revision kept a vendor
 * table here; that made nax learn a vocabulary it has no reason to know, and
 * it could not reach the openai-format providers at all, because their header
 * is chosen from a per-model property nax-ai does not expose.
 */
import { describe, expect, test } from "bun:test";
import { nativeSessionId, newSessionKey } from "@/agents/native/session-affinity";

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

  test("is safe to put on the wire whatever the key contained", () => {
    expect(nativeSessionId("weird\r\nkey: injected")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("newSessionKey", () => {
  test("is fresh each time, so unrelated callers do not collide", () => {
    expect(newSessionKey()).not.toBe(newSessionKey());
  });
});

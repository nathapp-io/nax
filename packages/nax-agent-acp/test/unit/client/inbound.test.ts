import { describe, expect, test } from "bun:test";
import type { PermissionOptionKind, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, rejectLocally } from "#src/client/inbound";

function request(kinds: readonly PermissionOptionKind[]): RequestPermissionRequest {
  return {
    sessionId: "s",
    toolCall: { toolCallId: "t" },
    options: kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })),
  };
}

const text = (t: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text" as const, text: t },
});

describe("rejectLocally (D-d: fail closed until S4-3)", () => {
  test("picks reject_once; never an allow or reject_always option", () => {
    expect(rejectLocally(request(["allow_once", "allow_always", "reject_always", "reject_once"]))).toEqual({
      outcome: { outcome: "selected", optionId: "opt-reject_once" },
    });
  });

  test("cancelled when the agent offered no reject_once", () => {
    expect(rejectLocally(request(["allow_once", "reject_always"]))).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("a malformed options list is cancelled, not a crash", () => {
    const malformed: RequestPermissionRequest = JSON.parse(
      '{"sessionId":"s","toolCall":{"toolCallId":"t"},"options":null}',
    );
    expect(rejectLocally(malformed)).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("createInboundRouter (spec §6.3 inbound with no active turn)", () => {
  test("routes updates for the attached session only, and only while attached", async () => {
    const router = createInboundRouter();
    const collector = createTurnCollector(undefined);
    router.handlers.onUpdate({ sessionId: "a", update: text("before") });
    const release = router.attach("a", collector);
    router.handlers.onUpdate({ sessionId: "a", update: text("mine") });
    router.handlers.onUpdate({ sessionId: "b", update: text("theirs") });
    release();
    router.handlers.onUpdate({ sessionId: "a", update: text("after") });
    expect(collector.output()).toBe("mine");
    expect(await router.handlers.onPermission(request(["reject_once"]))).toEqual({
      outcome: { outcome: "selected", optionId: "opt-reject_once" },
    });
  });

  test("releasing a stale binding does not detach a newer one", () => {
    const router = createInboundRouter();
    const first = createTurnCollector(undefined);
    const second = createTurnCollector(undefined);
    const releaseFirst = router.attach("a", first);
    router.attach("a", second);
    releaseFirst();
    router.handlers.onUpdate({ sessionId: "a", update: text("x") });
    expect(second.output()).toBe("x");
  });
});

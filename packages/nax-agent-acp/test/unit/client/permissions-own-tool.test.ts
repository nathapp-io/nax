/**
 * acp-tools-codex-cursor US-004: a request for a call the turn's ledger proves is the
 * session's own tool host call is allowed once before the profile decides.
 */
import { describe, expect, test } from "bun:test";
import type {
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, ApprovalRequest, SessionAskPort } from "@nathapp/nax-agent";
import { ASK_REASON, decidePermission, OWN_TOOL_REASON } from "#src/client/permissions";

const IDLE = new AbortController().signal;

function request(kinds: readonly PermissionOptionKind[]): RequestPermissionRequest {
  return {
    sessionId: "s",
    toolCall: { toolCallId: "t1", kind: "other", title: "lookup" },
    options: kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })),
  };
}

function recorder() {
  const auto: { readonly req: Omit<ApprovalRequest, "command" | "signal">; readonly decision: string }[] = [];
  const asked: ApprovalRequest[] = [];
  const port: SessionAskPort = {
    requestApproval: async (req) => {
      asked.push(req);
      return { decision: "allow", decidedBy: "human" };
    },
    recordAutoDecision: (req, decision) => {
      auto.push({ req, decision });
    },
    askQuestion: async () => null,
    noteQuestion: () => {},
  };
  return { port, auto, asked };
}

const selected = (kind: string): RequestPermissionResponse => ({
  outcome: { outcome: "selected", optionId: `opt-${kind}` },
});
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
const own = () => true;
const notOwn = () => false;

function ctx(
  profile: AgentSessionProfile,
  port: SessionAskPort,
  isOwnToolCall?: (id: string) => boolean,
  signal: AbortSignal = IDLE,
) {
  return { profile, asks: port, secrets: [], signal, ...(isOwnToolCall === undefined ? {} : { isOwnToolCall }) };
}

describe("decidePermission: own tool host calls", () => {
  test("AC-1: read profile selects allow-once for an own call", async () => {
    const r = recorder();
    const answer = await decidePermission(request(["allow_once", "reject_once"]), ctx("read", r.port, own));
    expect(answer).toEqual(selected("allow_once"));
  });

  test("AC-2: the auto decision is recorded with OWN_TOOL_REASON and allow", async () => {
    const r = recorder();
    await decidePermission(request(["allow_once", "reject_once"]), ctx("read", r.port, own));
    expect(r.auto).toHaveLength(1);
    expect(r.auto[0]?.decision).toBe("allow");
    expect(r.auto[0]?.req.reason).toBe(OWN_TOOL_REASON);
    expect(OWN_TOOL_REASON).toBe("nax's own tool host call");
  });

  test("the predicate receives the request's toolCallId", async () => {
    const r = recorder();
    const seen: string[] = [];
    await decidePermission(
      request(["allow_once", "reject_once"]),
      ctx("none", r.port, (id) => {
        seen.push(id);
        return true;
      }),
    );
    expect(seen).toEqual(["t1"]);
  });

  test("AC-3: ask profile never asks the caller for an own call", async () => {
    const r = recorder();
    const answer = await decidePermission(request(["allow_once", "reject_once"]), ctx("ask", r.port, own));
    expect(answer).toEqual(selected("allow_once"));
    expect(r.asked).toEqual([]);
  });

  test("AC-4: only allow-always and reject-once offered under read: reject-once", async () => {
    const r = recorder();
    const answer = await decidePermission(request(["allow_always", "reject_once"]), ctx("read", r.port, own));
    expect(answer).toEqual(selected("reject_once"));
  });

  test("AC-5: ask profile with a non-own call asks the caller once", async () => {
    const r = recorder();
    const answer = await decidePermission(request(["allow_once", "reject_once"]), ctx("ask", r.port, notOwn));
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]?.reason).toBe(ASK_REASON);
    expect(answer).toEqual(selected("allow_once"));
  });

  test("AC-6: an aborted signal is cancelled before any auto-allow", async () => {
    const r = recorder();
    const controller = new AbortController();
    controller.abort();
    const answer = await decidePermission(
      request(["allow_once", "reject_once"]),
      ctx("ask", r.port, own, controller.signal),
    );
    expect(answer).toEqual(CANCELLED);
    expect(r.auto).toEqual([]);
  });

  test.each(["none", "read"] as const)(
    "AC-17: %s with a never-reported id selects reject-once, as today",
    async (p) => {
      const r = recorder();
      const answer = await decidePermission(request(["allow_once", "reject_once"]), ctx(p, r.port, notOwn));
      expect(answer).toEqual(selected("reject_once"));
    },
  );

  test("AC-20: ask profile, own call with only allow-always and reject-once: reject-once, never allow-always", async () => {
    const r = recorder();
    const answer = await decidePermission(request(["allow_always", "reject_once"]), ctx("ask", r.port, own));
    expect(answer).toEqual(selected("reject_once"));
    expect(r.asked).toEqual([]);
  });

  test("AC-21: an omitted predicate keeps the read profile's reject-once", async () => {
    const r = recorder();
    const answer = await decidePermission(request(["allow_once", "reject_once"]), ctx("read", r.port));
    expect(answer).toEqual(selected("reject_once"));
  });
});

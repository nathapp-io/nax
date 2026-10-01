/**
 * nax#1722: `SessionManager.handoff()` kept a descriptor's `agent` truthful across an
 * agent swap, but its only caller guarded on a `sessionId` that `callOp` never carries,
 * and `openSession` leaves `agent` at the primary when it re-opens the same session name
 * under the fallback. Every artifact read off that descriptor therefore credited the
 * failed primary with the fallback agent's work. `recordAgentHandoff` closes that by
 * keying off the session NAME, which is what a hop knows.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeSessionManager } from "@test/helpers";
import { recordAgentHandoff } from "@/session";
import type { SessionDescriptor } from "@/session/types";

const NAME = "nax-deadbeef-us-001";

function descriptorFor(agent: string): SessionDescriptor {
  return {
    id: "sess-1",
    role: "main",
    state: "RUNNING",
    agent,
    workdir: "/tmp",
    protocolIds: { recordId: null, sessionId: null },
    completedStages: [],
    createdAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
  };
}

describe("recordAgentHandoff", () => {
  test("hands the descriptor off when the session re-opens under a different agent", () => {
    const handoff = mock(() => descriptorFor("codex"));
    const sm = makeSessionManager({ descriptor: mock(() => descriptorFor("claude")), handoff });

    recordAgentHandoff(sm, NAME, "codex", "fail-quota");

    expect(handoff).toHaveBeenCalledWith("sess-1", "codex", "fail-quota");
  });

  test("no-ops when the agent is unchanged, so callers need not check the hop kind", () => {
    const handoff = mock(() => descriptorFor("claude"));
    const sm = makeSessionManager({ descriptor: mock(() => descriptorFor("claude")), handoff });

    recordAgentHandoff(sm, NAME, "claude", "fail-quota");

    expect(handoff).not.toHaveBeenCalled();
  });

  test("no-ops when no descriptor exists under that name", () => {
    const handoff = mock(() => descriptorFor("codex"));
    const sm = makeSessionManager({ descriptor: mock(() => null), handoff });

    recordAgentHandoff(sm, NAME, "codex");

    expect(handoff).not.toHaveBeenCalled();
  });

  test("tolerates a session manager without the optional handoff method", () => {
    const sm = makeSessionManager({ descriptor: mock(() => descriptorFor("claude")), handoff: undefined });

    expect(() => recordAgentHandoff(sm, NAME, "codex")).not.toThrow();
  });
});

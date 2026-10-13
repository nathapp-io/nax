import { describe, expect, test } from "bun:test";
import { makeTestRuntime } from "@test/helpers";
import { _runtimeRunStateDeps } from "@/runtime";
import { SessionManager } from "@/session";
import type { SessionDescriptor } from "@/session/types";

type ConfigureOpts = Parameters<SessionManager["configureRuntime"]>[0];

/** Captures the afterTurn hook createRuntime hands to the session manager. */
class CapturingSessionManager extends SessionManager {
  hook: ConfigureOpts["afterTurn"];
  override configureRuntime(opts: ConfigureOpts): void {
    this.hook = opts.afterTurn;
    super.configureRuntime(opts);
  }
}

function descriptor(handle?: string): SessionDescriptor {
  return {
    id: "sess-id",
    role: "implementer",
    state: "RUNNING",
    agent: "claude",
    workdir: "/tmp/nax-after-turn",
    storyId: "US-001",
    handle,
    protocolIds: { recordId: null, sessionId: null },
    completedStages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("createRuntime afterTurn wiring (#2497)", () => {
  test("maps the session descriptor and turn onto a turn-trigger repair", async () => {
    const calls: unknown[] = [];
    const orig = _runtimeRunStateDeps.repairRunState;
    _runtimeRunStateDeps.repairRunState = async (ctx) => {
      calls.push(ctx);
      return [];
    };
    try {
      const sessionManager = new CapturingSessionManager();
      makeTestRuntime({ sessionManager });
      await sessionManager.hook?.(descriptor("nax-handle"), 3);
      await sessionManager.hook?.(descriptor(), 1);
    } finally {
      _runtimeRunStateDeps.repairRunState = orig;
    }
    expect(calls).toEqual([
      { trigger: "turn", storyId: "US-001", sessionName: "nax-handle", stage: "implementer", turn: 3 },
      { trigger: "turn", storyId: "US-001", sessionName: "sess-id", stage: "implementer", turn: 1 },
    ]);
  });
});

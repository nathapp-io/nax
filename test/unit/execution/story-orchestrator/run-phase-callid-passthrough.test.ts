/**
 * runPhase — the caller's callId survives the hop (#1932).
 *
 * The fix cycle attributes a dispatch's spend by stamping its own `callId` on
 * the context and reading the cost ledger back by that id. On the rectification
 * path that context reaches `callOp` through `runPhase`, which rewrites
 * `scopeId` on the context it forwards — the reason the cycle keys on `callId`
 * and not on a cost scope. If `runPhase` ever stopped forwarding `callId`,
 * rectification would silently return to reporting $0 for its real spend, which
 * is exactly the defect #1932 fixed. This pins the forwarding.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeMockCallContext } from "@test/helpers";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution/story-orchestrator";
import type { CallContext, RunOperation } from "@/operations";

function makeSlot(): AnySlot {
  const op = {
    kind: "run" as const,
    name: "implementer",
    stage: "run" as const,
    config: [] as const,
    session: { role: "implementer" as const, lifetime: "fresh" as const },
    build: () => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => ({}),
  } satisfies RunOperation<unknown, unknown, unknown>;
  return { op, input: {} };
}

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let seen: CallContext | undefined;

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  seen = undefined;
  _storyOrchestratorDeps.callOp = (async (ctx: CallContext) => {
    seen = ctx;
    return { passed: true, success: true };
  }) as typeof _storyOrchestratorDeps.callOp;
  _storyOrchestratorDeps.captureGitRef = async () => "HEAD";
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
});

describe("runPhase — callId pass-through (#1932)", () => {
  test("forwards the caller's callId to callOp while rewriting scopeId", async () => {
    const ctx = makeMockCallContext({ callId: "cycle-call-1", scopeId: "caller-scope" });

    await runPhase(ctx, makeSlot(), {}, {});

    expect(seen?.callId).toBe("cycle-call-1");
    // The scope IS rewritten — this is the asymmetry the cycle depends on.
    expect(seen?.scopeId).toBeString();
    expect(seen?.scopeId).not.toBe("caller-scope");
  });

  test("leaves callId absent when the caller supplied none, so callOp still mints one", async () => {
    await runPhase(makeMockCallContext(), makeSlot(), {}, {});

    expect(seen?.callId).toBeUndefined();
  });
});

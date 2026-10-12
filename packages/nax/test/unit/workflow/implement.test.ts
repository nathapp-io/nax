import { afterEach, describe, expect, test } from "bun:test";
import { makeScriptedCallOp, makeSessionManager, makeStepContext, makeTestStory } from "@test/helpers";
import type { TierConfig, WorkflowConfig } from "@/config";
import { resolveWorkflowConfig } from "@/config";
import type { WorkflowImplementInput } from "@/operations";
import { workflowImplementOp } from "@/operations";
import type { UserStory } from "@/prd";
import type { SessionDescriptor } from "@/session/types";
import { fixModelFor } from "@/workflow/fix-round";
import { runImplementerTurn } from "@/workflow/implement";
import { _workflowDeps } from "@/workflow/step-context";
import type { ImplementerReply } from "@/workflow/types";

const original = { ..._workflowDeps };
afterEach(() => Object.assign(_workflowDeps, original));

const tiers: TierConfig[] = [
  { tier: "fast", attempts: 2 },
  { tier: "balanced", attempts: 2 },
  { tier: "powerful", attempts: 2 },
];
const routed = (modelTier: "fast" | "balanced" | "powerful", extra: Partial<UserStory["routing"]> = {}): UserStory =>
  makeTestStory({
    id: "US-001",
    routing: { complexity: "medium", modelTier, testStrategy: "tdd-simple", reasoning: "", ...extra },
  });

describe("fixModelFor", () => {
  test("warm rounds keep the routed model", () => {
    expect(fixModelFor(routed("fast"), tiers, 0)).toBeUndefined();
  });
  test("each step-up climbs one rung", () => {
    expect(fixModelFor(routed("fast"), tiers, 1)).toBe("balanced");
    expect(fixModelFor(routed("fast"), tiers, 2)).toBe("powerful");
  });
  test("last rung stays put", () => {
    expect(fixModelFor(routed("powerful"), tiers, 1)).toBeUndefined();
    expect(fixModelFor(routed("balanced"), tiers, 5)).toBe("powerful");
  });
  test("a profile pin stays on the pinned model", () => {
    expect(fixModelFor(routed("fast", { agent: "native", profileModelPin: "x/y" }), tiers, 2)).toBeUndefined();
  });
  test("agent-qualified ladders carry the agent", () => {
    const ladder: TierConfig[] = [
      { tier: "balanced", agent: "codex", attempts: 1 },
      { tier: "balanced", agent: "claude", attempts: 1 },
    ];
    expect(fixModelFor(routed("balanced", { agent: "codex" }), ladder, 1)).toEqual({
      agent: "claude",
      model: "balanced",
    });
  });
});

const workflow: WorkflowConfig = {
  ...resolveWorkflowConfig(makeStepContext().config),
  timeouts: {
    ...resolveWorkflowConfig(makeStepContext().config).timeouts,
    implementMs: 111,
    fixMs: 222,
    reviewMs: 333,
  },
};

const doneReply: ImplementerReply = { status: "DONE", commits: [], testSummary: "ok", interrupted: false };

function isImplementInput(v: unknown): v is WorkflowImplementInput {
  return typeof v === "object" && v !== null && "prompt" in v;
}

/** Fakes callOp for the implement op only; records the inputs. */
function fakeImplement(reply: ImplementerReply | (() => ImplementerReply), seen: WorkflowImplementInput[] = []): void {
  _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
    expect(op.name).toBe(workflowImplementOp.name);
    if (isImplementInput(input)) seen.push(input);
    return typeof reply === "function" ? reply() : reply;
  });
}

describe("runImplementerTurn", () => {
  test("implement turn: implementMs, routed model, auto-commit when dirty", async () => {
    const seen: WorkflowImplementInput[] = [];
    const commits: unknown[][] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: " M src/a.ts\n", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async (...args) => {
      commits.push(args);
    };
    const out = await runImplementerTurn(
      makeStepContext({ story: routed("fast"), tierOrder: tiers, workflow, briefPath: "/b.md", reportPath: "/r.md" }),
      { kind: "implement" },
    );
    expect(seen[0]?.timeoutMs).toBe(111);
    expect(seen[0]?.model).toBeUndefined();
    expect(seen[0]?.prompt).toContain("/b.md");
    expect(out.autoCommitted).toBe(true);
    expect(commits[0]?.slice(0, 4)).toEqual(["/repo", "workflow", "wf-implementer", "US-001"]);
  });

  test("clean tree: no auto-commit", async () => {
    let committed = false;
    fakeImplement(doneReply);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async () => {
      committed = true;
    };
    const out = await runImplementerTurn(makeStepContext({ workflow }), { kind: "implement" });
    expect(out.autoCommitted).toBe(false);
    expect(committed).toBe(false);
  });

  test("interrupted turn: no auto-commit, edits stay", async () => {
    let committed = false;
    fakeImplement({ ...doneReply, status: "DONE_WITH_CONCERNS", interrupted: true });
    _workflowDeps.autoCommitIfDirty = async () => {
      committed = true;
    };
    const out = await runImplementerTurn(makeStepContext({ workflow }), { kind: "implement" });
    expect(out.reply?.interrupted).toBe(true);
    expect(committed).toBe(false);
  });

  test("reply failure becomes the outcome failure, no auto-commit", async () => {
    fakeImplement({ ...doneReply, failure: 'Agent "x" failed' });
    const out = await runImplementerTurn(makeStepContext({ workflow }), { kind: "implement" });
    expect(out.failure).toBe('Agent "x" failed');
    expect(out.autoCommitted).toBe(false);
  });

  test("answer turn after a stepped-up fresh round uses that round's model and fixMs, and never closes the session", async () => {
    const closes: string[] = [];
    const sessionManager = {
      getForStory: () => [],
      getLiveHandle: () => undefined,
      closeSession: async () => {
        closes.push("close");
      },
    };
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(
      makeStepContext({
        story: routed("fast"),
        tierOrder: tiers,
        workflow,
        sessionManager: makeSessionManager(sessionManager),
      }),
      { kind: "answer", text: "Use X", stepUps: 1, limit: "fix" },
    );
    expect(seen[0]?.model).toBe("balanced");
    expect(seen[0]?.timeoutMs).toBe(222);
    expect(seen[0]?.prompt).toContain("Use X");
    expect(closes).toEqual([]);
  });

  test("answer turn after the first implement turn uses the routed model and implementMs", async () => {
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ story: routed("fast"), tierOrder: tiers, workflow }), {
      kind: "answer",
      text: "Use X",
      stepUps: 0,
      limit: "implement",
    });
    expect(seen[0]?.model).toBeUndefined();
    expect(seen[0]?.timeoutMs).toBe(111);
  });

  test("fresh fix turn: closes the warm session first, stepped-up model, fixMs, uncommitted files in prompt", async () => {
    const order: string[] = [];
    const descriptor: SessionDescriptor = {
      id: "sess-1",
      role: "wf-implementer",
      state: "RUNNING",
      agent: "claude",
      workdir: "/repo",
      protocolIds: { recordId: null, sessionId: null },
      handle: "h1",
      completedStages: [],
      createdAt: "",
      lastActivityAt: "",
    };
    const sessionManager = {
      getForStory: () => [descriptor],
      getLiveHandle: () => ({ id: "live", agentName: "claude" }),
      closeSession: async () => {
        order.push("close");
      },
    };
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(() => {
      order.push("call");
      return doneReply;
    }, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(
      makeStepContext({
        story: routed("fast"),
        tierOrder: tiers,
        workflow,
        sessionManager: makeSessionManager(sessionManager),
      }),
      {
        kind: "fix",
        round: 4,
        fresh: true,
        stepUps: 1,
        findings: [{ id: "F1", kind: "spec", severity: "important", issue: "x" }],
        uncommitted: ["src/half.ts"],
      },
    );
    expect(order).toEqual(["close", "call"]);
    expect(seen[0]?.timeoutMs).toBe(222);
    expect(seen[0]?.model).toBe("balanced");
    expect(seen[0]?.prompt).toContain("src/half.ts");
    expect(seen[0]?.prompt).toContain("you own it now");
  });

  test("fresh fix turn: a session that fails to close does not stop the turn", async () => {
    const descriptor: SessionDescriptor = {
      id: "sess-1",
      role: "wf-implementer",
      state: "CREATED",
      agent: "claude",
      workdir: "/repo",
      protocolIds: { recordId: null, sessionId: null },
      handle: "h1",
      completedStages: [],
      createdAt: "",
      lastActivityAt: "",
    };
    const sessionManager = {
      getForStory: () => [descriptor],
      getLiveHandle: () => ({ id: "live", agentName: "claude" }),
      closeSession: async () => {
        throw new Error("close failed");
      },
    };
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    const out = await runImplementerTurn(
      makeStepContext({
        story: routed("fast"),
        tierOrder: tiers,
        workflow,
        sessionManager: makeSessionManager(sessionManager),
      }),
      { kind: "fix", round: 4, fresh: true, stepUps: 1, findings: [], uncommitted: [] },
    );
    expect(out.failure).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  test("session failure becomes a failure string; abort rethrows", async () => {
    _workflowDeps.callOp = async () => {
      throw new Error("auth expired");
    };
    expect((await runImplementerTurn(makeStepContext({ workflow }), { kind: "implement" })).failure).toBe(
      "auth expired",
    );
    const ac = new AbortController();
    ac.abort();
    await expect(
      runImplementerTurn(makeStepContext({ workflow, runSignal: ac.signal }), { kind: "implement" }),
    ).rejects.toThrow("auth expired");
  });
});

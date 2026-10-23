import { afterEach, describe, expect, test } from "bun:test";
import { makeScriptedCallOp, makeSessionManager, makeStepContext, makeTestStory } from "@test/helpers";
import type { TierConfig, WorkflowConfig } from "@/config";
import { resolveWorkflowConfig } from "@/config";
import type { WorkflowImplementInput } from "@/operations";
import { workflowImplementOp } from "@/operations";
import type { UserStory } from "@/prd";
import {
  buildWorkflowContinuePrompt,
  buildWorkflowImplementPrompt,
  buildWorkflowReportPrompt,
  buildWorkflowRestartPrompt,
} from "@/prompts";
import type { SessionDescriptor } from "@/session/types";
import { fixModelFor } from "@/workflow/fix-round";
import { autoCommitTurnEdits, implementerModelFor, runImplementerTurn } from "@/workflow/implement";
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
    // nax#2479: the report path rides on every implementer call, so the session may write it.
    expect(seen[0]?.reportPath).toBe("/r.md");
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
    expect(seen[0]?.prompt).toContain("Use X");
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
    // The fresh escalated session gets the same report exemption as the warm one (nax#2479).
    expect(seen[0]?.reportPath).toBe(makeStepContext({ workflow }).reportPath);
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

/** US-001 (nax#2509): a live wf-implementer session whose close is recorded, so a turn that must not close shows it. */
function liveImplementerSessions(order: string[]) {
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
  return makeSessionManager({
    getForStory: () => [descriptor],
    getLiveHandle: () => ({ id: "live", agentName: "claude" }),
    closeSession: async () => {
      order.push("close");
    },
  });
}

const restartPaths = { briefPath: "/b/brief.md", reportPath: "/b/report.md" };

describe("runImplementerTurn restart turns (US-001)", () => {
  test("warm restart: the short restart prompt, no session close", async () => {
    const order: string[] = [];
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
        ...restartPaths,
        sessionManager: liveImplementerSessions(order),
      }),
      { kind: "restart", fresh: false, stepUps: 0 },
    );
    expect(seen[0]?.prompt).toBe(
      buildWorkflowRestartPrompt({ storyId: "US-001", briefPath: "/b/brief.md", reportPath: "/b/report.md" }),
    );
    expect(order).toEqual(["call"]);
    expect(seen[0]?.model).toBeUndefined();
  });

  test("fresh restart: closes the warm session first, then the full implement prompt, stepped up one rung", async () => {
    const order: string[] = [];
    const seen: WorkflowImplementInput[] = [];
    const story = routed("fast");
    fakeImplement(() => {
      order.push("call");
      return doneReply;
    }, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(
      makeStepContext({
        story,
        tierOrder: tiers,
        workflow,
        ...restartPaths,
        sessionManager: liveImplementerSessions(order),
      }),
      { kind: "restart", fresh: true, stepUps: 1 },
    );
    expect(order).toEqual(["close", "call"]);
    expect(seen[0]?.prompt).toBe(
      buildWorkflowImplementPrompt({ storyId: "US-001", briefPath: "/b/brief.md", reportPath: "/b/report.md" }),
    );
    expect(seen[0]?.model).toBe(fixModelFor(story, tiers, 1));
    expect(seen[0]?.model).toBe("balanced");
  });

  test.each([
    ["warm", { kind: "restart", fresh: false, stepUps: 0 } as const],
    ["fresh", { kind: "restart", fresh: true, stepUps: 1 } as const],
  ])("restart turn (%s): the implement timeout, not the fix timeout", async (_name, turn) => {
    const order: string[] = [];
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(
      makeStepContext({
        story: routed("fast"),
        tierOrder: tiers,
        workflow,
        sessionManager: liveImplementerSessions(order),
      }),
      turn,
    );
    expect(seen[0]?.timeoutMs).toBe(workflow.timeouts.implementMs);
    expect(seen[0]?.timeoutMs).toBe(111);
  });
});

/** US-004: the real limits and the default half-budget, so a continue timeout is a fraction of the limit it hit. */
const interruptWorkflow: WorkflowConfig = {
  ...workflow,
  interruptRetry: { maxAttempts: 1, budgetMultiplier: 0.5 },
  timeouts: { ...workflow.timeouts, implementMs: 3_600_000, fixMs: 1_000_001, reportMs: 600_000 },
};

const continueTurn = {
  kind: "continue",
  limit: "implement",
  stepUps: 0,
  attempt: 1,
  maxAttempts: 1,
} as const;

const reportPath = "/r/report.md";

describe("runImplementerTurn continue turns (US-004)", () => {
  test.each([
    ["implement", 1_800_000],
    ["fix", 500_000],
  ] as const)("continue turn over the %s limit is budgeted at budgetMultiplier of it", async (limit, expected) => {
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ workflow: interruptWorkflow }), {
      kind: "continue",
      limit,
      stepUps: 0,
      attempt: 1,
      maxAttempts: 1,
    });
    expect(seen[0]?.timeoutMs).toBe(expected);
  });

  test("continue turn keeps the warm session", async () => {
    const order: string[] = [];
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(() => {
      order.push("call");
      return doneReply;
    }, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(
      makeStepContext({ workflow: interruptWorkflow, sessionManager: liveImplementerSessions(order) }),
      continueTurn,
    );
    expect(order).toEqual(["call"]);
  });

  test("continue turn renders the continue prompt with the limit and the budget in minutes", async () => {
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ workflow: interruptWorkflow, reportPath }), {
      ...continueTurn,
      changedFiles: ["src/a.ts"],
    });
    expect(seen[0]?.prompt).toBe(
      buildWorkflowContinuePrompt({
        storyId: "US-001",
        reportPath,
        limitMinutes: 60,
        budgetMinutes: 30,
        attempt: 1,
        maxAttempts: 1,
        changedFiles: ["src/a.ts"],
      }),
    );
  });

  test("a continue budget under a minute is still reported as a minute", async () => {
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    const sc = makeStepContext({
      workflow: { ...interruptWorkflow, timeouts: { ...interruptWorkflow.timeouts, implementMs: 60_000 } },
      reportPath,
    });
    await runImplementerTurn(sc, continueTurn);
    expect(seen[0]?.timeoutMs).toBe(30_000);
    expect(seen[0]?.prompt).toBe(
      buildWorkflowContinuePrompt({
        storyId: "US-001",
        reportPath,
        limitMinutes: 1,
        budgetMinutes: 1,
        attempt: 1,
        maxAttempts: 1,
      }),
    );
  });

  test("a continue turn with no readable changed-file list says so", async () => {
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ workflow: interruptWorkflow, reportPath }), continueTurn);
    expect(seen[0]?.prompt).toBe(
      buildWorkflowContinuePrompt({
        storyId: "US-001",
        reportPath,
        limitMinutes: 60,
        budgetMinutes: 30,
        attempt: 1,
        maxAttempts: 1,
      }),
    );
    expect(seen[0]?.prompt).toContain("could not be read");
  });

  test("a continue turn keeps its origin's step-up", () => {
    const sc = makeStepContext({ story: routed("fast"), tierOrder: tiers.slice(0, 2) });
    const stepped = implementerModelFor(sc, { ...continueTurn, stepUps: 1 });
    expect(stepped).toBeDefined();
    expect(stepped).toBe(
      implementerModelFor(sc, { kind: "fix", round: 4, fresh: true, stepUps: 1, findings: [], uncommitted: [] }),
    );
  });

  test("an interrupted continue turn does not auto-commit", async () => {
    let committed = false;
    fakeImplement({ ...doneReply, status: "DONE_WITH_CONCERNS", interrupted: true });
    _workflowDeps.git = async () => ({ stdout: " M src/a.ts\n", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async () => {
      committed = true;
    };
    const out = await runImplementerTurn(makeStepContext({ workflow: interruptWorkflow }), continueTurn);
    expect(out.reply?.interrupted).toBe(true);
    expect(out.autoCommitted).toBe(false);
    expect(committed).toBe(false);
  });
});

describe("runImplementerTurn report turns (US-004)", () => {
  test("report turn runs at reportMs", async () => {
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(makeStepContext({ workflow: interruptWorkflow }), { kind: "report", stepUps: 0 });
    expect(seen[0]?.timeoutMs).toBe(600_000);
  });

  test("report turn renders the report prompt on the warm session", async () => {
    const order: string[] = [];
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(() => {
      order.push("call");
      return doneReply;
    }, seen);
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    await runImplementerTurn(
      makeStepContext({ workflow: interruptWorkflow, reportPath, sessionManager: liveImplementerSessions(order) }),
      { kind: "report", stepUps: 0 },
    );
    expect(seen[0]?.prompt).toBe(buildWorkflowReportPrompt({ storyId: "US-001", reportPath }));
    expect(order).toEqual(["call"]);
  });
});

describe("autoCommitTurnEdits (US-004)", () => {
  test("a dirty tree is auto-committed for the story and resolves true", async () => {
    const calls: unknown[][] = [];
    _workflowDeps.git = async () => ({ stdout: " M src/a.ts\n", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async (...args) => {
      calls.push(args);
    };
    expect(await autoCommitTurnEdits(makeStepContext({ projectDir: "/repo", dryRun: true }))).toBe(true);
    expect(calls[0]).toEqual(["/repo", "workflow", "wf-implementer", "US-001", undefined, true]);
  });

  test("a clean tree resolves false without committing", async () => {
    let committed = false;
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async () => {
      committed = true;
    };
    expect(await autoCommitTurnEdits(makeStepContext())).toBe(false);
    expect(committed).toBe(false);
  });

  test("an unreadable tree resolves false without committing", async () => {
    let committed = false;
    _workflowDeps.git = async () => ({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 });
    _workflowDeps.autoCommitIfDirty = async () => {
      committed = true;
    };
    expect(await autoCommitTurnEdits(makeStepContext())).toBe(false);
    expect(committed).toBe(false);
  });

  test("a failing commit resolves false rather than failing the turn", async () => {
    _workflowDeps.git = async () => ({ stdout: " M src/a.ts\n", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async () => {
      throw new Error("commit failed");
    };
    expect(await autoCommitTurnEdits(makeStepContext())).toBe(false);
  });
});

describe("runImplementerTurn completed turns (US-004 regression)", () => {
  test("a completed implement turn still auto-commits its edits", async () => {
    const seen: WorkflowImplementInput[] = [];
    fakeImplement(doneReply, seen);
    _workflowDeps.git = async () => ({ stdout: " M src/a.ts\n", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async () => {};
    const out = await runImplementerTurn(makeStepContext({ workflow }), { kind: "implement" });
    expect(out).toEqual({ reply: doneReply, autoCommitted: true });
  });
});

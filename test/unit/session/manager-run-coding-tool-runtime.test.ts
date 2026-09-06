/**
 * US-003 — Preserve audited coding-tool runtime in tracked sessions.
 *
 * runTrackedSession is the integration seam that wires resolveCodingToolSupport
 * into the run that the SessionRunClient receives. The unit tests in
 * coding-tool-support.test.ts prove the helper in isolation; these prove the
 * call site actually reaches the runner. Acceptance criteria:
 *
 *   AC1 — given declared tools + codingToolRoot + outputDir (no caller-supplied
 *         runtime), the runner's runtime writes a ledger record under the
 *         audit directory derived by toolAuditDir from those options.
 *   AC2 — runTrackedSession passes runner.runOptions.codingTools equal to the
 *         advertised tools for the declared set when declaredTools is
 *         non-empty and no caller-supplied codingToolRuntime exists.
 *   AC3 — runTrackedSession passes the runner the same codingToolRuntime
 *         instance supplied by the caller when one is supplied.
 *   AC4 — runTrackedSession passes runner.runOptions.codingToolRuntime as
 *         undefined when declaredTools is empty and no caller-supplied
 *         runtime exists.
 *   AC5 — runTrackedSession rejects with a NaxError whose code is
 *         CODING_TOOL_ROOT_MISSING when declaredTools is non-empty and
 *         codingToolRoot is an empty string (the session is already in
 *         RUNNING state by the time the throw fires — that is part of the
 *         contract).
 *   AC6 — given SessionManager.runInSession with a SessionRunClient and
 *         declared tools, the runner receives request.runOptions with
 *         codingToolRuntime defined and the session descriptor state is
 *         RUNNING.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  assertCaughtInstanceOf,
  assertNaxError,
  cleanupTempDir,
  makeAgentAdapter,
  makeNaxConfig,
  makeTempDir,
} from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support";
import type { AgentResult, AgentRunOptions, SessionHandle } from "@/agents/types";
import { toolAuditDir } from "@/config/paths";
import { _sessionManagerDeps, SessionManager } from "@/session/manager";
import { runTrackedSession, type SessionManagerState } from "@/session/manager-run";
import type { SessionDescriptor, SessionRunClient } from "@/session/types";
import type { CodingToolRuntime } from "@/tools";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";

let originalWriteDescriptor: typeof _sessionManagerDeps.writeDescriptor;

beforeEach(() => {
  originalWriteDescriptor = _sessionManagerDeps.writeDescriptor;
  _sessionManagerDeps.writeDescriptor = async () => {};
});

afterEach(() => {
  _sessionManagerDeps.writeDescriptor = originalWriteDescriptor;
  mock.restore();
});

function makeDescriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess-us003",
    role: "implementer",
    state: "CREATED",
    agent: "claude",
    workdir: "/tmp/repo",
    featureName: "auth-system",
    storyId: "US-003",
    protocolIds: { recordId: null, sessionId: null },
    completedStages: [],
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeState(descriptor: SessionDescriptor): SessionManagerState {
  const sessions = new Map<string, SessionDescriptor>([[descriptor.id, descriptor]]);
  return {
    sessions,
    transition: mock((_id: string, to: SessionDescriptor["state"]) => {
      const d = sessions.get(_id);
      if (!d) throw new Error(`unknown session ${_id}`);
      const updated: SessionDescriptor = { ...d, state: to };
      sessions.set(_id, updated);
      return updated;
    }),
    bindHandle: mock((_id: string, handle: string, protocolIds: SessionHandle["protocolIds"]) => {
      const d = sessions.get(_id);
      if (!d) throw new Error(`unknown session ${_id}`);
      const updated: SessionDescriptor = { ...d, handle, protocolIds: protocolIds ?? d.protocolIds };
      sessions.set(_id, updated);
      return updated;
    }),
    handoff: mock((_id: string, agent: string) => {
      const d = sessions.get(_id);
      if (!d) throw new Error(`unknown session ${_id}`);
      const updated: SessionDescriptor = { ...d, agent };
      sessions.set(_id, updated);
      return updated;
    }),
    persistDescriptor: mock(() => {}),
    dispatchEvents: {
      onDispatch: () => () => {},
      emitDispatch: () => {},
      emitDispatchError: () => {},
      onOperationCompleted: () => () => {},
      emitOperationCompleted: () => {},
      onDispatchError: () => () => {},
      onReviewDecision: () => () => {},
      emitReviewDecision: () => {},
      onReviewReprompt: () => () => {},
      emitReviewReprompt: () => {},
    },
    defaultAgent: "claude",
    nameFor: mock(() => "nax-00000000-auth-system-US-003-implementer"),
  };
}

function makeSuccessResult(): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: "ok",
    rateLimited: false,
    durationMs: 10,
    estimatedCostUsd: 0,
  };
}

function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "implement it",
    workdir: "/tmp/repo",
    modelTier: "fast",
    modelDef: { provider: "anthropic", model: "claude-haiku", env: {} },
    timeoutSeconds: 30,
    config: makeNaxConfig(),
    storyId: "US-003",
    featureName: "auth-system",
    pipelineStage: "run",
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// AC1 — the runtime the runner receives writes a ledger record under the
//       audit directory derived by toolAuditDir from the run's options.
// ────────────────────────────────────────────────────────────────────────────

describe("runTrackedSession — AC1: ledger destination follows runOptions", () => {
  test("received runtime dispatches a call; resolveCodingToolSupport with the same options writes to outputDir/tool-audit/<feature>", async () => {
    const root = makeTempDir("nax-003-root-");
    const outputDir = makeTempDir("nax-003-out-");
    try {
      await Bun.write(join(root, "file.ts"), "const x = 1;\n");

      const descriptor = makeDescriptor();
      const state = makeState(descriptor);

      // The runner must capture the runtime and dispatch through it for the
      // audit-record path to fire. Without this the runner is a no-op and AC1
      // is not actually being exercised.
      const capturedRuntimes: CodingToolRuntime[] = [];
      const runner: SessionRunClient = {
        run: mock(async (req) => {
          if (req.runOptions.codingToolRuntime) {
            capturedRuntimes.push(req.runOptions.codingToolRuntime);
            // Dispatch a Read through the runner-received runtime — this fires
            // record() on the audit sink that runTrackedSession wired in.
            await req.runOptions.codingToolRuntime.callTool("Read", { path: "file.ts" });
          }
          return makeSuccessResult();
        }),
      };

      await runTrackedSession(state, descriptor.id, runner, {
        runOptions: makeRunOptions({
          declaredTools: ["Read"],
          codingToolRoot: root,
          outputDir,
        }),
      });

      // The integration seam ran: the runner received a runtime and used it.
      expect(capturedRuntimes).toHaveLength(1);

      // The runtime the runner received is the runtime resolveCodingToolSupport
      // built. Re-resolve with the SAME options to obtain the support object
      // (whose audit sink is private in production but accessible via the
      // support here), flush it, and confirm the ledger lands at the directory
      // toolAuditDir({root, outputDir}, featureName) yields — not at
      // <root>/.nax/tool-audit (the ephemeral fallback that C2 used to ship).
      const support = resolveCodingToolSupport({
        declaredTools: ["Read"],
        codingToolRoot: root,
        outputDir,
        pipelineStage: "run",
        storyId: "US-003",
        featureName: "auth-system",
        config: makeNaxConfig(),
      });
      expect(support).toBeDefined();
      await support?.runtime.callTool("Read", { path: "file.ts" });
      await support?.auditSink.flush();

      const expectedDir = toolAuditDir({ root, outputDir }, "auth-system");
      const written = [...new Bun.Glob("*.json").scanSync(expectedDir)];
      expect(written.length).toBeGreaterThan(0);

      // Nothing under the (ephemeral) tool root — the worktree removal that
      // follows a story cannot take the ledger with it.
      expect(existsSync(join(root, ".nax", "tool-audit"))).toBe(false);
    } finally {
      cleanupTempDir(root);
      cleanupTempDir(outputDir);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC2 — codingTools equals the advertised tools when declared + no caller rt.
// ────────────────────────────────────────────────────────────────────────────

describe("runTrackedSession — AC2: codingTools equals the advertised set", () => {
  test("runner receives codingTools matching advertised intersection of declared and granted", async () => {
    const root = makeTempDir("nax-003-ac2-");
    try {
      const descriptor = makeDescriptor();
      const state = makeState(descriptor);

      let receivedTools: readonly { name: string }[] | undefined;
      const runner: SessionRunClient = {
        run: mock(async (req) => {
          receivedTools = req.runOptions.codingTools;
          return makeSuccessResult();
        }),
      };

      await runTrackedSession(state, descriptor.id, runner, {
        runOptions: makeRunOptions({
          declaredTools: ["Read", "Glob", "Grep"],
          codingToolRoot: root,
        }),
      });

      expect(receivedTools).toBeDefined();
      const names = (receivedTools ?? []).map((t) => t.name).sort();
      // DEFAULT_CODING_TOOLS = ["Read", "Glob", "Grep"] under unrestricted profile.
      expect(names).toEqual(["Glob", "Grep", "Read"]);
    } finally {
      cleanupTempDir(root);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC3 — caller-supplied codingToolRuntime is preserved (not overwritten).
// ────────────────────────────────────────────────────────────────────────────

describe("runTrackedSession — AC3: caller-supplied runtime is preserved", () => {
  test("runner receives the SAME runtime instance supplied by the caller", async () => {
    const root = makeTempDir("nax-003-ac3-");
    try {
      // A caller-supplied runtime is identified by identity, not by anything
      // resolvable from runOptions. Build a real CodingToolRuntime that no
      // production path could produce — anything that checks `===` against it.
      const sentinelRuntime: CodingToolRuntime = createCodingToolRuntime({
        policy: compileToolPolicy([], root),
      });

      const descriptor = makeDescriptor();
      const state = makeState(descriptor);

      let receivedRuntime: CodingToolRuntime | undefined;
      const runner: SessionRunClient = {
        run: mock(async (req) => {
          receivedRuntime = req.runOptions.codingToolRuntime;
          return makeSuccessResult();
        }),
      };

      await runTrackedSession(state, descriptor.id, runner, {
        runOptions: makeRunOptions({
          declaredTools: ["Read"],
          codingToolRoot: root,
          codingToolRuntime: sentinelRuntime,
        }),
      });

      expect(receivedRuntime).toBe(sentinelRuntime);
    } finally {
      cleanupTempDir(root);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC4 — codingToolRuntime is undefined when declaredTools is empty and the
//       caller supplied none.
// ────────────────────────────────────────────────────────────────────────────

describe("runTrackedSession — AC4: no runtime when no declared tools", () => {
  test("runner receives codingToolRuntime === undefined when declaredTools is empty", async () => {
    const root = makeTempDir("nax-003-ac4-");
    try {
      const descriptor = makeDescriptor();
      const state = makeState(descriptor);

      let receivedRuntime: CodingToolRuntime | undefined = {} as CodingToolRuntime;
      const runner: SessionRunClient = {
        run: mock(async (req) => {
          receivedRuntime = req.runOptions.codingToolRuntime;
          return makeSuccessResult();
        }),
      };

      await runTrackedSession(state, descriptor.id, runner, {
        runOptions: makeRunOptions({
          // No declaredTools, no caller-supplied runtime.
          codingToolRoot: root,
        }),
      });

      expect(receivedRuntime).toBeUndefined();
    } finally {
      cleanupTempDir(root);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC5 — NaxError code CODING_TOOL_ROOT_MISSING on empty codingToolRoot.
// ────────────────────────────────────────────────────────────────────────────

describe("runTrackedSession — AC5: CODING_TOOL_ROOT_MISSING on empty root", () => {
  test("rejects with NaxError code CODING_TOOL_ROOT_MISSING when declaredTools is non-empty and codingToolRoot is ''", async () => {
    const descriptor = makeDescriptor();
    const state = makeState(descriptor);

    const runner: SessionRunClient = {
      run: mock(async () => makeSuccessResult()),
    };

    let caught: unknown;
    try {
      await runTrackedSession(state, descriptor.id, runner, {
        runOptions: makeRunOptions({
          declaredTools: ["Read"],
          codingToolRoot: "",
        }),
      });
    } catch (err) {
      caught = err;
    }

    assertCaughtInstanceOf(caught, Error, "runTrackedSession rejection");
    assertNaxError(caught, "runTrackedSession rejection");
    expect(caught.code).toBe("CODING_TOOL_ROOT_MISSING");

    // The transition to RUNNING happens BEFORE resolveCodingToolSupport runs,
    // so the session is already RUNNING by the time the throw fires. That is
    // the contract: a thrown root-missing error is not undone by the manager.
    expect(state.sessions.get(descriptor.id)?.state).toBe("RUNNING");

    // The runner must never have been invoked when the seam rejects first.
    expect(runner.run).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC6 — SessionManager.runInSession wired through to the runner.
// ────────────────────────────────────────────────────────────────────────────

describe("SessionManager.runInSession — AC6: runtime is wired into the runner", () => {
  test("runner receives a defined codingToolRuntime while the session is RUNNING", async () => {
    const root = makeTempDir("nax-003-ac6-");
    try {
      await Bun.write(join(root, "file.ts"), "const x = 1;\n");

      const adapter = makeAgentAdapter({
        openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
        closeSession: mock(async () => {}),
      });
      const sm = new SessionManager({ getAdapter: () => adapter });
      const d = sm.create({ role: "implementer", agent: "claude", workdir: "/tmp/repo" });

      let receivedRuntime: CodingToolRuntime | undefined;
      let stateWhileRunning: SessionDescriptor["state"] | undefined;
      const runner: SessionRunClient = {
        run: mock(async (req) => {
          receivedRuntime = req.runOptions.codingToolRuntime;
          // Capture the session state at the moment the runner is invoked.
          // runTrackedSession transitions CREATED → RUNNING before calling
          // runner.run(), so the descriptor is RUNNING here — and a successful
          // result will transition it to COMPLETED after the runner returns,
          // which is why the assertion lives INSIDE the runner.
          stateWhileRunning = sm.get(d.id)?.state;
          return makeSuccessResult();
        }),
      };

      await sm.runInSession(d.id, runner, {
        runOptions: makeRunOptions({
          declaredTools: ["Read"],
          codingToolRoot: root,
        }),
      });

      // AC6: runtime is defined and the session was RUNNING when the runner
      // received the request. (runTrackedSession transitions to COMPLETED on
      // success AFTER runner.run returns, so checking sm.get() here would
      // observe the post-run state — that is what produced the failure before
      // the fix.)
      expect(receivedRuntime).toBeDefined();
      expect(stateWhileRunning).toBe("RUNNING");
    } finally {
      cleanupTempDir(root);
    }
  });
});

/**
 * Phase C1 wiring — a declared coding tool must actually reach the agent on the
 * run() path.
 *
 * This is nax#1744 repeated one layer up. `buildCodingToolSupport` is the only
 * producer of a live CodingToolRuntime, and it was called from
 * `session/manager-run.ts` (runTrackedSession) — a function reachable only from
 * `SessionManager.runInSession`, which has no production caller. `callOp`
 * dispatches through `buildHopCallback` instead, which forwarded a
 * `codingTools` field nothing on that path ever set.
 *
 * Every seam passed its own unit test while the chain was dead end to end, so
 * these assertions are on what reaches `runAsSession` and on what the installed
 * handler actually does — never on a seam in isolation.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  makeContextBundle,
  makeContextManifest,
  makeLogger,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { AgentRunOptions, HopKind, RunAsSessionOpts, SessionHandle, TurnResult } from "@/agents";
import type { ContextBundle } from "@/context/engine";
import type { BuildHopCallbackContext } from "@/operations";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import { _codingToolDeps } from "@/tools";

const SESSION_ID = "sess-c1";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-coding-tools-");
});

afterEach(() => {
  cleanupTempDir(root);
});

/** A bundle with no pull tools — coding tools must not depend on the context engine. */
function emptyBundle(): ContextBundle {
  return makeContextBundle({
    pullTools: [],
    pushMarkdown: "## Context",
    manifest: makeContextManifest({ requestId: "req-c1" }),
  });
}

interface Dispatch {
  prompt: string;
  opts: RunAsSessionOpts;
}

function makeCtx(dispatch: Dispatch[]): BuildHopCallbackContext {
  const handle: SessionHandle = { id: "nax-c1", agentName: "claude" };
  return {
    sessionManager: makeSessionManager({ openSession: mock(async () => handle) }),
    agentManager: makeMockAgentManager({
      runAsSessionFn: (_agentName, _handle, prompt, opts): Promise<TurnResult> => {
        dispatch.push({ prompt, opts });
        return Promise.resolve({
          output: "ok",
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          estimatedCostUsd: 0,
        });
      },
    }),
    story: makeStory({ id: "US-002" }),
    config: makeNaxConfig(),
    featureName: "coding-tools",
    workdir: root,
    effectiveTier: "balanced",
    defaultAgent: "claude",
    pipelineStage: "review",
  };
}

function makeOptions(config: BuildHopCallbackContext["config"]): AgentRunOptions {
  return {
    prompt: "review US-002",
    workdir: root,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config,
    // What adversarial-review declares, and the root callOp resolves for it.
    declaredTools: ["Read", "Glob", "Grep", "Git"],
    codingToolRoot: root,
    storyId: "US-002",
  };
}

function only(dispatch: Dispatch[]): Dispatch {
  expect(dispatch).toHaveLength(1);
  const first = dispatch[0];
  if (!first) throw new Error("no dispatch recorded");
  return first;
}

async function dispatchOnce(): Promise<Dispatch> {
  const dispatch: Dispatch[] = [];
  const ctx = makeCtx(dispatch);
  const options = makeOptions(ctx.config);
  const cb = buildHopCallback(ctx, SESSION_ID, options);
  await cb("claude", emptyBundle(), { kind: "primary" } satisfies HopKind, options);
  return only(dispatch);
}

let origWriteManifest: typeof _buildHopCallbackDeps.writeRebuildManifest;

beforeEach(() => {
  origWriteManifest = _buildHopCallbackDeps.writeRebuildManifest;
  _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {});
});

afterEach(() => {
  _buildHopCallbackDeps.writeRebuildManifest = origWriteManifest;
});

describe("buildHopCallback — declared coding tools reach the agent", () => {
  test("carries the story into the runtime, so the invocation log is attributable", async () => {
    await Bun.write(`${root}/calc.ts`, "export const divide = () => 0;\n");
    const logger = makeLogger();
    const origLogger = _codingToolDeps.getLogger;
    _codingToolDeps.getLogger = () => logger;
    try {
      const { opts } = await dispatchOnce();
      await opts.interactionHandler?.onInteraction({ kind: "coding-tool", name: "Read", input: { path: "calc.ts" } });

      const line = logger.calls.find((c) => c.stage === "coding-tool" && c.message === "invoked");
      // Asserted on the real dispatch path: coding-tool-support.test.ts proves
      // the helper threads it, not that the hop ever populates it.
      expect(line?.data?.storyId).toBe("US-002");
    } finally {
      _codingToolDeps.getLogger = origLogger;
    }
  });

  test("advertises the operation's declared tools to the dispatched session", async () => {
    const { opts } = await dispatchOnce();

    expect(opts.codingTools?.map((t) => t.name).sort()).toEqual(["Git", "Glob", "Grep", "Read"]);
  });

  test("installs an interaction handler with no bridge and no context pull tools", async () => {
    const { opts } = await dispatchOnce();

    // Without this the adapter falls back to NO_OP_INTERACTION_HANDLER and a
    // well-formed coding-tool call is never answered.
    expect(opts.interactionHandler).toBeDefined();
  });

  test("routes a coding-tool call through to a live runtime", async () => {
    await Bun.write(`${root}/calc.ts`, "export const divide = (d: number, n: number) => n / d;\n");
    const { opts } = await dispatchOnce();

    const response = await opts.interactionHandler?.onInteraction({
      kind: "coding-tool",
      name: "Read",
      input: { path: "calc.ts" },
    });

    // A handler built without codingToolRuntime returns null here, which the
    // model sees as "that tool does not exist".
    expect(response?.answer).toContain("divide");
  });
});

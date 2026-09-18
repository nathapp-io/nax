/**
 * Phase C1 wiring — a declared coding tool must actually reach the agent on the
 * run() path.
 *
 * This is nax#1744 repeated one layer up. `buildCodingToolSupport` is the only
 * producer of a live CodingToolRuntime, and its sole caller used to be a
 * tracked-session path no production code reached (deleted in nax#1903).
 * `callOp` dispatches through `buildHopCallback` instead, which forwarded a
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
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";
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

async function dispatchOnce(overrides: Partial<AgentRunOptions> = {}): Promise<Dispatch> {
  const dispatch: Dispatch[] = [];
  const ctx = makeCtx(dispatch);
  const options: AgentRunOptions = { ...makeOptions(ctx.config), ...overrides };
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

      // The message now names the tool and outcome ("Read ok"); the stage is the
      // stable selector.
      const line = logger.calls.find((c) => c.stage === "coding-tool");
      // Asserted on the real dispatch path: coding-tool-support.test.ts proves
      // the helper threads it, not that the hop ever populates it.
      expect(line?.data?.storyId).toBe("US-002");
    } finally {
      _codingToolDeps.getLogger = origLogger;
    }
  });

  test("advertises the operation's declared tools to the dispatched session", async () => {
    const { opts } = await dispatchOnce();

    // US-003 invariant: the operation's declaration is the ceiling on
    // REPOSITORY tools, but the scratchpad tools are the universal layer
    // appended on every op, so the advertised set contains the declared
    // read/repo tools AND the three scratchpad tools, with no other
    // repository tool. Closed-list form is replaced because the append at
    // declaredWithProviders necessarily grows the set.
    const advertised = opts.codingTools?.map((t) => t.name) ?? [];
    // Declared repository tools reach the advertised set.
    expect(advertised).toContain("Read");
    expect(advertised).toContain("Glob");
    expect(advertised).toContain("Grep");
    expect(advertised).toContain("Git");
    // Universal scratchpad layer.
    expect(advertised).toContain("ScratchpadWrite");
    expect(advertised).toContain("ScratchpadRead");
    expect(advertised).toContain("ScratchpadList");
    // No repository-mutating tool the op did not declare.
    expect(advertised).not.toContain("Write");
    expect(advertised).not.toContain("Edit");
    expect(advertised).not.toContain("Delete");
    expect(advertised).not.toContain("GitCommit");
    expect(advertised).not.toContain("RunCommand");
    expect(advertised).not.toContain("Exec");
    // Distinctness: the same tool must not appear twice -- a duplicate ships
    // two ToolDefinitions for it to the provider. `toContain` cannot see that;
    // the set-size check can. The branch that dedupes a declaration already
    // carrying a scratchpad name is exercised in the test below.
    expect(new Set(advertised).size).toBe(advertised.length);
  });

  test("dedupes the universal scratchpad layer against a declaration that already carries it", async () => {
    // The `omit tools` production shape: resolveDeclaredTools hands the run
    // DEFAULT_CODING_TOOLS, which already holds all three scratchpad names.
    // Appending the universal layer without filtering them puts each name into
    // the union twice, and runtime.advertised() copies the list verbatim --
    // duplicate ToolDefinitions in the provider request. Asserted on what
    // reaches the dispatched session, not on the seam in isolation.
    const { opts } = await dispatchOnce({ declaredTools: DEFAULT_CODING_TOOLS });
    const advertised = opts.codingTools?.map((t) => t.name) ?? [];
    expect(new Set(advertised).size).toBe(advertised.length);
    expect(advertised.filter((name) => name === "ScratchpadWrite")).toHaveLength(1);
    expect(advertised.filter((name) => name === "ScratchpadRead")).toHaveLength(1);
    expect(advertised.filter((name) => name === "ScratchpadList")).toHaveLength(1);
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

  test("prepends the scope block on a dispatch with no context pull tools", async () => {
    const { prompt } = await dispatchOnce();

    // The run() path dispatches through this callback, so the scope block has
    // to reach an agent that has coding tools but no pull tools — the exact
    // agent the feature exists for.
    expect(prompt).toContain("## Your file scope");
    // The pull-tool catalogue stays gated on the tools actually being present.
    expect(prompt).not.toContain("## Context Pull Tools");
  });
});

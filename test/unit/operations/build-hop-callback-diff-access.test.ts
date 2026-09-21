/**
 * What actually reaches `runAsSession` on the run() path — never a wiring seam
 * in isolation. `callOp` dispatches through `buildHopCallback` as
 * `request.executeHop`, and `AgentManager.runWithFallback` invokes `executeHop`
 * INSTEAD OF `_runHop`, so `createSessionRunHop` (runtime/session-run-hop.ts)
 * is bypassed entirely on that path. Every suite here asserts on the dispatched
 * prompt/options, because each of these features passed its own seam unit test
 * while the chain was dead end to end.
 *
 * nax#1744 (pull tools) — the bundle, descriptors and tool runtime were
 * assembled correctly by #1737/#1741/#1742; the agent was simply never told the
 * tools existed. The three lines that made them reachable are the preamble
 * below, the handler that answers the call, and the turn budget in `send`.
 *
 * nax#1744 (coding tools, one layer up) — `buildCodingToolSupport` is the only
 * producer of a live CodingToolRuntime, and its sole caller used to be a
 * tracked-session path no production code reached (deleted in nax#1903).
 *
 * #1800 (diff access) — the diff-access substitution must reach the agent, and
 * US-002: the gate is no longer the protocol alone. Native rendering only
 * applies when the agent will actually advertise Git AND Read; without either,
 * the dispatch falls back to the shell body. The tools are read from the
 * resolved `codingSupport` BEFORE the substitution call, and the bound `send`
 * closure substitutes each turn prompt it is handed.
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
import type { ContextBundle, ToolDescriptor } from "@/context/engine";
import type { BuildHopCallbackContext } from "@/operations";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import { wrapDiffAccess } from "@/prompts/sections/diff-access";
import { PROTOCOL_REGION_MARKER_PREFIX } from "@/prompts/sections/protocol-region";
import type { CodingToolName } from "@/tools";
import { _codingToolDeps } from "@/tools";

const WORKDIR = "/repo";
const PROMPT = `review US-001\n${wrapDiffAccess({ ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n")}end`;
const SESSION_ID = "sess-1744";
const CODING_TOOLS_SESSION_ID = "sess-c1";

const QUERY_NEIGHBOR: ToolDescriptor = {
  name: "query_neighbor",
  description: "Look up import-graph neighbours of a file",
  inputSchema: { type: "object", properties: {} },
  maxCallsPerSession: 5,
  maxTokensPerCall: 2000,
};

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-hop-diff-access-");
});

afterEach(() => {
  cleanupTempDir(root);
});

let origCreateRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;
let origWriteManifest: typeof _buildHopCallbackDeps.writeRebuildManifest;
let origRebuildForAgent: typeof _buildHopCallbackDeps.rebuildForAgent;

beforeEach(() => {
  origCreateRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  origWriteManifest = _buildHopCallbackDeps.writeRebuildManifest;
  origRebuildForAgent = _buildHopCallbackDeps.rebuildForAgent;
  _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {});
  // A REAL runtime — createContextToolRuntime returns undefined only when the
  // bundle configures no usable tool, and the preamble is gated on both. The
  // pull-tool catalogue is still gated on pullTools.length beyond this.
  _buildHopCallbackDeps.createContextToolRuntime = mock(() => ({
    callTool: async () => "neighbour result",
  }));
});

afterEach(() => {
  _buildHopCallbackDeps.createContextToolRuntime = origCreateRuntime;
  _buildHopCallbackDeps.writeRebuildManifest = origWriteManifest;
  _buildHopCallbackDeps.rebuildForAgent = origRebuildForAgent;
});

/** Build a config with the requested permission profile. */
function configForProfile(permissionProfile: "unrestricted" | "safe" = "unrestricted") {
  return makeNaxConfig({ execution: { permissionProfile } });
}

interface DispatchRecord {
  agentName: string;
  prompt: string;
}

function makeDiffAccessCtx(
  agentName: string,
  records: DispatchRecord[],
  config = configForProfile(),
  workdir = WORKDIR,
): BuildHopCallbackContext {
  const handle: SessionHandle = { id: "nax-diff-access", agentName };
  return {
    sessionManager: makeSessionManager({ openSession: mock(async () => handle) }),
    agentManager: makeMockAgentManager({
      runAsSessionFn: (name, _handle, prompt): Promise<TurnResult> => {
        records.push({ agentName: name, prompt });
        return Promise.resolve({
          output: "ok",
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          estimatedCostUsd: 0,
        });
      },
    }),
    story: makeStory({ id: "US-001" }),
    config,
    featureName: "diff-access",
    workdir,
    effectiveTier: "balanced",
    defaultAgent: agentName,
    pipelineStage: "review",
  };
}

/** The prompt the agent was actually dispatched — the only seam that proves reachability. */
async function dispatchedPrompt(
  agentName: string,
  overrides: { permissionProfile?: "unrestricted" | "safe"; declaredTools?: readonly CodingToolName[] } = {},
): Promise<string> {
  const records: DispatchRecord[] = [];
  const config = configForProfile(overrides.permissionProfile ?? "unrestricted");
  const ctx = makeDiffAccessCtx(agentName, records, config);
  const options: AgentRunOptions = {
    prompt: PROMPT,
    workdir: WORKDIR,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: ctx.config,
    declaredTools: overrides.declaredTools ?? ["Read", "Glob", "Grep", "Git"],
    codingToolRoot: WORKDIR,
    storyId: "US-001",
  };

  const cb = buildHopCallback(ctx, "sess-diff-access", options);
  // An empty bundle: a review op need not carry context pull tools, and the
  // substitution must not depend on whether it does.
  await cb(agentName, makeContextBundle({ pullTools: [] }), { kind: "primary" } satisfies HopKind, options);

  return records[0]?.prompt ?? "";
}

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

function only(dispatch: Dispatch[]): Dispatch {
  expect(dispatch).toHaveLength(1);
  const first = dispatch[0];
  if (!first) throw new Error("no dispatch recorded");
  return first;
}

function makeContextToolsCtx(
  dispatch: Dispatch[],
  overrides: Partial<BuildHopCallbackContext> = {},
): BuildHopCallbackContext {
  const handle: SessionHandle = { id: "nax-1744", agentName: "claude" };
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
    story: makeStory({ id: "US-001" }),
    config: makeNaxConfig(),
    featureName: "ctx-tools",
    workdir: WORKDIR,
    effectiveTier: "balanced",
    defaultAgent: "claude",
    pipelineStage: "run",
    ...overrides,
  };
}

function makeContextToolsOptions(prompt: string, config: BuildHopCallbackContext["config"]): AgentRunOptions {
  return {
    prompt,
    workdir: WORKDIR,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config,
  };
}

function makeBundle(pullTools: ToolDescriptor[]): ContextBundle {
  return makeContextBundle({
    pullTools,
    pushMarkdown: "## Context",
    manifest: makeContextManifest({ requestId: "req-1744" }),
  });
}

function makeCodingToolsCtx(dispatch: Dispatch[]): BuildHopCallbackContext {
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

function makeCodingToolsOptions(config: BuildHopCallbackContext["config"]): AgentRunOptions {
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

async function dispatchOnce(overrides: Partial<AgentRunOptions> = {}): Promise<Dispatch> {
  const dispatch: Dispatch[] = [];
  const ctx = makeCodingToolsCtx(dispatch);
  const options: AgentRunOptions = { ...makeCodingToolsOptions(ctx.config), ...overrides };
  const cb = buildHopCallback(ctx, CODING_TOOLS_SESSION_ID, options);
  await cb("claude", emptyBundle(), { kind: "primary" } satisfies HopKind, options);
  return only(dispatch);
}

// ---------------------------------------------------------------------------
// AC5 — native dispatch with grants advertising Git AND Read ⇒ native rendering
// ---------------------------------------------------------------------------
describe("AC5 — native dispatch with Git+Read advertised receives native rendering", () => {
  test("native + unrestricted profile (Git+Read granted) + declared [Read, Glob, Grep, Git] ⇒ tool-shaped diff", async () => {
    // `unrestricted` profile grants Git + Read; declared [Read, Glob, Grep, Git]
    // is the intersection ⇒ advertised includes Git and Read. The prompt
    // therefore gets the native tool-shaped rendering, not the shell body.
    const prompt = await dispatchedPrompt("native", {
      permissionProfile: "unrestricted",
      declaredTools: ["Read", "Glob", "Grep", "Git"],
    });
    expect(prompt).toContain("review US-001");
    expect(prompt).toContain('"subcommand":"diff"');
    expect(prompt).not.toContain("SHELL BODY");
  });

  test("AC5 (boundary): native but only Read advertised (no Git) keeps the shell body", async () => {
    // Defensive — declares Git but the safe profile does NOT grant it, so
    // Git is dropped from advertised tools. Native rendering then does not
    // apply because Git is required. Verifies the gate is the advertised set,
    // not the declared list.
    const prompt = await dispatchedPrompt("native", {
      permissionProfile: "safe",
      declaredTools: ["Read", "Glob", "Grep", "Git"],
    });
    expect(prompt).toContain("SHELL BODY");
    expect(prompt).not.toContain('"subcommand":"diff"');
  });
});

// ---------------------------------------------------------------------------
// AC6 — native dispatch with only Read/Glob/Grep advertised ⇒ shell body
// ---------------------------------------------------------------------------
describe("AC6 — native dispatch with neither Git nor Read advertised receives the shell body", () => {
  test("native + safe profile + declared [Read, Glob, Grep, Git] ⇒ Git not granted ⇒ shell body", async () => {
    // The default safe profile grants Read/Glob/Grep but NOT Git. Declaring
    // Git in the operation does NOT make it advertised — the gate is the
    // advertised set, which the safe profile cannot include Git on.
    const prompt = await dispatchedPrompt("native", {
      permissionProfile: "safe",
      declaredTools: ["Read", "Glob", "Grep", "Git"],
    });
    expect(prompt).toContain("SHELL BODY");
    expect(prompt).not.toContain('"subcommand":"diff"');
  });

  test("native + safe profile + declared [Read, Glob, Grep] (no Git) ⇒ shell body", async () => {
    const prompt = await dispatchedPrompt("native", {
      permissionProfile: "safe",
      declaredTools: ["Read", "Glob", "Grep"],
    });
    expect(prompt).toContain("SHELL BODY");
    expect(prompt).not.toContain('"subcommand":"diff"');
  });

  test("AC6 (boundary): the protocol-region marker prefix never reaches the agent", async () => {
    // Even when the gate falls back to the shell body, the dispatch must not
    // ship any marker text — the agent would see a stray `<!--nax:` and either
    // ignore it (best) or echo it back (worst, breaks byte-parity downstream).
    const prompt = await dispatchedPrompt("native", {
      permissionProfile: "safe",
      declaredTools: ["Read", "Glob", "Grep", "Git"],
    });
    expect(prompt).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(prompt).not.toContain("nax:diff-access");
  });
});

// ---------------------------------------------------------------------------
// AC7 — non-native agent receives no exported marker-prefix substring
// ---------------------------------------------------------------------------
describe("AC7 — non-native dispatch strips every marker-prefix substring", () => {
  test("ACP agent (claude) + region ⇒ no PROTOCOL_REGION_MARKER_PREFIX substring", async () => {
    const prompt = await dispatchedPrompt("claude", {
      permissionProfile: "unrestricted",
      declaredTools: ["Read", "Glob", "Grep", "Git"],
    });
    expect(prompt).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(prompt).not.toContain("<!--nax:");
  });

  test("ACP agent + safe profile ⇒ still no marker prefix", async () => {
    const prompt = await dispatchedPrompt("claude", {
      permissionProfile: "safe",
      declaredTools: ["Read", "Glob", "Grep", "Git"],
    });
    expect(prompt).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(prompt).not.toContain("<!--nax:");
  });

  test("ACP agent receives the shell body with surrounding text preserved", async () => {
    const prompt = await dispatchedPrompt("claude", {
      permissionProfile: "unrestricted",
      declaredTools: ["Read", "Glob", "Grep", "Git"],
    });
    expect(prompt).toContain("review US-001");
    expect(prompt).toContain("SHELL BODY");
    expect(prompt).toContain("end");
  });
});

// ---------------------------------------------------------------------------
// AC8 — hop body calls bound `send` with a region-containing prompt ⇒ substituted
// ---------------------------------------------------------------------------
describe("AC8 — the bound `send` closure substitutes every turn prompt it is handed", () => {
  async function secondTurnPrompt(): Promise<string> {
    const records: DispatchRecord[] = [];
    const config = configForProfile("unrestricted");
    const ctx = makeDiffAccessCtx("native", records, config);
    const options: AgentRunOptions = {
      prompt: `first prompt ${wrapDiffAccess({ ref: "r1", fullExclude: ["."] }, "SHELL BODY\n")}`,
      workdir: WORKDIR,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      timeoutSeconds: 60,
      config: ctx.config,
      declaredTools: ["Read", "Glob", "Grep", "Git"],
      codingToolRoot: WORKDIR,
      storyId: "US-001",
    };
    // Use a hopBody that calls send with a second region-bearing prompt. This
    // mimics the review-op pattern that retries on JSON-parse failure: the
    // follow-up turn must be substituted independently of the first.
    const region = wrapDiffAccess({ ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n");
    const secondPrompt = `second turn ${region}`;
    const cb = buildHopCallback(
      {
        ...ctx,
        hopBody: async (_initial, bodyCtx) => {
          await bodyCtx.send(secondPrompt);
          return {
            output: "done",
            internalRoundTrips: 1,
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
            estimatedCostUsd: 0,
          };
        },
      },
      "sess-diff-access-second",
      options,
    );

    await cb("native", makeContextBundle({ pullTools: [] }), { kind: "primary" } satisfies HopKind, options);
    // hopBody in this test issues exactly ONE additional send (secondPrompt).
    // The initial prompt is NOT dispatched — `send` is only invoked from
    // inside hopBody. So records[0] is the secondPrompt.
    return records[0]?.prompt ?? "";
  }

  test("the second `send` invocation receives a substituted prompt with no marker prefix", async () => {
    const prompt = await secondTurnPrompt();
    expect(prompt).toContain("second turn");
    expect(prompt).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(prompt).not.toContain("<!--nax:");
    // Native + Git+Read advertised ⇒ tool-shaped rendering, not the shell body.
    expect(prompt).toContain('"subcommand":"diff"');
    expect(prompt).not.toContain("SHELL BODY");
  });
});

// ---------------------------------------------------------------------------
// AC9 — the prompt returned from the hop callback is the substituted prompt
// ---------------------------------------------------------------------------
describe("AC9 — the hop callback returns the substituted initial prompt", () => {
  test("native + Git+Read advertised ⇒ returned prompt contains no marker prefix", async () => {
    const records: DispatchRecord[] = [];
    const config = configForProfile("unrestricted");
    const ctx = makeDiffAccessCtx("native", records, config);
    const options: AgentRunOptions = {
      prompt: `head ${wrapDiffAccess({ ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n")}tail`,
      workdir: WORKDIR,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      timeoutSeconds: 60,
      config: ctx.config,
      declaredTools: ["Read", "Glob", "Grep", "Git"],
      codingToolRoot: WORKDIR,
      storyId: "US-001",
    };

    const cb = buildHopCallback(ctx, "sess-diff-access-return", options);
    const result = await cb(
      "native",
      makeContextBundle({ pullTools: [] }),
      { kind: "primary" } satisfies HopKind,
      options,
    );
    const returnedPrompt: string | undefined = result.prompt;
    expect(returnedPrompt).toBeDefined();
    expect(returnedPrompt).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
    expect(returnedPrompt).not.toContain("<!--nax:");
    // Native + Git+Read advertised ⇒ tool-shaped rendering, not the shell body.
    expect(returnedPrompt).toContain('"subcommand":"diff"');
    expect(returnedPrompt).not.toContain("SHELL BODY");
  });

  test("ACP dispatch ⇒ returned prompt preserves the shell body with no markers", async () => {
    const records: DispatchRecord[] = [];
    const config = configForProfile("unrestricted");
    const ctx = makeDiffAccessCtx("claude", records, config);
    const options: AgentRunOptions = {
      prompt: `head ${wrapDiffAccess({ ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n")}tail`,
      workdir: WORKDIR,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      timeoutSeconds: 60,
      config: ctx.config,
      declaredTools: ["Read", "Glob", "Grep", "Git"],
      codingToolRoot: WORKDIR,
      storyId: "US-001",
    };

    const cb = buildHopCallback(ctx, "sess-diff-acp-return", options);
    const result = await cb(
      "claude",
      makeContextBundle({ pullTools: [] }),
      { kind: "primary" } satisfies HopKind,
      options,
    );
    const returnedPrompt: string | undefined = result.prompt;
    expect(returnedPrompt).toBeDefined();
    expect(returnedPrompt).toContain("SHELL BODY");
    expect(returnedPrompt).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
  });
});

describe("buildHopCallback — context pull tools reach the agent (nax#1744)", () => {
  test("advertises the bundle's pull tools in the dispatched prompt", async () => {
    const dispatch: Dispatch[] = [];
    const ctx = makeContextToolsCtx(dispatch);
    const options = makeContextToolsOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    await cb("claude", makeBundle([QUERY_NEIGHBOR]), { kind: "primary" } satisfies HopKind, options);

    const { prompt } = only(dispatch);
    expect(prompt).toContain("implement US-001");
    expect(prompt).toContain("Context Pull Tools");
    expect(prompt).toContain("query_neighbor");
    // The agent also needs the call syntax, not just the tool name.
    expect(prompt).toContain("<nax_tool_call");
  });

  test("installs an interaction handler even with no interactionBridge", async () => {
    const dispatch: Dispatch[] = [];
    const ctx = makeContextToolsCtx(dispatch);
    const options = makeContextToolsOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    await cb("claude", makeBundle([QUERY_NEIGHBOR]), { kind: "primary" } satisfies HopKind, options);

    // Without this, sendPrompt falls back to NO_OP_INTERACTION_HANDLER and a
    // well-formed <nax_tool_call> is never answered.
    expect(only(dispatch).opts.interactionHandler).toBeDefined();
  });

  test("raises the turn budget so a tool round-trip has room", async () => {
    const dispatch: Dispatch[] = [];
    const ctx = makeContextToolsCtx(dispatch);
    const options = makeContextToolsOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    await cb("claude", makeBundle([QUERY_NEIGHBOR]), { kind: "primary" } satisfies HopKind, options);

    // Mirrors session-run-hop.ts: a single turn leaves no room to answer a call.
    expect(only(dispatch).opts.maxInteractions).toBe(10);
  });

  test("returns the advertised prompt so the audit records what the agent saw", async () => {
    const dispatch: Dispatch[] = [];
    const ctx = makeContextToolsCtx(dispatch);
    const options = makeContextToolsOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    const hop = await cb("claude", makeBundle([QUERY_NEIGHBOR]), { kind: "primary" } satisfies HopKind, options);

    expect(hop.prompt).toContain("query_neighbor");
    expect(hop.prompt).toBe(only(dispatch).prompt);
  });

  test("applies the preamble AFTER the swap-handoff rewrite, not before", async () => {
    const rebuilt = makeBundle([QUERY_NEIGHBOR]);
    _buildHopCallbackDeps.rebuildForAgent = mock(() => rebuilt);
    const dispatch: Dispatch[] = [];
    const ctx = makeContextToolsCtx(dispatch);
    const options = makeContextToolsOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);
    const failure = { category: "availability", outcome: "fail-rate-limit", retriable: true, message: "429" } as const;

    await cb("codex", makeBundle([QUERY_NEIGHBOR]), { kind: "swap", failure } satisfies HopKind, options);

    const { prompt } = only(dispatch);
    // The swap handoff rewrites the prompt wholesale; a preamble applied before
    // it would be discarded, leaving the fallback agent with no tools.
    expect(prompt).toContain("query_neighbor");
  });

  test("leaves the prompt and turn budget untouched when the bundle has no pull tools", async () => {
    _buildHopCallbackDeps.createContextToolRuntime = mock(() => undefined);
    const dispatch: Dispatch[] = [];
    const ctx = makeContextToolsCtx(dispatch);
    const options = makeContextToolsOptions("implement US-001", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, options);

    await cb("claude", makeBundle([]), { kind: "primary" } satisfies HopKind, options);

    const { prompt, opts } = only(dispatch);
    expect(prompt).toBe("implement US-001");
    expect(prompt).not.toContain("Context Pull Tools");
    expect(opts.maxInteractions).toBeUndefined();
  });
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

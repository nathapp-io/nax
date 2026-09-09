/**
 * #1800 — the diff-access substitution must reach the agent on the run() path.
 *
 * `callOp` dispatches through `buildHopCallback` as `request.executeHop`, and
 * `AgentManager.runWithFallback` invokes `executeHop` INSTEAD OF `_runHop`, so
 * `createSessionRunHop` is bypassed entirely there. Both review ops are
 * `kind: "run"`, so this is the site their prompts actually pass through.
 *
 * Asserted here rather than on the renderer for the reason the sibling
 * context-tools suite records: deleting this wiring passes every other
 * test in the repository. The preamble beside it is applied only when the op
 * also has context pull tools, and a review op need not have any — so the
 * two cannot share a gate either.
 *
 * US-002 — the gate is no longer the protocol alone. Native rendering only
 * applies when the agent will actually advertise `Git` AND `Read`; without
 * either, the dispatch falls back to the shell body. The tools are read from
 * the resolved `codingSupport` (intersection of declared and granted) BEFORE
 * the substitution call, so a fallback swap that changes the protocol cannot
 * change the tool set, and the bound `send` closure substitutes each turn
 * prompt it is handed (so a hop body's follow-up turn is gated too, not just
 * the first one).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  makeContextBundle,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { AgentRunOptions, HopKind, SessionHandle, TurnResult } from "@/agents";
import type { BuildHopCallbackContext } from "@/operations";
import { buildHopCallback } from "@/operations";
import { wrapDiffAccess } from "@/prompts/sections/diff-access";
import { PROTOCOL_REGION_MARKER_PREFIX } from "@/prompts/sections/protocol-region";
import type { CodingToolName } from "@/tools";

const WORKDIR = "/repo";
const PROMPT = `review US-001\n${wrapDiffAccess({ ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n")}end`;

/** Build a config with the requested permission profile. */
function configForProfile(permissionProfile: "unrestricted" | "safe" = "unrestricted") {
  return makeNaxConfig({ execution: { permissionProfile } });
}

interface DispatchRecord {
  agentName: string;
  prompt: string;
}

function makeCtx(
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
  const ctx = makeCtx(agentName, records, config);
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

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-hop-diff-access-");
});

afterEach(() => {
  cleanupTempDir(root);
});

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
    const ctx = makeCtx("native", records, config);
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
    const ctx = makeCtx("native", records, config);
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
    const ctx = makeCtx("claude", records, config);
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

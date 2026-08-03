import { describe, expect, test } from "bun:test";
import { contextToolRuntimeConfigSelector } from "../../../../src/config";
import type { ContextToolRuntimeConfig } from "../../../../src/config/selectors";
import { createContextToolRuntime, createSessionToolBudgets } from "../../../../src/context/engine";
import type { ContextBundle } from "../../../../src/context/engine";
import { makeNaxConfig } from "../../../helpers/mock-nax-config";

describe("createContextToolRuntime — slice acceptance", () => {
  test("contextToolRuntimeConfigSelector picks context, execution, project, quality", () => {
    const full = makeNaxConfig();
    const sliced = contextToolRuntimeConfigSelector.select(full);
    expect(Object.keys(sliced).sort()).toEqual(["context", "execution", "project", "quality"]);
  });

  test("createContextToolRuntime accepts a ContextToolRuntimeConfig slice (no NaxConfig cast)", () => {
    const config: ContextToolRuntimeConfig = {
      context: undefined,
      execution: undefined,
      project: undefined,
      quality: undefined,
    };
    const emptyBundle: ContextBundle = {
      pushMarkdown: "",
      pullTools: [],
      meta: { stage: "test", schemaVersion: 1, totalTokens: 0 },
    } as unknown as ContextBundle;
    const story = { id: "S-001", workdir: "" } as Parameters<typeof createContextToolRuntime>[0]["story"];
    const runtime = createContextToolRuntime({
      bundle: emptyBundle,
      story,
      config,
      repoRoot: "/tmp",
    });
    expect(runtime).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap finding 7 — the pull budget was per-tool-per-HOP, not per-session.
// createContextToolRuntime built a fresh `budgets` Map every call, and
// build-hop-callback constructs the runtime INSIDE the hop closure, so every
// retry / fallback / escalation hop reset maxCallsPerSession to zero. Only the
// run-level counter (threaded in as runCounter) was ever real.
// ─────────────────────────────────────────────────────────────────────────────

function makeBundleWithTool(maxCallsPerSession: number): ContextBundle {
  return {
    pushMarkdown: "",
    pullTools: [
      {
        name: "query_feature_context",
        description: "test tool",
        inputSchema: { type: "object", properties: {} },
        maxCallsPerSession,
        maxTokensPerCall: 100,
      },
    ],
    meta: { stage: "test", schemaVersion: 1, totalTokens: 0 },
  } as unknown as ContextBundle;
}

const RUNTIME_CONFIG: ContextToolRuntimeConfig = {
  context: undefined,
  execution: undefined,
  project: undefined,
  quality: undefined,
};

describe("createContextToolRuntime — session-scoped pull budget", () => {
  const story = { id: "S-001", workdir: "" } as Parameters<typeof createContextToolRuntime>[0]["story"];

  test("a session budget registry shared across runtimes keeps consumption across hops", async () => {
    const sessionBudgets = createSessionToolBudgets();
    const bundle = makeBundleWithTool(1);

    // Hop 1 — a fresh runtime, as build-hop-callback constructs per hop.
    const hop1 = createContextToolRuntime({
      bundle,
      story,
      config: RUNTIME_CONFIG,
      repoRoot: "/tmp",
      sessionBudgets,
    });
    await hop1?.callTool("query_feature_context", {});

    // Hop 2 — another fresh runtime sharing the same session registry.
    const hop2 = createContextToolRuntime({
      bundle,
      story,
      config: RUNTIME_CONFIG,
      repoRoot: "/tmp",
      sessionBudgets,
    });

    let threw: unknown;
    try {
      await hop2?.callTool("query_feature_context", {});
    } catch (e) {
      threw = e;
    }
    expect(threw).toMatchObject({ code: "PULL_TOOL_BUDGET_EXHAUSTED" });
  });

  test("omitting the registry keeps each runtime independent (previous behaviour)", async () => {
    const bundle = makeBundleWithTool(1);
    const a = createContextToolRuntime({ bundle, story, config: RUNTIME_CONFIG, repoRoot: "/tmp" });
    await a?.callTool("query_feature_context", {});

    const b = createContextToolRuntime({ bundle, story, config: RUNTIME_CONFIG, repoRoot: "/tmp" });
    await b?.callTool("query_feature_context", {});
    // No throw — an isolated runtime still gets its own allowance.
  });

  test("rejects an unknown tool with a NaxError carrying a machine-readable code", async () => {
    const runtime = createContextToolRuntime({
      bundle: makeBundleWithTool(5),
      story,
      config: RUNTIME_CONFIG,
      repoRoot: "/tmp",
    });

    let threw: unknown;
    try {
      await runtime?.callTool("no_such_tool", {});
    } catch (e) {
      threw = e;
    }
    expect(threw).toMatchObject({ code: "PULL_TOOL_UNKNOWN" });
  });
});

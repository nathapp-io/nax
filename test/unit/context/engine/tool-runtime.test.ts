import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertNaxError,
  cleanupTempDir,
  makeContextBundle,
  makeNaxConfig,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { contextToolRuntimeConfigSelector } from "@/config";
import type { ContextToolRuntimeConfig } from "@/config/selectors";
import type { ContextBundle } from "@/context/engine";
import { createContextToolRuntime, createSessionToolBudgets } from "@/context/engine";
import { QUERY_FEATURE_CONTEXT_DESCRIPTOR, QUERY_NEIGHBOR_DESCRIPTOR } from "@/context/engine/pull-tools";
import type { ScratchEntry } from "@/session";
import { appendScratchEntry, scratchFilePath } from "@/session";

describe("createContextToolRuntime — slice acceptance", () => {
  test("contextToolRuntimeConfigSelector picks context, execution, project, quality", () => {
    const full = makeNaxConfig();
    const sliced = contextToolRuntimeConfigSelector.select(full);
    expect(Object.keys(sliced).sort()).toEqual(["context", "execution", "project", "quality"]);
  });

  test("createContextToolRuntime accepts a ContextToolRuntimeConfig slice (no NaxConfig cast)", () => {
    const config: ContextToolRuntimeConfig = contextToolRuntimeConfigSelector.select(makeNaxConfig());
    const emptyBundle: ContextBundle = makeContextBundle({
      pushMarkdown: "",
      pullTools: [],
    });
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
// retry / fallback / escalation hop reset maxCallsPerSession to zero. The
// run-level counter had the same defect: BuildHopCallbackContext declared
// contextToolRunCounter but nothing populated it, so it too reset per hop.
// ─────────────────────────────────────────────────────────────────────────────

function makeBundleWithTool(maxCallsPerSession: number): ContextBundle {
  return makeContextBundle({
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
  });
}

const RUNTIME_CONFIG: ContextToolRuntimeConfig = contextToolRuntimeConfigSelector.select(makeNaxConfig());

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

// ─────────────────────────────────────────────────────────────────────────────
// US-005: query_scratch runtime dispatch (AC11/AC12 require rectify and
// execution stages to declare query_scratch in pullToolNames; this block
// exercises the runtime dispatch wiring for the same.)
// ─────────────────────────────────────────────────────────────────────────────

describe("createContextToolRuntime — query_scratch dispatch", () => {
  const story = { id: "US-005", workdir: "" } as Parameters<typeof createContextToolRuntime>[0]["story"];

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-tool-runtime-scratch-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function makeBundleWithQueryScratch(maxCallsPerSession = 5): ContextBundle {
    return {
      pushMarkdown: "",
      pullTools: [
        {
          name: "query_scratch",
          description: "test scratch tool",
          inputSchema: {
            type: "object",
            properties: { kind: { type: "string" }, limit: { type: "number" } },
            required: [],
          },
          maxCallsPerSession,
          maxTokensPerCall: 100,
        },
      ],
      digest: "",
      manifest: {
        requestId: "test",
        stage: "test",
        totalBudgetTokens: 0,
        usedTokens: 0,
        includedChunks: [],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 0,
        buildMs: 0,
      },
      chunks: [],
    };
  }

  async function writeScratch(dir: string, entries: ScratchEntry[]): Promise<string> {
    await mkdir(dir, { recursive: true });
    for (const entry of entries) {
      await appendScratchEntry(dir, entry);
    }
    return scratchFilePath(dir);
  }

  test("dispatches query_scratch to handleQueryScratch with the story's scratch dir", async () => {
    const scratchDir = join(tmpDir, "sess-runtime");
    await writeScratch(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: "US-005",
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "runtime-dispatch",
      },
    ]);

    const runtime = createContextToolRuntime({
      bundle: makeBundleWithQueryScratch(),
      story,
      config: RUNTIME_CONFIG,
      repoRoot: "/tmp",
      storyScratchDirs: [scratchDir],
    });

    const result = await runtime?.callTool("query_scratch", {});
    expect(typeof result).toBe("string");
    expect(result).toContain("runtime-dispatch");
  });

  test("threads the requesting agent so cross-agent scratch is neutralized (AC10)", async () => {
    const scratchDir = join(tmpDir, "sess-neutralize");
    await writeScratch(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: "US-005",
        stage: "verify",
        success: false,
        status: "TEST_FAILURE",
        passCount: 0,
        failCount: 1,
        rawOutputTail: "I used the Read tool to inspect the failure.",
        writtenByAgent: "claude",
      },
    ]);

    const runtime = createContextToolRuntime({
      bundle: makeBundleWithQueryScratch(),
      story,
      config: RUNTIME_CONFIG,
      repoRoot: "/tmp",
      storyScratchDirs: [scratchDir],
      agentId: "codex",
    });

    const result = await runtime?.callTool("query_scratch", {});
    expect(result).not.toContain("the Read tool");
    expect(result).toContain("a file read");
  });

  test("invocations past the per-session ceiling are rejected via the existing pull-tool budget", async () => {
    const scratchDir = join(tmpDir, "sess-budget");
    await writeScratch(scratchDir, [
      {
        kind: "verify-result",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: "US-005",
        stage: "verify",
        success: true,
        status: "PASS",
        passCount: 1,
        failCount: 0,
        rawOutputTail: "ok",
      },
    ]);

    // Force a fresh budget per invocation (no session registry) — each runtime
    // resets sessionCalls. To exercise the runtime's own budget gate, set
    // maxCallsPerSession=1 and call twice from the same runtime.
    const runtime = createContextToolRuntime({
      bundle: makeBundleWithQueryScratch(1),
      story,
      config: RUNTIME_CONFIG,
      repoRoot: "/tmp",
      storyScratchDirs: [scratchDir],
    });
    await runtime?.callTool("query_scratch", {});

    let threw: unknown;
    try {
      await runtime?.callTool("query_scratch", {});
    } catch (e) {
      threw = e;
    }
    expect(threw).toMatchObject({ code: "PULL_TOOL_BUDGET_EXHAUSTED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-authored input is validated against the descriptor's own inputSchema
// before any handler runs. Descriptors already declare the contract the
// preamble advertises; validating against that same declaration is what keeps
// the advertised shape and the enforced shape from drifting apart.
// ─────────────────────────────────────────────────────────────────────────────

describe("createContextToolRuntime — validates input against the descriptor schema", () => {
  const story = makeStory({ id: "S-001", workdir: "" });

  function runtimeFor(descriptor: ContextBundle["pullTools"][number]) {
    return createContextToolRuntime({
      bundle: makeContextBundle({ pushMarkdown: "", pullTools: [descriptor] }),
      story,
      config: RUNTIME_CONFIG,
      repoRoot: "/tmp",
    });
  }

  test("rejects a wrongly-typed optional argument before it reaches the handler", async () => {
    // `filterByKeyword` calls `keyword.toLowerCase()`, so a numeric filter used
    // to throw a raw TypeError out of the provider — after budget.consume().
    const runtime = runtimeFor(QUERY_FEATURE_CONTEXT_DESCRIPTOR);

    let threw: unknown;
    try {
      await runtime?.callTool("query_feature_context", { filter: 5 });
    } catch (e) {
      threw = e;
    }
    assertNaxError(threw);
    expect(threw.code).toBe("PULL_TOOL_INVALID_INPUT");
    expect(threw.message).toContain("filter");
  });

  test("rejects a missing required argument before it reaches the handler", async () => {
    const runtime = runtimeFor(QUERY_NEIGHBOR_DESCRIPTOR);

    let threw: unknown;
    try {
      await runtime?.callTool("query_neighbor", {});
    } catch (e) {
      threw = e;
    }
    assertNaxError(threw);
    expect(threw.code).toBe("PULL_TOOL_INVALID_INPUT");
    expect(threw.message).toContain("filePath");
  });

  test("accepts a well-formed call, and tolerates an absent optional argument", async () => {
    const runtime = runtimeFor(QUERY_NEIGHBOR_DESCRIPTOR);
    // No throw: filePath is present and well-typed, depth is legitimately absent.
    await runtime?.callTool("query_neighbor", { filePath: "src/a.ts" });
  });
});

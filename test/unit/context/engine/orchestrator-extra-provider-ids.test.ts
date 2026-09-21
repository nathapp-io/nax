import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type MockLogger, makeLogger } from "@test/helpers";
import { _orchestratorDeps, ContextOrchestrator } from "@/context/engine/orchestrator";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "@/context/engine/types";

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  featureId: "test-feature",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "review",
  role: "reviewer",
  budgetTokens: 6_000,
  extraProviderIds: [],
};

const _origUuid = _orchestratorDeps.uuid;
const _origNow = _orchestratorDeps.now;
beforeEach(() => {
  _orchestratorDeps.uuid = () => "00000000-0000-4000-8000-000000000001";
  _orchestratorDeps.now = () => Date.now();
});

afterEach(() => {
  _orchestratorDeps.uuid = _origUuid;
  _orchestratorDeps.now = _origNow;
});

function makeProvider(id: string, fetch: () => Promise<ContextProviderResult>): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async () => fetch(),
  };
}

function makeChunk(providerId: string): ContextProviderResult {
  return {
    chunks: [
      {
        id: `${providerId}:chunk-1`,
        kind: "feature",
        scope: "feature",
        role: ["reviewer"],
        content: `content from ${providerId}`,
        tokens: 40,
        rawScore: 1,
      },
    ],
    pullTools: [],
  };
}

describe("ContextOrchestrator — issue #662 extraProviderIds", () => {
  test("runs extra providers only on opted-in stages and records manifest source", async () => {
    let pluginFetches = 0;
    const orchestrator = new ContextOrchestrator([
      makeProvider("static-rules", async () => ({ chunks: [], pullTools: [] })),
      makeProvider("feature-context", async () => ({ chunks: [], pullTools: [] })),
      makeProvider("my-symbol-graph", async () => {
        pluginFetches += 1;
        return makeChunk("my-symbol-graph");
      }),
    ]);

    const withExtra = await orchestrator.assemble({
      ...BASE_REQUEST,
      stage: "review-semantic",
      extraProviderIds: ["my-symbol-graph"],
    });
    const withoutExtra = await orchestrator.assemble({
      ...BASE_REQUEST,
      stage: "review",
      extraProviderIds: [],
    });

    expect(pluginFetches).toBe(1);
    expect(withExtra.manifest.providerResults?.find((p) => p.providerId === "my-symbol-graph")).toMatchObject({
      providerId: "my-symbol-graph",
      source: "extra",
      status: "ok",
    });
    expect(withExtra.manifest.providerResults?.find((p) => p.providerId === "static-rules")).toMatchObject({
      providerId: "static-rules",
      source: "stage-config",
    });
    expect(withoutExtra.manifest.providerResults?.some((p) => p.providerId === "my-symbol-graph")).toBe(false);
  });

  test("throws CONTEXT_UNKNOWN_PROVIDER_IDS for unknown extraProviderIds with stage context", async () => {
    const orchestrator = new ContextOrchestrator([
      makeProvider("static-rules", async () => ({ chunks: [], pullTools: [] })),
      makeProvider("feature-context", async () => ({ chunks: [], pullTools: [] })),
    ]);

    await expect(
      orchestrator.assemble({
        ...BASE_REQUEST,
        extraProviderIds: ["missing-provider"],
      }),
    ).rejects.toMatchObject({
      code: "CONTEXT_UNKNOWN_PROVIDER_IDS",
      context: {
        requestStage: "review",
        unknownProviderIds: ["missing-provider"],
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — ContextOrchestrator.assemble() agent framing
// ─────────────────────────────────────────────────────────────────────────────

const framingBaseRequest: ContextRequest = {
  storyId: "US-002",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
  providerIds: ["p1"],
};

function framingMakeProvider(): IContextProvider {
  const result: ContextProviderResult = {
    chunks: [
      {
        id: "c:1",
        kind: "feature",
        scope: "feature",
        role: ["implementer"],
        content: "feature context content",
        tokens: 200,
        rawScore: 1,
      },
    ],
    pullTools: [],
  };
  return { id: "p1", kind: "feature", fetch: async () => result };
}

describe("US-002 — ContextOrchestrator.assemble() agent framing", () => {
  test("AC-1: codex renders context_section wrappers", async () => {
    const bundle = await new ContextOrchestrator([framingMakeProvider()]).assemble({
      ...framingBaseRequest,
      agentId: "codex",
    });
    expect(bundle.pushMarkdown).toContain("<context_section type=");
  });

  test("AC-2: claude renders markdown section headers", async () => {
    const bundle = await new ContextOrchestrator([framingMakeProvider()]).assemble({
      ...framingBaseRequest,
      agentId: "claude",
    });
    expect(bundle.pushMarkdown).toContain("## Feature Context");
  });

  test("AC-3: absent agent id preserves markdown section headers", async () => {
    const bundle = await new ContextOrchestrator([framingMakeProvider()]).assemble(framingBaseRequest);
    expect(bundle.pushMarkdown).toContain("## Feature Context");
  });

  test.each(["unknown-agent", ""])(
    "AC-4: unregistered agent %p renders conservative bracket framing",
    async (agentId) => {
      const bundle = await new ContextOrchestrator([framingMakeProvider()]).assemble({
        ...framingBaseRequest,
        agentId,
      });
      expect(bundle.pushMarkdown).toContain("[Feature Context]");
    },
  );

  test("AC-5: unknown agent emits a warning naming the agent id", async () => {
    const originalGetLogger = _orchestratorDeps.getLogger;
    const mockLogger: MockLogger = makeLogger();
    _orchestratorDeps.getLogger = () => mockLogger;
    try {
      await new ContextOrchestrator([]).assemble({ ...framingBaseRequest, agentId: "unknown-agent" });
    } finally {
      _orchestratorDeps.getLogger = originalGetLogger;
    }
    const warning = mockLogger.calls.find((call) => call.level === "warn" && call.data?.agentId === "unknown-agent");
    expect(warning).toBeDefined();
  });

  test("AC-6: codex renders prior digest as prior_stage_summary", async () => {
    const bundle = await new ContextOrchestrator([]).assemble({
      ...framingBaseRequest,
      agentId: "codex",
      priorStageDigest: "Prior stage found X.",
    });
    expect(bundle.pushMarkdown).toContain('<context_section type="prior_stage_summary">');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextOrchestrator — #508-M12 unknown providerIds validation tests
//
// AC-16: the orchestrator must fail fast when configured provider IDs (stage
// config or, via the factory, plugin providers) reference an ID that matches
// no registered provider. This catches operator typos such as `"static-ruls"`.
//
// `request.providerIds` is an intentional test-only override (see orchestrator.ts
// comment at assemble()). Unknown IDs in the override filter silently so that
// fixtures can use a known-superset of IDs without registering every stub.
// ─────────────────────────────────────────────────────────────────────────────

const unknownProvidersBaseRequest: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 8_000,
};

function unknownProvidersMakeProvider(id: string): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async (): Promise<ContextProviderResult> => ({ chunks: [], pullTools: [] }),
  };
}

describe("ContextOrchestrator — #508-M12 unknown providerIds validation", () => {
  test("throws when a stage references a provider ID that is not registered", async () => {
    // The default "tdd-implementer" stage references static-rules, feature-context,
    // session-scratch, git-history, and code-neighbor. Register none of them so
    // the configured stage has unknown IDs.
    const orch = new ContextOrchestrator([unknownProvidersMakeProvider("unrelated")]);
    let threw: unknown;
    try {
      await orch.assemble(unknownProvidersBaseRequest);
    } catch (e) {
      threw = e;
    }
    expect(threw).toMatchObject({ code: "CONTEXT_UNKNOWN_PROVIDER_IDS" });
  });

  test("does not throw when request.providerIds (test-only override) references unknown IDs", async () => {
    // request.providerIds is a documented test-only override and unknown IDs
    // must filter silently so fixtures can use a known superset without
    // registering every stub.
    const orch = new ContextOrchestrator([unknownProvidersMakeProvider("real-provider")]);
    const result = await orch.assemble({
      ...unknownProvidersBaseRequest,
      providerIds: ["real-provider", "does-not-exist", "phantom-id"],
    });
    expect(result.manifest.includedChunks).toBeDefined();
  });

  test("does not throw when request.providerIds override contains only unknown IDs", async () => {
    const orch = new ContextOrchestrator([unknownProvidersMakeProvider("real-provider")]);
    const result = await orch.assemble({
      ...unknownProvidersBaseRequest,
      providerIds: ["ghost-id"],
    });
    expect(result.manifest.includedChunks).toBeDefined();
  });

  test("succeeds when request.providerIds is empty", async () => {
    const orch = new ContextOrchestrator([unknownProvidersMakeProvider("p1")]);
    const result = await orch.assemble({ ...unknownProvidersBaseRequest, providerIds: [] });
    expect(result.manifest.includedChunks).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 AC-1, AC-2 — ContextOrchestrator.assemble() propagates provider
// budgetPressure onto ContextManifest.providerResults[i].budgetPressure when
// the provider returns one, and OMITS the property when the provider does
// not (not just undefined — the property must be absent so legacy readers
// using `in` see the distinction).
// ─────────────────────────────────────────────────────────────────────────────

const budgetPressureBaseRequest: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
};

describe("ContextOrchestrator.assemble() — US-004 budgetPressure propagation (AC-1, AC-2)", () => {
  test("AC-1: manifest.providerResults entry carries the provider's returned budgetPressure verbatim", async () => {
    // Including droppedIds proves the orchestrator copies the shape verbatim
    // without stripping or restructuring fields.
    const pressure = { overageTokens: 100, droppedCount: 5, droppedTokens: 500, droppedIds: ["a", "b"] };
    const provider: IContextProvider = {
      id: "pressure-provider",
      kind: "static",
      fetch: async () => ({ chunks: [], pullTools: [], budgetPressure: pressure }),
    };
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble({
      ...budgetPressureBaseRequest,
      providerIds: ["pressure-provider"],
    });
    const entry = bundle.manifest.providerResults?.find((pr) => pr.providerId === "pressure-provider");

    expect(entry).toBeDefined();
    expect(entry?.budgetPressure).toEqual(pressure);
  });

  test("AC-2: manifest.providerResults entry omits budgetPressure when the provider returns none", async () => {
    const provider: IContextProvider = {
      id: "quiet-provider",
      kind: "feature",
      fetch: async () => ({ chunks: [], pullTools: [] }),
    };
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble({
      ...budgetPressureBaseRequest,
      providerIds: ["quiet-provider"],
    });
    const entry = bundle.manifest.providerResults?.find((pr) => pr.providerId === "quiet-provider");

    expect(entry).toBeDefined();
    expect(entry?.budgetPressure).toBeUndefined();
    // Property must be absent — not just undefined — to keep the persisted
    // manifest shape honest for legacy readers that look up `in` operator.
    expect(Object.hasOwn(entry ?? {}, "budgetPressure")).toBe(false);
  });
});

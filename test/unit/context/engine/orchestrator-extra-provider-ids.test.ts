import { beforeEach, describe, expect, test } from "bun:test";
import { ContextOrchestrator, _orchestratorDeps } from "../../../../src/context/engine/orchestrator";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "../../../../src/context/engine/types";

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

beforeEach(() => {
  _orchestratorDeps.uuid = () => "00000000-0000-4000-8000-000000000001";
  _orchestratorDeps.now = () => Date.now();
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

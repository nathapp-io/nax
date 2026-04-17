/**
 * AC-24: Determinism mode
 *
 * When ContextRequest.deterministic === true, the orchestrator skips any
 * provider that declares `deterministic: false`. Deterministic providers
 * (no field or deterministic: true) are always included.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ContextOrchestrator, _orchestratorDeps } from "../../../../src/context/engine/orchestrator";
import type { ContextRequest, IContextProvider, ContextProviderResult } from "../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let _seq = 0;
beforeEach(() => {
  _seq = 0;
  _orchestratorDeps.uuid = () => `test-uuid-${++_seq}` as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
  providerIds: ["det-provider", "non-det-provider", "implicit-det"],
};

function makeChunk(id: string): ContextProviderResult {
  return {
    chunks: [
      {
        id,
        kind: "feature",
        scope: "feature",
        role: ["implementer"],
        content: `content for ${id}`,
        tokens: 100,
        rawScore: 1.0,
      },
    ],
  };
}

function makeProvider(id: string, deterministic?: boolean): IContextProvider {
  const provider: IContextProvider = {
    id,
    kind: "feature",
    fetch: async () => makeChunk(id),
  };
  if (deterministic !== undefined) {
    (provider as IContextProvider & { deterministic: boolean }).deterministic = deterministic;
  }
  return provider;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator — determinism mode (AC-24)", () => {
  test("non-deterministic: false request does not skip any providers", async () => {
    const det = makeProvider("det-provider", true);
    const nonDet = makeProvider("non-det-provider", false);
    const orch = new ContextOrchestrator([det, nonDet]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, deterministic: false });

    const providerIds = bundle.manifest.providerResults?.map((p) => p.providerId) ?? [];
    expect(providerIds).toContain("det-provider");
    expect(providerIds).toContain("non-det-provider");
  });

  test("deterministic: true skips provider with deterministic: false", async () => {
    const det = makeProvider("det-provider", true);
    const nonDet = makeProvider("non-det-provider", false);
    const orch = new ContextOrchestrator([det, nonDet]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, deterministic: true });

    const providerIds = bundle.manifest.providerResults?.map((p) => p.providerId) ?? [];
    expect(providerIds).toContain("det-provider");
    expect(providerIds).not.toContain("non-det-provider");
  });

  test("deterministic: true keeps provider with no deterministic field (default: deterministic)", async () => {
    const implicit = makeProvider("implicit-det"); // no deterministic field
    const orch = new ContextOrchestrator([implicit]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, deterministic: true });

    const providerIds = bundle.manifest.providerResults?.map((p) => p.providerId) ?? [];
    expect(providerIds).toContain("implicit-det");
  });

  test("deterministic: true keeps provider with deterministic: true", async () => {
    const det = makeProvider("det-provider", true);
    const orch = new ContextOrchestrator([det]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, deterministic: true });

    const providerIds = bundle.manifest.providerResults?.map((p) => p.providerId) ?? [];
    expect(providerIds).toContain("det-provider");
  });

  test("deterministic: undefined (absent) does not skip non-deterministic providers", async () => {
    const nonDet = makeProvider("non-det-provider", false);
    const orch = new ContextOrchestrator([nonDet]);
    const bundle = await orch.assemble({ ...BASE_REQUEST }); // no deterministic field

    const providerIds = bundle.manifest.providerResults?.map((p) => p.providerId) ?? [];
    expect(providerIds).toContain("non-det-provider");
  });

  test("deterministic mode: included chunks come only from deterministic providers", async () => {
    const det = makeProvider("det-provider", true);
    const nonDet = makeProvider("non-det-provider", false);
    const orch = new ContextOrchestrator([det, nonDet]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, deterministic: true });

    expect(bundle.manifest.includedChunks.every((id) => id.startsWith("det-provider"))).toBe(true);
  });

  test("schema: ContextV2ConfigSchema includes deterministic field defaulting to false", async () => {
    const { ContextV2ConfigSchema } = await import("../../../../src/config/schemas");
    const parsed = ContextV2ConfigSchema.parse({});
    expect(parsed.deterministic).toBe(false);
  });

  test("schema: ContextV2ConfigSchema accepts deterministic: true", async () => {
    const { ContextV2ConfigSchema } = await import("../../../../src/config/schemas");
    const parsed = ContextV2ConfigSchema.parse({ deterministic: true });
    expect(parsed.deterministic).toBe(true);
  });
});

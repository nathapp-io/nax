/**
 * ContextOrchestrator — #508-M12 unknown providerIds validation tests
 *
 * AC-16/AC-23: When request.providerIds contains an ID that matches no
 * registered provider, the orchestrator must fail fast with a clear error.
 *
 * Kept in a separate file because orchestrator.test.ts exceeds 400 lines.
 */

import { describe, test, expect } from "bun:test";
import { ContextOrchestrator } from "../../../../src/context/engine/orchestrator";
import type { ContextRequest, IContextProvider, ContextProviderResult } from "../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 8_000,
};

function makeProvider(id: string): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async (): Promise<ContextProviderResult> => ({ chunks: [], pullTools: [] }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #508-M12: AC-16/AC-23 unknown provider ID validation
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator — #508-M12 unknown providerIds validation", () => {
  test("throws when providerIds contains an unknown ID", async () => {
    const orch = new ContextOrchestrator([makeProvider("real-provider")]);
    await expect(orch.assemble({ ...BASE_REQUEST, providerIds: ["does-not-exist"] })).rejects.toMatchObject({
      code: "CONTEXT_UNKNOWN_PROVIDER_IDS",
    });
  });

  test("succeeds when all providerIds are known", async () => {
    const orch = new ContextOrchestrator([makeProvider("real-provider")]);
    const result = await orch.assemble({ ...BASE_REQUEST, providerIds: ["real-provider"] });
    expect(result.manifest.includedChunks).toBeDefined();
  });

  test("throws when providerIds mix known and unknown IDs", async () => {
    const orch = new ContextOrchestrator([makeProvider("known-a"), makeProvider("known-b")]);
    await expect(
      orch.assemble({
        ...BASE_REQUEST,
        providerIds: ["known-a", "ghost-id", "known-b", "phantom-id"],
      }),
    ).rejects.toMatchObject({
      code: "CONTEXT_UNKNOWN_PROVIDER_IDS",
    });
  });

  test("succeeds when providerIds is empty", async () => {
    const orch = new ContextOrchestrator([makeProvider("p1")]);
    const result = await orch.assemble({ ...BASE_REQUEST, providerIds: [] });
    expect(result.manifest.includedChunks).toBeDefined();
  });
});

/**
 * ContextOrchestrator — #508-M12 unknown providerIds validation tests
 *
 * AC-16/AC-23: When request.providerIds contains an ID that matches no
 * registered provider, the orchestrator must warn and record it in
 * manifest.unknownProviderIds. Unknown IDs must not silently disappear.
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
  test("manifest.unknownProviderIds contains ID when it matches no registered provider", async () => {
    const orch = new ContextOrchestrator([makeProvider("real-provider")]);
    const result = await orch.assemble({ ...BASE_REQUEST, providerIds: ["does-not-exist"] });

    // RED: field does not exist yet.
    // GREEN: manifest records the unknown ID.
    expect(result.manifest.unknownProviderIds).toEqual(["does-not-exist"]);
  });

  test("manifest.unknownProviderIds is undefined when all providerIds are known", async () => {
    const orch = new ContextOrchestrator([makeProvider("real-provider")]);
    const result = await orch.assemble({ ...BASE_REQUEST, providerIds: ["real-provider"] });

    expect(result.manifest.unknownProviderIds).toBeUndefined();
  });

  test("manifest.unknownProviderIds lists only the unknown IDs (mix of known and unknown)", async () => {
    const orch = new ContextOrchestrator([makeProvider("known-a"), makeProvider("known-b")]);
    const result = await orch.assemble({
      ...BASE_REQUEST,
      providerIds: ["known-a", "ghost-id", "known-b", "phantom-id"],
    });

    const unknown = result.manifest.unknownProviderIds ?? [];
    expect(unknown).toContain("ghost-id");
    expect(unknown).toContain("phantom-id");
    expect(unknown).not.toContain("known-a");
    expect(unknown).not.toContain("known-b");
  });

  test("manifest.unknownProviderIds is undefined when providerIds is empty", async () => {
    const orch = new ContextOrchestrator([makeProvider("p1")]);
    const result = await orch.assemble({ ...BASE_REQUEST, providerIds: [] });

    expect(result.manifest.unknownProviderIds).toBeUndefined();
  });
});

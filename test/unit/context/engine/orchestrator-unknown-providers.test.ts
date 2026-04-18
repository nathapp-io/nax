/**
 * ContextOrchestrator — #508-M12 unknown providerIds validation tests
 *
 * AC-16: the orchestrator must fail fast when configured provider IDs (stage
 * config or, via the factory, plugin providers) reference an ID that matches
 * no registered provider. This catches operator typos such as `"static-ruls"`.
 *
 * `request.providerIds` is an intentional test-only override (see orchestrator.ts
 * comment at assemble()). Unknown IDs in the override filter silently so that
 * fixtures can use a known-superset of IDs without registering every stub.
 *
 * Kept in a separate file because orchestrator.test.ts exceeds 400 lines.
 */

import { describe, expect, test } from "bun:test";
import { ContextOrchestrator } from "../../../../src/context/engine/orchestrator";
import type {
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
} from "../../../../src/context/engine/types";

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
// #508-M12: AC-16 validation is scoped to stage-config / registered providers
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator — #508-M12 unknown providerIds validation", () => {
  test("throws when a stage references a provider ID that is not registered", async () => {
    // The default "tdd-implementer" stage references static-rules, feature-context,
    // session-scratch, git-history, and code-neighbor. Register none of them so
    // the configured stage has unknown IDs.
    const orch = new ContextOrchestrator([makeProvider("unrelated")]);
    let threw: unknown;
    try {
      await orch.assemble(BASE_REQUEST);
    } catch (e) {
      threw = e;
    }
    expect(threw).toMatchObject({ code: "CONTEXT_UNKNOWN_PROVIDER_IDS" });
  });

  test("does not throw when request.providerIds (test-only override) references unknown IDs", async () => {
    // request.providerIds is a documented test-only override and unknown IDs
    // must filter silently so fixtures can use a known superset without
    // registering every stub.
    const orch = new ContextOrchestrator([makeProvider("real-provider")]);
    const result = await orch.assemble({
      ...BASE_REQUEST,
      providerIds: ["real-provider", "does-not-exist", "phantom-id"],
    });
    expect(result.manifest.includedChunks).toBeDefined();
  });

  test("does not throw when request.providerIds override contains only unknown IDs", async () => {
    const orch = new ContextOrchestrator([makeProvider("real-provider")]);
    const result = await orch.assemble({
      ...BASE_REQUEST,
      providerIds: ["ghost-id"],
    });
    expect(result.manifest.includedChunks).toBeDefined();
  });

  test("succeeds when request.providerIds is empty", async () => {
    const orch = new ContextOrchestrator([makeProvider("p1")]);
    const result = await orch.assemble({ ...BASE_REQUEST, providerIds: [] });
    expect(result.manifest.includedChunks).toBeDefined();
  });
});

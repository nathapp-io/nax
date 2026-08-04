/**
 * US-004 AC-1, AC-2 — ContextOrchestrator.assemble() propagates provider
 * budgetPressure onto ContextManifest.providerResults[i].budgetPressure when
 * the provider returns one, and OMITS the property when the provider does
 * not (not just undefined — the property must be absent so legacy readers
 * using `in` see the distinction).
 *
 * Lives in its own file to keep `orchestrator.test.ts` under the 800-line limit.
 */

import { describe, expect, test } from "bun:test";
import { ContextOrchestrator } from "@/context";
import type { ContextRequest, IContextProvider } from "@/context/engine/types";

const BASE_REQUEST: ContextRequest = {
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
      ...BASE_REQUEST,
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
      ...BASE_REQUEST,
      providerIds: ["quiet-provider"],
    });
    const entry = bundle.manifest.providerResults?.find((pr) => pr.providerId === "quiet-provider");

    expect(entry).toBeDefined();
    expect(entry?.budgetPressure).toBeUndefined();
    // Property must be absent — not just undefined — to keep the persisted
    // manifest shape honest for legacy readers that look up `in` operator.
    expect(Object.prototype.hasOwnProperty.call(entry ?? {}, "budgetPressure")).toBe(false);
  });
});
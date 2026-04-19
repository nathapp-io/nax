import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const adapterSrc = readFileSync(join(import.meta.dir, "../../../src/agents/acp/adapter.ts"), "utf-8");

describe("AcpAgentAdapter cleanup (Phase 4 invariants)", () => {
  test("_unavailableAgents private field is removed", () => {
    expect(adapterSrc).not.toContain("_unavailableAgents");
  });

  test("resolveFallbackOrder is removed", () => {
    expect(adapterSrc).not.toContain("resolveFallbackOrder");
  });

  test("AllAgentsUnavailableError is not thrown", () => {
    expect(adapterSrc).not.toContain("AllAgentsUnavailableError");
  });

  test("hasActiveFallbacks check is removed", () => {
    expect(adapterSrc).not.toContain("hasActiveFallbacks");
  });
});

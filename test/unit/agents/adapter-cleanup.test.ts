import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

let adapterSrc: string;

beforeAll(async () => {
  adapterSrc = await Bun.file(join(import.meta.dir, "../../../src/agents/acp/adapter.ts")).text();
});

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

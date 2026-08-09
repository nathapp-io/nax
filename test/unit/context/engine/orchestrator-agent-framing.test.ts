import { beforeEach, describe, expect, test } from "bun:test";
import { ContextOrchestrator, _orchestratorDeps } from "@/context/engine";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "@/context/engine";
import { makeLogger, type MockLogger } from "@test/helpers";

const BASE_REQUEST: ContextRequest = {
  storyId: "US-002",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
  providerIds: ["p1"],
};

function makeProvider(): IContextProvider {
  const result: ContextProviderResult = {
    chunks: [{
      id: "c:1",
      kind: "feature",
      scope: "feature",
      role: ["implementer"],
      content: "feature context content",
      tokens: 200,
      rawScore: 1,
    }],
    pullTools: [],
  };
  return { id: "p1", kind: "feature", fetch: async () => result };
}

beforeEach(() => {
  _orchestratorDeps.uuid = () => "test-uuid-1" as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});

describe("US-002 — ContextOrchestrator.assemble() agent framing", () => {
  test("AC-1: codex renders context_section wrappers", async () => {
    const bundle = await new ContextOrchestrator([makeProvider()]).assemble({ ...BASE_REQUEST, agentId: "codex" });
    expect(bundle.pushMarkdown).toContain("<context_section type=");
  });

  test("AC-2: claude renders markdown section headers", async () => {
    const bundle = await new ContextOrchestrator([makeProvider()]).assemble({ ...BASE_REQUEST, agentId: "claude" });
    expect(bundle.pushMarkdown).toContain("## Feature Context");
  });

  test("AC-3: absent agent id preserves markdown section headers", async () => {
    const bundle = await new ContextOrchestrator([makeProvider()]).assemble(BASE_REQUEST);
    expect(bundle.pushMarkdown).toContain("## Feature Context");
  });

  test.each(["unknown-agent", ""])("AC-4: unregistered agent %p renders conservative bracket framing", async (agentId) => {
    const bundle = await new ContextOrchestrator([makeProvider()]).assemble({ ...BASE_REQUEST, agentId });
    expect(bundle.pushMarkdown).toContain("[Feature Context]");
  });

  test("AC-5: unknown agent emits a warning naming the agent id", async () => {
    const originalGetLogger = _orchestratorDeps.getLogger;
    const mockLogger: MockLogger = makeLogger();
    _orchestratorDeps.getLogger = () => mockLogger as unknown as ReturnType<typeof originalGetLogger>;
    try {
      await new ContextOrchestrator([]).assemble({ ...BASE_REQUEST, agentId: "unknown-agent" });
    } finally {
      _orchestratorDeps.getLogger = originalGetLogger;
    }
    const warning = mockLogger.calls.find((call) => call.level === "warn" && call.data?.agentId === "unknown-agent");
    expect(warning).toBeDefined();
  });

  test("AC-6: codex renders prior digest as prior_stage_summary", async () => {
    const bundle = await new ContextOrchestrator([]).assemble({
      ...BASE_REQUEST,
      agentId: "codex",
      priorStageDigest: "Prior stage found X.",
    });
    expect(bundle.pushMarkdown).toContain('<context_section type="prior_stage_summary">');
  });
});

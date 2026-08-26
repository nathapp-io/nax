/**
 * Pull-tool assembly — split out of orchestrator.test.ts when that file crossed
 * the 800-line test limit. Covers Phase 4 (per-stage descriptors, allowedTools
 * filtering, maxCallsPerSession precedence) and Phase 5 (review-stage tools).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import {
  _orchestratorDeps,
  ContextOrchestrator,
  PULL_TOOL_REGISTRY,
  QUERY_FEATURE_CONTEXT_DESCRIPTOR,
  QUERY_NEIGHBOR_DESCRIPTOR,
} from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";

let _reqSeq = 0;
beforeEach(() => {
  _reqSeq = 0;
  _orchestratorDeps.uuid = () => `test-uuid-${++_reqSeq}` as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: pull tools
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4: pull tools", () => {
  const TDD_IMPLEMENTER_REQUEST: ContextRequest = {
    storyId: "US-001",
    repoRoot: "/project",
    packageDir: "/project",
    stage: "tdd-implementer",
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: [],
  };

  test.each([
    ["pullConfig is absent", undefined],
    ["pullConfig.enabled is false", { enabled: false, allowedTools: [] as string[], maxCallsPerSession: 5 }],
  ])("pullTools is empty when %s", async (_label, pullConfig) => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...TDD_IMPLEMENTER_REQUEST, pullConfig });
    expect(bundle.pullTools).toEqual([]);
  });

  test("pullTools items are ToolDescriptor objects; maxCallsPerSession reflects pullConfig override", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 3 },
    });
    const tool = bundle.pullTools[0];
    assertDefined(tool, "bundle.pullTools[0]");
    expect(typeof tool.name).toBe("string");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.inputSchema).toBe("object");
    expect(typeof tool.maxCallsPerSession).toBe("number");
    expect(typeof tool.maxTokensPerCall).toBe("number");
    expect(tool.maxCallsPerSession).toBe(3);
  });

  test("a descriptor's own maxCallsPerSession survives when pullConfig is left at the schema default", async () => {
    const orch = new ContextOrchestrator([]);
    const probe = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    const firstTool = probe.pullTools[0];
    assertDefined(firstTool, "probe.pullTools[0]");
    const toolName = firstTool.name;
    const original = PULL_TOOL_REGISTRY[toolName];
    assertDefined(original, `PULL_TOOL_REGISTRY.${toolName}`);

    PULL_TOOL_REGISTRY[toolName] = { ...original, maxCallsPerSession: 9 };
    try {
      // 5 is the schema default, i.e. "operator configured nothing" — the
      // descriptor's own per-tool ceiling must win.
      const unconfigured = await orch.assemble({
        ...TDD_IMPLEMENTER_REQUEST,
        pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
      });
      expect(unconfigured.pullTools.find((t) => t.name === toolName)?.maxCallsPerSession).toBe(9);

      // An explicitly configured ceiling still overrides the descriptor.
      const configured = await orch.assemble({
        ...TDD_IMPLEMENTER_REQUEST,
        pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 2 },
      });
      expect(configured.pullTools.find((t) => t.name === toolName)?.maxCallsPerSession).toBe(2);
    } finally {
      PULL_TOOL_REGISTRY[toolName] = original;
    }
  });

  test("allowedTools filter restricts pull tools", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: ["other_tool"], maxCallsPerSession: 5 },
    });
    // query_neighbor is not in allowedTools — filtered out
    expect(bundle.pullTools).toEqual([]);
  });

  test("empty allowedTools means all stage-configured tools are allowed; tdd-implementer has query_neighbor", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools.length).toBeGreaterThan(0);
    expect(bundle.pullTools[0]?.name).toBe("query_neighbor");
  });

  test("stage with no pullToolNames returns empty pullTools even when enabled", async () => {
    const orch = new ContextOrchestrator([]);
    const verifyRequest: ContextRequest = {
      ...TDD_IMPLEMENTER_REQUEST,
      stage: "verify",
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    };
    const bundle = await orch.assemble(verifyRequest);
    expect(bundle.pullTools).toEqual([]);
  });

  test("rebuildForAgent preserves pullTools from original bundle", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(original.pullTools).toHaveLength(1);

    const rebuilt = orch.rebuildForAgent(original);
    expect(rebuilt.pullTools).toEqual(original.pullTools);
    expect(rebuilt.pullTools[0]?.name).toBe(QUERY_NEIGHBOR_DESCRIPTOR.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: review stage pull tools
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 5: review stage pull tools", () => {
  const REVIEW_REQUEST: ContextRequest = {
    storyId: "US-001",
    repoRoot: "/project",
    packageDir: "/project",
    stage: "review-semantic",
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: [],
  };

  test.each(["review-semantic", "review-adversarial"] as const)(
    "%s with pullConfig enabled returns query_feature_context",
    async (stage) => {
      const orch = new ContextOrchestrator([]);
      const bundle = await orch.assemble({
        ...REVIEW_REQUEST,
        stage,
        pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
      });
      expect(bundle.pullTools).toHaveLength(1);
      expect(bundle.pullTools[0]?.name).toBe(QUERY_FEATURE_CONTEXT_DESCRIPTOR.name);
    },
  );

  test("review-semantic pullConfig disabled returns empty pull tools", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...REVIEW_REQUEST,
      pullConfig: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools).toEqual([]);
  });

  test("pull tool names do not bleed across stages: tdd-implementer lacks query_feature_context, review-semantic lacks query_neighbor", async () => {
    const orchA = new ContextOrchestrator([]);
    const bundleA = await orchA.assemble({
      storyId: "US-001",
      repoRoot: "/project",
      packageDir: "/project",
      stage: "tdd-implementer",
      role: "implementer",
      budgetTokens: 8_000,
      providerIds: [],
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundleA.pullTools.map((t) => t.name)).not.toContain("query_feature_context");
    const orchB = new ContextOrchestrator([]);
    const bundleB = await orchB.assemble({
      ...REVIEW_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundleB.pullTools.map((t) => t.name)).not.toContain("query_neighbor");
  });
});

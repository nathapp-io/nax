/**
 * ContextOrchestrator.rebuildForAgent() — Phase 5.5 unit tests
 *
 * Covers the agent-swap overload: RebuildOptions with newAgentId + failure,
 * failure-note chunk injection, manifest.rebuildInfo population, agentId
 * threading, and rendering style dispatch (markdown-sections vs xml-tagged).
 *
 * Kept in a separate file from orchestrator.test.ts to stay within the
 * 400-line file limit; split is by describe block concern.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TEST_ROUTING,
  makeContextBundle,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTestContext,
} from "@test/helpers";
import { SIMILARITY_THRESHOLD } from "@/context/engine/dedupe";
import { _orchestratorDeps, ContextOrchestrator } from "@/context/engine/orchestrator";
import { _stageAssemblerDeps, assembleForStage } from "@/context/engine/stage-assembler";
import { getStageContextConfig } from "@/context/engine/stage-config";
import type {
  AdapterFailure,
  ContextBundle,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
} from "@/context/engine/types";
import type { RoutingResult } from "@/pipeline/types";

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
  providerIds: [],
};

function makeProvider(id: string, result: ContextProviderResult): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async () => result,
  };
}

function makeChunkResult(id = "chunk:abc"): ContextProviderResult {
  return {
    chunks: [
      {
        id,
        kind: "feature",
        scope: "project",
        role: ["all"],
        content: "Feature rule: use async/await.",
        tokens: 20,
        rawScore: 0.8,
      },
    ],
  };
}

const AVAILABILITY_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "daily token quota exhausted",
  retriable: false,
};

const QUALITY_FAILURE: AdapterFailure = {
  category: "quality",
  outcome: "fail-quality",
  message: "review rejected output",
  retriable: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Agent-swap rebuild — failure note injection
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — failure note injection", () => {
  test("failure note chunk is included in pushMarkdown on agent swap", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.pushMarkdown).toContain("Agent swap");
    expect(rebuilt.pushMarkdown).toContain("fail-quota");
  });

  test("rebuild recomputes chunkTokens so the injected failure note is not counted as 0 (#1421)", async () => {
    // The rebuild adds a synthetic failure-note chunk. Inheriting the prior
    // manifest's chunkTokens would leave that chunk with no entry, and the
    // curator would record tokens:0 for it — the placeholder #1421 removed.
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(
      { ...original, agentId: "claude" },
      { newAgentId: "codex", failure: AVAILABILITY_FAILURE },
    );

    const tokenMap = rebuilt.manifest.chunkTokens ?? {};
    expect(Object.keys(tokenMap).sort()).toEqual([...rebuilt.manifest.includedChunks].sort());
    for (const id of rebuilt.manifest.includedChunks) {
      expect(tokenMap[id]).toBeGreaterThan(0);
    }
  });

  test("failure note includes prior and new agent id", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const rebuilt = orch.rebuildForAgent(
      { ...original, agentId: "claude" },
      { newAgentId: "codex", failure: AVAILABILITY_FAILURE },
    );
    expect(rebuilt.pushMarkdown).toContain("claude");
    expect(rebuilt.pushMarkdown).toContain("codex");
  });

  test("no failure note when failure absent or no newAgentId; no rebuildInfo in both cases", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);

    // Plain re-render (no failure)
    const rebuilt1 = orch.rebuildForAgent(original);
    expect(rebuilt1.pushMarkdown).not.toContain("Agent swap");

    // Failure but no newAgentId — guard requires both fields
    const orch2 = new ContextOrchestrator([]);
    const original2 = await orch2.assemble(BASE_REQUEST);
    const rebuilt2 = orch2.rebuildForAgent(original2, { failure: AVAILABILITY_FAILURE });
    expect(rebuilt2.pushMarkdown).not.toContain("Agent swap");
    expect(rebuilt2.manifest.rebuildInfo).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-swap rebuild — manifest.rebuildInfo
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — manifest.rebuildInfo", () => {
  test("rebuildInfo is set on agent-swap rebuild", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.rebuildInfo).toBeDefined();
    expect(rebuilt.manifest.rebuildInfo?.priorAgentId).toBe("claude");
    expect(rebuilt.manifest.rebuildInfo?.newAgentId).toBe("codex");
    expect(rebuilt.manifest.rebuildInfo?.failureCategory).toBe("availability");
    expect(rebuilt.manifest.rebuildInfo?.failureOutcome).toBe("fail-quota");
  });

  test("rebuildInfo is undefined when no failure is provided", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original);

    expect(rebuilt.manifest.rebuildInfo).toBeUndefined();
  });

  test("rebuildInfo records quality failure outcome", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: QUALITY_FAILURE,
    });

    expect(rebuilt.manifest.rebuildInfo?.failureCategory).toBe("quality");
    expect(rebuilt.manifest.rebuildInfo?.failureOutcome).toBe("fail-quality");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-swap rebuild — agentId on returned bundle
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — agentId on bundle", () => {
  test("bundle.agentId reflects the new agent on swap", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.agentId).toBe("codex");
  });

  test("bundle.agentId defaults to claude when no prior; uses prior.agentId when set", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    expect(orch.rebuildForAgent(original).agentId).toBe("claude");
    expect(orch.rebuildForAgent({ ...original, agentId: "codex" }).agentId).toBe("codex");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-swap rebuild — rendering style dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — rendering style dispatch", () => {
  test("codex swap produces xml-tagged push markdown", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.pushMarkdown).toContain("<context_section");
  });

  test("no-swap re-render produces markdown-sections push markdown for claude bundle", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    const priorBundle = { ...original, agentId: "claude" };

    // No newAgentId — keeps current renderChunks (markdown-sections by default)
    const rebuilt = orch.rebuildForAgent(priorBundle);

    expect(rebuilt.pushMarkdown).toContain("##");
    expect(rebuilt.pushMarkdown).not.toContain("<context_section");
  });

  test("priorStageDigest from RebuildOptions appears in rebuilt pushMarkdown", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
      priorStageDigest: "Plan completed: touched src/review/semantic.ts.",
    });

    expect(rebuilt.pushMarkdown).toContain("Plan completed:");
  });

  test("original chunks are preserved on swap (no provider re-fetch)", async () => {
    let fetchCount = 0;
    const provider: IContextProvider = {
      id: "p1",
      kind: "feature",
      fetch: async () => {
        fetchCount++;
        return makeChunkResult();
      },
    };
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    expect(fetchCount).toBe(1);

    orch.rebuildForAgent(original, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });
    expect(fetchCount).toBe(1); // no additional fetch
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M2: AC-42 re-neutralize session-scratch chunks on agent-swap rebuild
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — #508-M2 session-chunk re-neutralization on swap", () => {
  function makeSessionBundle(sessionContent: string, priorAgentId = "claude"): ContextBundle {
    return {
      pushMarkdown: "",
      pullTools: [],
      digest: "",
      agentId: priorAgentId,
      chunks: [
        {
          id: "session-scratch:abc123",
          providerId: "session-scratch",
          kind: "session" as const,
          scope: "session" as const,
          role: ["all"],
          content: sessionContent,
          tokens: 20,
          score: 0.9,
        },
      ],
      manifest: {
        requestId: "req-prior",
        stage: "tdd-implementer",
        totalBudgetTokens: 8_000,
        usedTokens: 100,
        includedChunks: ["session-scratch:abc123"],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 10,
        buildMs: 5,
      },
    };
  }

  test("session chunk content is re-neutralized when swapping from claude to codex", () => {
    const orch = new ContextOrchestrator([]);
    const prior = makeSessionBundle("I used the Read tool to inspect and the Bash tool to run tests.");
    const rebuilt = orch.rebuildForAgent(prior, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });
    expect(rebuilt.pushMarkdown).not.toContain("the Read tool");
    expect(rebuilt.pushMarkdown).not.toContain("the Bash tool");
    expect(rebuilt.pushMarkdown).toContain("a file read");
    expect(rebuilt.pushMarkdown).toContain("a shell command");
  });

  test("no re-neutralization on same-agent rebuild, non-session chunks, or plain re-render", () => {
    const orch = new ContextOrchestrator([]);
    const prior = makeSessionBundle("I used the Read tool to inspect.", "claude");

    // Same-agent rebuild
    expect(orch.rebuildForAgent(prior, { newAgentId: "claude", failure: AVAILABILITY_FAILURE }).pushMarkdown).toContain(
      "the Read tool",
    );
    // Plain re-render (no newAgentId)
    expect(orch.rebuildForAgent(prior).pushMarkdown).toContain("the Read tool");

    // Non-session (feature) chunks not altered
    const featurePrior: ContextBundle = {
      pushMarkdown: "",
      pullTools: [],
      digest: "",
      agentId: "claude",
      chunks: [
        {
          id: "feature:abc",
          providerId: "feature-context",
          kind: "feature" as const,
          scope: "feature" as const,
          role: ["all"],
          content: "Feature: use the Read tool pattern.",
          tokens: 10,
          score: 0.8,
        },
      ],
      manifest: {
        requestId: "req-x",
        stage: "tdd-implementer",
        totalBudgetTokens: 8_000,
        usedTokens: 50,
        includedChunks: ["feature:abc"],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 5,
        buildMs: 1,
      },
    };
    expect(
      orch.rebuildForAgent(featurePrior, { newAgentId: "codex", failure: AVAILABILITY_FAILURE }).pushMarkdown,
    ).toContain("the Read tool");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M5: AC-39 rebuildInfo chunk ID correlation
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — #508-M5 rebuildInfo chunk ID correlation", () => {
  test("rebuildInfo chunk IDs: priorChunkIds, newChunkIds, chunkIdMap on agent-swap; undefined on plain re-render", async () => {
    const provider = makeProvider("p1", makeChunkResult("chunk:abc"));
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    const priorBundle = { ...original, agentId: "claude" };
    const rebuilt = orch.rebuildForAgent(priorBundle, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });

    expect(rebuilt.manifest.rebuildInfo?.priorChunkIds).toEqual(["chunk:abc"]);

    const newIds = rebuilt.manifest.rebuildInfo?.newChunkIds ?? [];
    expect(newIds).toContain("chunk:abc");
    expect(newIds.length).toBeGreaterThan(1);

    expect(rebuilt.manifest.rebuildInfo?.chunkIdMap).toEqual([
      { priorChunkId: "chunk:abc", newChunkId: "chunk:abc" },
      { priorChunkId: "failure-note:claude:codex:fail-quota", newChunkId: "failure-note:claude:codex:fail-quota" },
    ]);

    // Plain re-render (no failure) → undefined
    const orch2 = new ContextOrchestrator([]);
    const original2 = await orch2.assemble(BASE_REQUEST);
    expect(orch2.rebuildForAgent(original2).manifest.rebuildInfo).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextOrchestrator.assemble — US-001 stale attribution through the dedupe path
//
// Covers AC7 of "Attribute staleness on excluded chunks":
//   AC7  Given two providers whose chunk content has trigram Jaccard similarity
//        at or above SIMILARITY_THRESHOLD (src/context/engine/dedupe.ts:21, 0.9
//        — identical content satisfies it), and applyStaleness marks the
//        lower-scoring chunk staleCandidate true with a scoreMultiplier below
//        1, when assembly dedupes the chunks, then the manifest excludedChunks
//        entry for the dropped chunk has stale true and reason "dedupe".
// ─────────────────────────────────────────────────────────────────────────────

const staleBaseRequest: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 8_000,
  providerIds: ["p1", "p2"],
};

function staleMakeProvider(id: string, result: ContextProviderResult): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async () => result,
  };
}

/**
 * Two near-duplicate chunks sharing identical content (trigram Jaccard = 1.0
 * ≥ SIMILARITY_THRESHOLD). The lower-scoring chunk is marked staleCandidate
 * with a scoreMultiplier below 1 — applyStaleness()'s effect on the scoring
 * pass reduces its score further, so the higher-scoring non-stale chunk is
 * the dedupe representative and the stale one is dropped.
 */
function makeNearDuplicateResults(): ContextProviderResult[] {
  // Identical content → Jaccard similarity = 1.0 ≥ threshold.
  const sharedContent = "Always use the lint check before merging a pull request.";
  return [
    {
      chunks: [
        {
          id: "chunk-higher",
          providerId: "p1",
          kind: "feature",
          scope: "project",
          role: ["all"],
          content: sharedContent,
          tokens: 100,
          rawScore: 0.9,
        },
      ],
    },
    {
      chunks: [
        {
          id: "chunk-lower-stale",
          providerId: "p2",
          kind: "feature",
          scope: "project",
          role: ["all"],
          content: sharedContent,
          tokens: 100,
          rawScore: 0.8,
          staleCandidate: true,
          scoreMultiplier: 0.5,
        },
      ],
    },
  ];
}

function findExcluded(
  manifest: { excludedChunks: Array<{ id: string; reason: string; stale?: boolean }> },
  id: string,
) {
  const entry = manifest.excludedChunks.find((c) => c.id === id);
  if (!entry) throw new Error(`Expected excludedChunks to contain id="${id}"`);
  return entry;
}

describe("ContextOrchestrator — stale attribution through dedupe (AC7)", () => {
  test("AC7: identical-content chunks (Jaccard >= SIMILARITY_THRESHOLD) → dropped stale chunk has stale: true, reason: 'dedupe'", async () => {
    const [r1, r2] = makeNearDuplicateResults();
    const orch = new ContextOrchestrator([staleMakeProvider("p1", r1), staleMakeProvider("p2", r2)]);

    const bundle = await orch.assemble(staleBaseRequest);

    // Sanity: the threshold used in dedupe.ts is 0.9 — we pass with 1.0.
    expect(SIMILARITY_THRESHOLD).toBe(0.9);

    // Sanity: the stale chunk must have actually been dropped from
    // includedChunks and surfaced as excluded.
    expect(bundle.manifest.includedChunks).not.toContain("chunk-lower-stale");
    expect(bundle.manifest.excludedChunks.map((c) => c.id)).toContain("chunk-lower-stale");

    const entry = findExcluded(bundle.manifest, "chunk-lower-stale");
    expect(entry.reason).toBe("dedupe");
    expect(entry.stale).toBe(true);
    expect(bundle.manifest.chunkProviders?.["chunk-lower-stale"]).toBe("p2");
  });

  test("AC7 (mechanical reason preserved): the dropped stale chunk keeps reason 'dedupe' rather than being re-labeled 'stale'", async () => {
    // The story's contract: the stale flag is additive, never replaces the
    // mechanical cause. reason='stale' is no longer a member of the union;
    // a stale chunk whose drop cause is dedupe must record reason='dedupe'.
    const [r1, r2] = makeNearDuplicateResults();
    const orch = new ContextOrchestrator([staleMakeProvider("p1", r1), staleMakeProvider("p2", r2)]);

    const bundle = await orch.assemble(staleBaseRequest);

    for (const entry of bundle.manifest.excludedChunks) {
      expect(entry.reason).not.toBe("stale");
    }
    expect(findExcluded(bundle.manifest, "chunk-lower-stale").reason).toBe("dedupe");
  });

  test("AC7 (kept representative unchanged): the higher-scoring non-stale chunk survives dedupe and is not in excludedChunks", async () => {
    // Boundary: the non-stale representative is included, not excluded —
    // it does NOT get a stale stamp on a phantom excludedChunks entry.
    const [r1, r2] = makeNearDuplicateResults();
    const orch = new ContextOrchestrator([staleMakeProvider("p1", r1), staleMakeProvider("p2", r2)]);

    const bundle = await orch.assemble(staleBaseRequest);

    expect(bundle.manifest.includedChunks).toContain("chunk-higher");
    expect(bundle.manifest.excludedChunks.map((c) => c.id)).not.toContain("chunk-higher");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Amendment B AC-51: planDigestBoost
//
// For stages single-session, tdd-simple, no-test, and batch the plan digest
// is injected as a scored RawChunk (id: "plan-digest:<hash>") with a boosted
// rawScore. For all other stages the priorStageDigest remains raw markdown only.
// ─────────────────────────────────────────────────────────────────────────────

let _seq = 0;
beforeEach(() => {
  _seq = 0;
  _orchestratorDeps.uuid = () => `test-uuid-${++_seq}` as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});

const PLAN_DIGEST = "Plan summary: touch auth.ts, use _deps pattern, tests in test/unit/auth.";

const boostBaseRequest: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "single-session",
  role: "implementer",
  budgetTokens: 10_000,
  providerIds: [],
  priorStageDigest: PLAN_DIGEST,
};

describe("StageContextConfig.planDigestBoost", () => {
  // Only tdd-simple and no-test are TestStrategy values — the only two keys
  // getStageContextConfig(ctx.routing.testStrategy) can ever select for the
  // boost (nax#1759). single-session and batch used to also declare 1.5 here,
  // but neither is a TestStrategy value, so neither field was ever read —
  // dead configuration, removed.
  test.each(["tdd-simple", "no-test"])("%s has planDigestBoost >= 1.5", (stage) => {
    const cfg = getStageContextConfig(stage);
    expect(cfg.planDigestBoost).toBeGreaterThanOrEqual(1.5);
  });

  test.each(["single-session", "batch", "verify", "review-semantic", "plan", "tdd-test-writer", "tdd-implementer"])(
    "%s has planDigestBoost absent or <= 1",
    (stage) => {
      const cfg = getStageContextConfig(stage);
      expect(cfg.planDigestBoost ?? 1.0).toBeLessThanOrEqual(1.0);
    },
  );
});

/** Minimal PipelineContext for assembleForStage, mirroring stage-assembler.test.ts's makeCtx. */
function makeAssembleCtx(testStrategy: RoutingResult["testStrategy"]) {
  const config = makeNaxConfig({ context: { v2: { enabled: true, pluginProviders: [] } } });
  const story = makeStory({ id: "US-001" });
  return makeTestContext({
    config,
    rootConfig: config,
    prd: makePRD({ feature: "test-feature", userStories: [] }),
    story,
    stories: [],
    routing: { ...DEFAULT_TEST_ROUTING, agent: undefined, testStrategy },
    projectDir: undefined, // suppresses manifest writes in tests
    workdir: "/repo",
    hooks: { hooks: {} },
  });
}

/**
 * Mock orchestrator that captures the last assemble() request via a mutable
 * ref. Built as a real `ContextOrchestrator` instance with `assemble`
 * monkey-patched — `_stageAssemblerDeps.createOrchestrator` returns
 * `ContextOrchestrator`, and a genuine instance satisfies that return type
 * with no cast needed (unlike a structurally-mocked object literal).
 */
function makeMockOrchestrator() {
  const ref: { captured: ContextRequest | null } = { captured: null };
  const orchestrator = new ContextOrchestrator([]);
  orchestrator.assemble = async (r: ContextRequest): Promise<ContextBundle> => {
    ref.captured = r;
    return makeContextBundle({
      digest: "abc",
      manifest: {
        requestId: "req-1",
        stage: "single-session",
        totalBudgetTokens: 0,
        usedTokens: 0,
        includedChunks: [],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 0,
        buildMs: 0,
      },
    });
  };
  return { ref, orchestrator };
}

describe("assembleForStage — planDigestBoost is resolved from testStrategy, not the assembled stage (nax#1759)", () => {
  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = origReaddir;
    _stageAssemblerDeps.readDescriptor = origReadDescriptor;
    _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
  });

  test("a tdd-simple story gets planDigestBoost=1.5 whether assembling 'single-session' or 'tdd-implementer'", async () => {
    const execMock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => execMock.orchestrator;
    await assembleForStage(makeAssembleCtx("tdd-simple"), "single-session");
    expect(execMock.ref.captured?.planDigestBoost).toBe(1.5);

    const tddMock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => tddMock.orchestrator;
    await assembleForStage(makeAssembleCtx("tdd-simple"), "tdd-implementer");
    expect(tddMock.ref.captured?.planDigestBoost).toBe(1.5);
  });

  test("a test-after story gets no planDigestBoost, even assembling 'single-session' (the stage it maps to)", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => mock.orchestrator;

    // test-after is resolveTestStrategy's fallback and a single-session mode,
    // and executionContextStage maps it to the "single-session" stage — whose
    // own entry no longer declares a boost. It has no STAGE_CONTEXT_MAP entry
    // of its own, so the strategy-keyed lookup finds nothing: a known gap
    // (ADR-010 Amendment B, nax#1759).
    await assembleForStage(makeAssembleCtx("test-after"), "single-session");

    expect(mock.ref.captured?.planDigestBoost).toBeUndefined();
  });
});

describe("ContextOrchestrator — planDigestBoost (Amendment B AC-51)", () => {
  test("plan-digest chunk is injected into includedChunks when planDigestBoost > 1", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...boostBaseRequest, planDigestBoost: 1.5 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeDefined();
  });

  test("plan-digest chunk appears in bundle.chunks when boosted", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...boostBaseRequest, planDigestBoost: 1.5 });
    const chunk = bundle.chunks.find((c) => c.id.startsWith("plan-digest:"));
    expect(chunk).toBeDefined();
    expect(chunk?.content).toBe(PLAN_DIGEST);
  });

  test("plan-digest chunk is NOT injected when planDigestBoost absent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...boostBaseRequest }); // no planDigestBoost
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("plan-digest chunk is NOT injected when planDigestBoost <= 1", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...boostBaseRequest, planDigestBoost: 1.0 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("plan-digest chunk is NOT injected when priorStageDigest is absent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...boostBaseRequest, priorStageDigest: undefined, planDigestBoost: 1.5 });
    const planChunk = bundle.manifest.includedChunks.find((id) => id.startsWith("plan-digest:"));
    expect(planChunk).toBeUndefined();
  });

  test("boosted plan-digest chunk has higher rawScore than session-scratch chunks (0.9)", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...boostBaseRequest, planDigestBoost: 1.5 });
    const chunk = bundle.chunks.find((c) => c.id.startsWith("plan-digest:"));
    // rawScore should be 0.9 * 1.5 = 1.35, exceeding normal session rawScore of 0.9
    expect(chunk?.rawScore).toBeGreaterThan(0.9);
  });

  test("plan-digest chunk appears in providerResults with providerId 'plan-digest'", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...boostBaseRequest, planDigestBoost: 1.5 });
    const pr = bundle.manifest.providerResults?.find((p) => p.providerId === "plan-digest");
    expect(pr).toBeDefined();
    expect(pr?.status).toBe("ok");
  });

  test("pushMarkdown contains plan digest content when boosted", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...boostBaseRequest, planDigestBoost: 1.5 });
    expect(bundle.pushMarkdown).toContain(PLAN_DIGEST);
  });
});

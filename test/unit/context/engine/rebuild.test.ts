/**
 * US-001 + US-003 — Extract agent-rebuild + repack to target ceiling
 *
 * Acceptance criteria (US-001):
 *   AC1  Given a prior bundle and empty options, when the exported rebuild
 *        function from `src/context/engine/rebuild.ts` is called, then its
 *        `pushMarkdown` equals the prior bundle's rendering.
 *   AC2  When `_orchestratorDeps` is imported from
 *        `src/context/engine/orchestrator.ts`, then it exposes the extracted
 *        rebuild function as a replaceable property.
 *   AC3  Given `_orchestratorDeps`' rebuild property is replaced with a stub
 *        that returns a sentinel bundle, when `ContextEngine.rebuildForAgent`
 *        is called, then it returns that sentinel bundle unchanged.
 *   AC4  Given `_orchestratorDeps`' rebuild property is replaced with a stub,
 *        when `ContextEngine.rebuildForAgent` is called, then the stub is
 *        invoked exactly once with the received prior bundle and options object.
 *   AC5  Given `newAgentId: "codex"` and a failure, when
 *        `ContextEngine.rebuildForAgent` is called, then
 *        `manifest.rebuildInfo.newAgentId` equals `"codex"`.
 *   AC6  Given `newAgentId` is absent from `AGENT_PROFILES`, when
 *        `ContextEngine.rebuildForAgent` is called, then the returned bundle's
 *        `agentId` equals that ID and a warn-level log is emitted.
 *
 * Acceptance criteria (US-003):
 *   AC1  Over-budget non-floor → usedTokens ≤ effectiveBudget
 *   AC2  Over-budget non-floor → excluded non-floor chunks omitted
 *   AC3  Under-budget → all chunk IDs retained
 *   AC4  Floor exceeds budget → all floor chunks retained
 *   AC5  Floor exceeds budget → floorOverageItems from pack result
 *   AC6  Missing effectiveBudget → equals target preferredPromptTokens
 *   AC7  Failure + small ceiling → failure-note chunk present
 *   AC8  Idempotent rebuild → same usedTokens
 *   AC9  Under-budget → prior chunk order preserved
 *   AC10 Failure + all fit → chunkIdMap pairs every prior chunk ID with itself
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ContextOrchestrator,
  _orchestratorDeps,
  rebuild,
  type AdapterFailure,
  type ContextBundle,
  type ContextChunk,
  type ContextManifest,
  type ContextProviderResult,
  type ContextRequest,
  type IContextProvider,
  type RebuildOptions,
} from "@/context/engine";
const FLOOR_KIND_VALUES: string[] = ["static", "feature", "test-coverage"];
import { makeLogger, type MockLogger } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 8_000,
  providerIds: ["p1"],
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

async function makePriorBundle(): Promise<ContextBundle> {
  const orch = new ContextOrchestrator([makeProvider("p1", makeChunkResult())]);
  const bundle = await orch.assemble(BASE_REQUEST);
  return { ...bundle, agentId: "claude" };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — rebuild(prior, {}) preserves pushMarkdown for plain re-render
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — rebuild() AC1: pushMarkdown equals prior on plain re-render", () => {
  test("rebuild(prior, {}) produces pushMarkdown equal to prior.pushMarkdown", async () => {
    const prior = await makePriorBundle();

    const result = rebuild(prior, {});

    expect(result.pushMarkdown).toBe(prior.pushMarkdown);
  });

  test("rebuild returns a bundle object with pushMarkdown, pullTools, digest, manifest, chunks, agentId", async () => {
    const prior = await makePriorBundle();

    const result = rebuild(prior, {});

    expect(typeof result.pushMarkdown).toBe("string");
    expect(Array.isArray(result.pullTools)).toBe(true);
    expect(typeof result.digest).toBe("string");
    expect(result.manifest).toBeDefined();
    expect(Array.isArray(result.chunks)).toBe(true);
    expect(typeof result.agentId).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — _orchestratorDeps.rebuild is the extracted function and is replaceable
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — _orchestratorDeps AC2: rebuild property is exposed and replaceable", () => {
  test("_orchestratorDeps.rebuild exists as a function", () => {
    expect(typeof _orchestratorDeps.rebuild).toBe("function");
  });

  test("_orchestratorDeps.rebuild references the same exported rebuild function", () => {
    expect(_orchestratorDeps.rebuild).toBe(rebuild);
  });

  test("_orchestratorDeps.rebuild is a writable property that can be replaced", () => {
    const descriptor = Object.getOwnPropertyDescriptor(_orchestratorDeps, "rebuild");
    expect(descriptor).not.toBeNull();
    expect(descriptor?.writable).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 + AC4 — _orchestratorDeps.rebuild delegation seam
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — _orchestratorDeps.rebuild delegation seam", () => {
  let origRebuild: typeof _orchestratorDeps.rebuild;

  beforeEach(() => {
    origRebuild = _orchestratorDeps.rebuild;
  });

  afterEach(() => {
    _orchestratorDeps.rebuild = origRebuild;
  });

  test("AC3 — wrapper returns the sentinel bundle unchanged when rebuild is stubbed", async () => {
    const prior = await makePriorBundle();
    const sentinel: ContextBundle = {
      pushMarkdown: "SENTINEL_MARKER_pushMarkdown",
      pullTools: [],
      digest: "SENTINEL_MARKER_digest",
      manifest: { ...prior.manifest, requestId: "sentinel-request-id" },
      chunks: [],
      agentId: "sentinel-agent",
    };

    const stub = (() => sentinel) as typeof _orchestratorDeps.rebuild;
    _orchestratorDeps.rebuild = stub;

    const orch = new ContextOrchestrator([]);
    const result = orch.rebuildForAgent(prior, {});

    expect(result).toBe(sentinel);
    expect(result.pushMarkdown).toBe("SENTINEL_MARKER_pushMarkdown");
    expect(result.agentId).toBe("sentinel-agent");
  });

  test("AC4 — stub is invoked exactly once with the received prior and options", async () => {
    const prior = await makePriorBundle();
    const options: RebuildOptions = {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
      priorStageDigest: "Stage digest text",
      storyId: "US-001",
    };

    let callCount = 0;
    let receivedPrior: ContextBundle | undefined;
    let receivedOptions: RebuildOptions | undefined;

    const stub = ((p: ContextBundle, o: RebuildOptions = {}): ContextBundle => {
      callCount++;
      receivedPrior = p;
      receivedOptions = o;
      return { ...p, pushMarkdown: "STUB_OUTPUT" };
    }) as typeof _orchestratorDeps.rebuild;
    _orchestratorDeps.rebuild = stub;

    const orch = new ContextOrchestrator([]);
    orch.rebuildForAgent(prior, options);

    expect(callCount).toBe(1);
    expect(receivedPrior).toBe(prior);
    expect(receivedOptions).toEqual(options);
  });

  test("AC4 — stub is invoked exactly once even when options is omitted", async () => {
    const prior = await makePriorBundle();

    let callCount = 0;
    let receivedPrior: ContextBundle | undefined;
    let receivedOptions: RebuildOptions | undefined;

    const stub = ((p: ContextBundle, o: RebuildOptions = {}): ContextBundle => {
      callCount++;
      receivedPrior = p;
      receivedOptions = o;
      return { ...p, pushMarkdown: "STUB_OUTPUT" };
    }) as typeof _orchestratorDeps.rebuild;
    _orchestratorDeps.rebuild = stub;

    const orch = new ContextOrchestrator([]);
    orch.rebuildForAgent(prior);

    expect(callCount).toBe(1);
    expect(receivedPrior).toBe(prior);
    expect(receivedOptions).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — manifest.rebuildInfo.newAgentId === "codex" on agent-swap rebuild
//       (also covered by orchestrator-rebuild.test.ts; mirrored here for the
//        extracted function so the AC is anchored to rebuild.ts too.)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — rebuild() AC5: rebuildInfo.newAgentId is the target agent on swap", () => {
  test("rebuild(prior, { newAgentId: 'codex', failure }) sets manifest.rebuildInfo.newAgentId to 'codex'", async () => {
    const prior = await makePriorBundle();

    const result = rebuild(prior, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(result.manifest.rebuildInfo?.newAgentId).toBe("codex");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — unknown agent id produces agentId on bundle AND warn-level log
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — rebuild() AC6: unknown agent id sets bundle.agentId AND emits warn", () => {
  let origGetLogger: typeof _orchestratorDeps.getLogger;
  let mockLogger: MockLogger;

  beforeEach(() => {
    origGetLogger = _orchestratorDeps.getLogger;
    mockLogger = makeLogger();
    _orchestratorDeps.getLogger = () =>
      mockLogger as unknown as ReturnType<typeof _orchestratorDeps.getLogger>;
  });

  afterEach(() => {
    _orchestratorDeps.getLogger = origGetLogger;
  });

  test("unknown agent id returns a bundle whose agentId equals that id", async () => {
    const prior = await makePriorBundle();

    const result = rebuild(prior, {
      newAgentId: "totally-fictional-agent",
      failure: AVAILABILITY_FAILURE,
    });

    expect(result.agentId).toBe("totally-fictional-agent");
  });

  test("unknown agent id emits a warn-level log when called via the orchestrator wrapper", async () => {
    const prior = await makePriorBundle();

    const orch = new ContextOrchestrator([]);
    orch.rebuildForAgent(prior, {
      newAgentId: "totally-fictional-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const warnCalls = mockLogger.calls.filter((c) => c.level === "warn");
    const unknownAgentWarn = warnCalls.find((c) => /unknown agent/i.test(c.message));
    expect(unknownAgentWarn).toBeDefined();
    expect(unknownAgentWarn!.stage).toBe("context-v2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — Repack rebuilt bundles to the target ceiling
// ─────────────────────────────────────────────────────────────────────────────

// Helper ContextChunk types omit optional fields for brevity
type TestChunk = Pick<ContextChunk, "id" | "providerId" | "kind" | "scope" | "role" | "content" | "tokens" | "score">;

function makeTestChunk(overrides: Partial<TestChunk> & { id: string }): ContextChunk {
  return {
    providerId: "tp",
    kind: "session",
    scope: "session",
    role: ["all"],
    content: `Content for ${overrides.id}`,
    tokens: 100,
    score: 0.8,
    ...overrides,
  } as ContextChunk;
}

function makeTestBundle(chunks: ContextChunk[], overrides: Partial<ContextBundle> = {}): ContextBundle {
  const usedTokens = chunks.reduce((s, c) => s + c.tokens, 0);
  const floorIds = chunks.filter((c) => FLOOR_KIND_VALUES.includes(c.kind)).map((c) => c.id);
  return {
    pushMarkdown: "# Test\n\nContent",
    pullTools: [],
    digest: "abc123",
    manifest: {
      requestId: "req-test",
      stage: "tdd-implementer",
      totalBudgetTokens: 16_000,
      effectiveBudget: 16_000,
      usedTokens,
      includedChunks: chunks.map((c) => c.id),
      excludedChunks: [],
      floorItems: floorIds,
      digestTokens: 0,
      buildMs: 0,
      ...overrides.manifest,
    },
    chunks,
    agentId: "claude",
    ...overrides,
  };
}

describe("US-003 — repack to target ceiling", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // AC1 + AC2: Over-budget non-floor chunks
  // ───────────────────────────────────────────────────────────────────────────

  test("AC1: usedTokens ≤ effectiveBudget when non-floor chunks exceed ceiling", () => {
    // non-floor chunks total 1000+1000+9000=11000 tokens
    // target agent "local" has preferredPromptTokens=8000
    // effectiveBudget = min(16000, 8000) = 8000
    const prior = makeTestBundle(
      [
        makeTestChunk({ id: "s1", kind: "session", tokens: 1000, score: 0.9 }),
        makeTestChunk({ id: "s2", kind: "session", tokens: 1000, score: 0.8 }),
        makeTestChunk({ id: "s3", kind: "session", tokens: 9000, score: 0.7 }),
      ],
      { agentId: "local" },
    );

    const result = rebuild(prior, {});

    expect(result.manifest.usedTokens).toBeLessThanOrEqual(result.manifest.effectiveBudget!);
  });

  test("AC2: over-budget rebuild omits excluded non-floor chunks", () => {
    const prior = makeTestBundle(
      [
        makeTestChunk({ id: "dense-1", kind: "session", tokens: 100, score: 0.9 }),
        makeTestChunk({ id: "bulky", kind: "history", tokens: 8500, score: 0.5 }),
      ],
      { agentId: "local" },
    );

    const result = rebuild(prior, {});

    const chunkIds = result.chunks.map((c) => c.id);
    expect(chunkIds).toContain("dense-1");
    expect(chunkIds).not.toContain("bulky");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC3 + AC9: Under-budget — all retain + order preserved
  // ───────────────────────────────────────────────────────────────────────────

  test("AC3: all chunks retained when they fit the ceiling", () => {
    const prior = makeTestBundle(
      [
        makeTestChunk({ id: "a", kind: "session", tokens: 200, score: 0.9 }),
        makeTestChunk({ id: "b", kind: "history", tokens: 300, score: 0.8 }),
        makeTestChunk({ id: "c", kind: "session", tokens: 100, score: 0.7 }),
      ],
      { agentId: "claude" },
    );

    const result = rebuild(prior, {});

    const resultIds = result.chunks.map((c) => c.id);
    expect(resultIds).toContain("a");
    expect(resultIds).toContain("b");
    expect(resultIds).toContain("c");
  });

  test("AC9: chunks retain prior relative order when all fit", () => {
    const prior = makeTestBundle(
      [
        makeTestChunk({ id: "z", kind: "session", tokens: 100, score: 0.5 }),
        makeTestChunk({ id: "a", kind: "history", tokens: 100, score: 0.5 }),
        makeTestChunk({ id: "m", kind: "session", tokens: 100, score: 0.5 }),
      ],
      { agentId: "claude" },
    );

    const result = rebuild(prior, {});

    const resultIds = result.chunks.map((c) => c.id);
    expect(resultIds).toEqual(["z", "a", "m"]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC4 + AC5: Floor exceeds budget
  // ───────────────────────────────────────────────────────────────────────────

  test("AC4: all floor chunks retained when floor alone exceeds ceiling", () => {
    // Effective ceiling is 8000 (local agent). Floor total is 12000.
    const prior = makeTestBundle(
      [
        makeTestChunk({ id: "static-1", kind: "static", tokens: 5000, score: 1.0 }),
        makeTestChunk({ id: "feat-1", kind: "feature", tokens: 4000, score: 1.0 }),
        makeTestChunk({ id: "tc-1", kind: "test-coverage", tokens: 3000, score: 0.8 }),
      ],
      { agentId: "local" },
    );

    const result = rebuild(prior, {});

    const resultIds = result.chunks.map((c) => c.id);
    expect(resultIds).toContain("static-1");
    expect(resultIds).toContain("feat-1");
    expect(resultIds).toContain("tc-1");
  });

  test("AC5: floorOverageItems lists overflowed floor chunks from rebuild, not prior", () => {
    // Set prior floorOverageItems to a stale value to prove it's overwritten.
    const prior = makeTestBundle(
      [
        makeTestChunk({ id: "static-1", kind: "static", tokens: 5000, score: 1.0 }),
        makeTestChunk({ id: "feat-1", kind: "feature", tokens: 4000, score: 1.0 }),
      ],
      { agentId: "local" },
    );
    // Artificially set a stale floorOverageItems on the prior manifest.
    prior.manifest.floorOverageItems = ["stale-overage-id"];

    const result = rebuild(prior, {});

    // EffectiveBudget = min(16000, 8000) = 8000.
    // static-1 (5000) fits, feat-1 (4000) pushes to 9000 > 8000 → overage.
    expect(result.manifest.floorOverageItems).toEqual(["feat-1"]);
    // Must not carry the stale value forward.
    expect(result.manifest.floorOverageItems).not.toContain("stale-overage-id");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC6: Missing effectiveBudget → equals target preferredPromptTokens
  // ───────────────────────────────────────────────────────────────────────────

  test("AC6: missing effectiveBudget defaults to target profile preferredPromptTokens", () => {
    const prior = makeTestBundle(
      [makeTestChunk({ id: "a", kind: "session", tokens: 100, score: 0.5 })],
      { agentId: "claude" },
    );
    delete prior.manifest.effectiveBudget;

    const result = rebuild(prior, {});

    // Claude preferredPromptTokens = 16000
    expect(result.manifest.effectiveBudget).toBe(16_000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC7: Failure-note chunk survives packing
  // ───────────────────────────────────────────────────────────────────────────

  test("AC7: failure-note chunk present when ceiling smaller than prior payload", () => {
    // A single non-floor chunk that exceeds the target ceiling.
    const prior = makeTestBundle(
      [makeTestChunk({ id: "big-session", kind: "session", tokens: 9000, score: 0.9 })],
      { agentId: "local" },
    );

    const result = rebuild(prior, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    const resultIds = result.chunks.map((c) => c.id);
    const failureNoteId = resultIds.find((id) => id.startsWith("failure-note:"));
    expect(failureNoteId).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC8: Idempotent rebuild
  // ───────────────────────────────────────────────────────────────────────────

  test("AC8: rebuilding a rebuilt bundle produces the same usedTokens", () => {
    const prior = makeTestBundle(
      [
        makeTestChunk({ id: "s1", kind: "session", tokens: 1000, score: 0.9 }),
        makeTestChunk({ id: "s2", kind: "session", tokens: 1000, score: 0.8 }),
        makeTestChunk({ id: "s3", kind: "session", tokens: 9000, score: 0.7 }),
      ],
      { agentId: "local" },
    );

    const first = rebuild(prior, {});
    const second = rebuild(first, {});

    expect(second.manifest.usedTokens).toBe(first.manifest.usedTokens);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC10: chunkIdMap pairs every prior chunk ID with itself
  // ───────────────────────────────────────────────────────────────────────────

  test("AC10: chunkIdMap pairs every prior chunk ID with itself when all fit", () => {
    const prior = makeTestBundle(
      [
        makeTestChunk({ id: "c1", kind: "session", tokens: 100, score: 0.9 }),
        makeTestChunk({ id: "c2", kind: "history", tokens: 200, score: 0.8 }),
      ],
      { agentId: "codex" },
    );

    const result = rebuild(prior, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    const map = result.manifest.rebuildInfo?.chunkIdMap;
    expect(map).toBeDefined();
    expect(map!.length).toBe(2);
    expect(map!).toEqual(expect.arrayContaining([
      { priorChunkId: "c1", newChunkId: "c1" },
      { priorChunkId: "c2", newChunkId: "c2" },
    ]));
  });
});

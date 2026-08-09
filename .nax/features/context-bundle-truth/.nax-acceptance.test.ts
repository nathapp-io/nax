import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AGENT_PROFILES } from "../../../src/context/engine/agent-profiles";
import { ContextOrchestrator, _orchestratorDeps } from "../../../src/context/engine/orchestrator";
import { FLOOR_KINDS, packChunks } from "../../../src/context/engine/packing";
import type { PackedChunk } from "../../../src/context/engine/packing";
import { rebuild } from "../../../src/context/engine/rebuild";
import { renderChunks } from "../../../src/context/engine/render";
import type { ScoredChunk } from "../../../src/context/engine/scoring";
import type {
  AdapterFailure,
  ContextBundle,
  ContextChunk,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
} from "../../../src/context/engine/types";
import { makeLogger } from "../../../test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
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

const AVAILABILITY_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "test-failure: daily token quota exhausted",
  retriable: false,
};

function makeProvider(id: string, result: ContextProviderResult): IContextProvider {
  return { id, kind: "feature", fetch: async () => result };
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

/** Build a ContextChunk for direct ContextBundle fixtures (bypasses assemble()). */
function makeChunk(
  overrides: Partial<ContextChunk> & { id: string; kind: ContextChunk["kind"]; tokens: number },
): ContextChunk {
  return {
    providerId: "test",
    scope: "session",
    role: ["all"],
    content: `content for ${overrides.id}`,
    score: 0.5,
    ...overrides,
  };
}

/** Build a ContextBundle directly, for tests exercising rebuildForAgent() re-packing. */
function makeBundle(chunks: ContextChunk[], opts: { agentId?: string; effectiveBudget?: number } = {}): ContextBundle {
  return {
    pushMarkdown: "",
    pullTools: [],
    digest: "",
    agentId: opts.agentId,
    chunks,
    manifest: {
      requestId: "req-prior",
      stage: "tdd-implementer",
      totalBudgetTokens: 8_000,
      effectiveBudget: opts.effectiveBudget,
      usedTokens: chunks.reduce((sum, c) => sum + c.tokens, 0),
      includedChunks: chunks.map((c) => c.id),
      excludedChunks: [],
      floorItems: chunks.filter((c) => FLOOR_KINDS.includes(c.kind)).map((c) => c.id),
      floorOverageItems: undefined,
      digestTokens: 10,
      buildMs: 5,
    },
  };
}

let origRebuild: typeof _orchestratorDeps.rebuild;
let origGetLogger: typeof _orchestratorDeps.getLogger;

beforeEach(() => {
  origRebuild = _orchestratorDeps.rebuild;
  origGetLogger = _orchestratorDeps.getLogger;
});

afterEach(() => {
  _orchestratorDeps.rebuild = origRebuild;
  _orchestratorDeps.getLogger = origGetLogger;
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — extract rebuild into rebuild.ts, delegating wrapper (AC-1..AC-6)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — rebuild extraction", () => {
  test("AC-1: rebuild(priorBundle, {}) re-renders the prior chunks identically to renderChunks()", () => {
    const priorBundle = makeBundle(
      [
        makeChunk({
          id: "feature:1",
          kind: "feature",
          scope: "feature",
          tokens: 20,
          content: "Feature rule: use async/await.",
        }),
      ],
      { agentId: "claude", effectiveBudget: 16_000 },
    );
    const packed: PackedChunk[] = priorBundle.chunks.map((c) => ({
      ...c,
      rawScore: c.score,
      roleFiltered: false,
      belowMinScore: false,
    }));
    const expectedMarkdown = renderChunks(packed, {});

    const result = rebuild(priorBundle, {});

    expect(result.pushMarkdown).toBe(expectedMarkdown);
  });

  test("AC-2: _orchestratorDeps exposes rebuild as a replaceable function", () => {
    expect(typeof _orchestratorDeps.rebuild).toBe("function");
    const stub = () => ({}) as ContextBundle;
    _orchestratorDeps.rebuild = stub;
    expect(_orchestratorDeps.rebuild).toBe(stub);
  });

  test("AC-3: rebuildForAgent() returns whatever _orchestratorDeps.rebuild returns", () => {
    const sentinel = { pushMarkdown: "sentinel" } as unknown as ContextBundle;
    _orchestratorDeps.rebuild = () => sentinel;

    const orch = new ContextOrchestrator([]);
    const priorBundle = makeBundle([], { agentId: "claude" });

    const result = orch.rebuildForAgent(priorBundle, {});

    expect(result.pushMarkdown).toBe("sentinel");
  });

  test("AC-4: rebuildForAgent() invokes _orchestratorDeps.rebuild exactly once with (priorBundle, options)", () => {
    const spy = mock((_prior: ContextBundle, _options: unknown) => ({ pushMarkdown: "spy" }) as ContextBundle);
    _orchestratorDeps.rebuild = spy;

    const orch = new ContextOrchestrator([]);
    const priorBundle = makeBundle([], { agentId: "claude" });
    const options = { newAgentId: "codex", failure: AVAILABILITY_FAILURE };

    orch.rebuildForAgent(priorBundle, options);

    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0]?.[0]).toBe(priorBundle);
    expect(spy.mock.calls[0]?.[1]).toBe(options);
  });

  test("AC-5: manifest.rebuildInfo.newAgentId reflects the requested agent on an agent-swap failure", () => {
    const orch = new ContextOrchestrator([]);
    const priorBundle = makeBundle([makeChunk({ id: "feature:1", kind: "feature", scope: "feature", tokens: 20 })], {
      agentId: "claude",
      effectiveBudget: 16_000,
    });

    const result = orch.rebuildForAgent(priorBundle, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });

    expect(result.manifest.rebuildInfo?.newAgentId).toBe("codex");
  });

  test("AC-6: unknown newAgentId sets bundle.agentId to that ID and emits a warn-level log naming it", () => {
    const logger = makeLogger();
    _orchestratorDeps.getLogger = () => logger as unknown as ReturnType<typeof origGetLogger>;

    const orch = new ContextOrchestrator([]);
    const priorBundle = makeBundle([makeChunk({ id: "feature:1", kind: "feature", scope: "feature", tokens: 20 })], {
      agentId: "claude",
      effectiveBudget: 16_000,
    });

    const result = orch.rebuildForAgent(priorBundle, { newAgentId: "unknown-agent" });

    expect(result.agentId).toBe("unknown-agent");
    const warnedUnknownAgent = logger.calls.some(
      (c) =>
        c.level === "warn" &&
        (c.message.includes("unknown-agent") || JSON.stringify(c.data ?? {}).includes("unknown-agent")),
    );
    expect(warnedUnknownAgent).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — assemble() agent-aware framing (AC-7..AC-12)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 — assemble() agent-aware framing", () => {
  function orchWithChunk() {
    return new ContextOrchestrator([makeProvider("p1", makeChunkResult("chunk:framing"))]);
  }

  test("AC-7: agentId 'codex' produces xml-tagged <context_section type=...> push markdown", async () => {
    const orch = orchWithChunk();
    const bundle = await orch.assemble({ ...BASE_REQUEST, agentId: "codex" });
    expect(bundle.pushMarkdown).toMatch(/<context_section\s+type=/);
  });

  test("AC-8: agentId 'claude' produces '## ' markdown-section headers, no xml tags", async () => {
    const orch = orchWithChunk();
    const bundle = await orch.assemble({ ...BASE_REQUEST, agentId: "claude" });
    expect(bundle.pushMarkdown).toMatch(/^##\s+.+$/m);
    expect(bundle.pushMarkdown).not.toContain("<context_section");
  });

  test("AC-9: absent agentId produces '## ' markdown-section headers, no xml tags (unchanged default)", async () => {
    const orch = orchWithChunk();
    const { agentId: _drop, ...requestNoAgent } = { ...BASE_REQUEST, agentId: undefined };
    const bundle = await orch.assemble(requestNoAgent);
    expect(bundle.pushMarkdown).toMatch(/^##\s+.+$/m);
    expect(bundle.pushMarkdown).not.toContain("<context_section");
  });

  test("AC-10: unknown agentId produces plain [Section] bracket framing, no headers or xml tags", async () => {
    const orch = orchWithChunk();
    const bundle = await orch.assemble({ ...BASE_REQUEST, agentId: "unknown-agent" });
    expect(bundle.pushMarkdown).toMatch(/\[[^\]]+\]/);
    expect(bundle.pushMarkdown).not.toContain("## ");
    expect(bundle.pushMarkdown).not.toContain("<context_section");
  });

  test("AC-11: unknown agentId emits a warn-level log naming that agent id", async () => {
    const logger = makeLogger();
    _orchestratorDeps.getLogger = () => logger as unknown as ReturnType<typeof origGetLogger>;

    const orch = orchWithChunk();
    await orch.assemble({ ...BASE_REQUEST, agentId: "unknown-agent" });

    const warnedUnknownAgent = logger.calls.some(
      (c) =>
        c.level === "warn" &&
        (c.message.includes("unknown-agent") || JSON.stringify(c.data ?? {}).includes("unknown-agent")),
    );
    expect(warnedUnknownAgent).toBe(true);
  });

  test("AC-12: agentId 'codex' with priorStageDigest renders a non-empty prior_stage_summary xml section", async () => {
    const orch = orchWithChunk();
    const bundle = await orch.assemble({ ...BASE_REQUEST, agentId: "codex", priorStageDigest: "some-digest" });

    const match = bundle.pushMarkdown.match(
      /<context_section type="prior_stage_summary">\s*([\s\S]*?)\s*<\/context_section>/,
    );
    expect(match).not.toBeNull();
    expect((match?.[1] ?? "").trim().length).toBeGreaterThan(0);
    expect(bundle.pushMarkdown).toContain("some-digest");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — rebuildForAgent() re-packs to the target profile's ceiling (AC-13..AC-22)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuildForAgent() re-packing", () => {
  // "local" profile: preferredPromptTokens 8_000 — used as the target ceiling
  // when the prior bundle's own agentId is "local" (targetAgentId resolution
  // falls back to prior.agentId when newAgentId is omitted).
  const LOCAL_CEILING = AGENT_PROFILES.local?.caps.preferredPromptTokens ?? 8_000;

  function overBudgetNonFloorBundle() {
    const chunks = [
      makeChunk({ id: "sess:1", kind: "session", scope: "session", tokens: 3_500, score: 0.9 }),
      makeChunk({ id: "sess:2", kind: "session", scope: "session", tokens: 3_500, score: 0.8 }),
      makeChunk({ id: "sess:3", kind: "session", scope: "session", tokens: 3_500, score: 0.5 }),
    ];
    return makeBundle(chunks, { agentId: "local", effectiveBudget: LOCAL_CEILING });
  }

  test("AC-13: over-ceiling non-floor payload — manifest.usedTokens is at most manifest.effectiveBudget", () => {
    const orch = new ContextOrchestrator([]);
    const prior = overBudgetNonFloorBundle();

    const result = orch.rebuildForAgent(prior, {});

    expect(result.manifest.usedTokens).toBeLessThanOrEqual(result.manifest.effectiveBudget ?? Number.POSITIVE_INFINITY);
  });

  test("AC-14: over-ceiling payload — result.chunks is a strict subset of prior.chunks, excluded IDs are all non-floor", () => {
    const orch = new ContextOrchestrator([]);
    const prior = overBudgetNonFloorBundle();
    const priorKinds = new Map(prior.chunks.map((c) => [c.id, c.kind]));

    const result = orch.rebuildForAgent(prior, {});
    const resultIds = result.chunks.map((c) => c.id);
    const priorIds = prior.chunks.map((c) => c.id);

    expect(resultIds.length).toBeLessThan(priorIds.length);
    expect(resultIds.every((id) => priorIds.includes(id))).toBe(true);

    const excludedIds = priorIds.filter((id) => !resultIds.includes(id));
    expect(excludedIds.length).toBeGreaterThan(0);
    for (const id of excludedIds) {
      expect(FLOOR_KINDS.includes(priorKinds.get(id) as (typeof FLOOR_KINDS)[number])).toBe(false);
    }
  });

  test("AC-15: chunks fit the ceiling — result.chunks retains every prior chunk ID", () => {
    const orch = new ContextOrchestrator([]);
    const chunks = [
      makeChunk({ id: "sess:1", kind: "session", scope: "session", tokens: 1_000, score: 0.9 }),
      makeChunk({ id: "sess:2", kind: "session", scope: "session", tokens: 1_000, score: 0.8 }),
    ];
    const prior = makeBundle(chunks, { agentId: "local", effectiveBudget: LOCAL_CEILING });

    const result = orch.rebuildForAgent(prior, {});

    expect(result.chunks.map((c) => c.id).sort()).toEqual(prior.chunks.map((c) => c.id).sort());
  });

  test("AC-16: floor chunks alone exceeding the ceiling — every floor chunk ID from prior appears in result.chunks", () => {
    const orch = new ContextOrchestrator([]);
    const chunks = [
      makeChunk({ id: "static:1", kind: "static", scope: "project", tokens: 5_000, score: 1.0 }),
      makeChunk({ id: "feat:1", kind: "feature", scope: "feature", tokens: 4_000, score: 1.0 }),
    ];
    const prior = makeBundle(chunks, { agentId: "local", effectiveBudget: LOCAL_CEILING });

    const result = orch.rebuildForAgent(prior, {});
    const resultIds = result.chunks.map((c) => c.id);

    expect(resultIds).toContain("static:1");
    expect(resultIds).toContain("feat:1");
  });

  test("AC-17: floor overage — manifest.floorOverageItems lists exactly the overflowing floor chunk IDs, not the prior bundle's value", () => {
    const orch = new ContextOrchestrator([]);
    const chunks = [
      makeChunk({ id: "static:1", kind: "static", scope: "project", tokens: 5_000, score: 1.0 }),
      makeChunk({ id: "feat:1", kind: "feature", scope: "feature", tokens: 4_000, score: 1.0 }),
    ];
    const prior = makeBundle(chunks, { agentId: "local", effectiveBudget: LOCAL_CEILING });
    prior.manifest.floorOverageItems = ["stale-value-from-prior-assemble"];

    const result = orch.rebuildForAgent(prior, {});

    expect(result.manifest.floorOverageItems).not.toEqual(prior.manifest.floorOverageItems);
    const priorFloorIds = new Set(chunks.filter((c) => FLOOR_KINDS.includes(c.kind)).map((c) => c.id));
    for (const id of result.manifest.floorOverageItems ?? []) {
      expect(priorFloorIds.has(id)).toBe(true);
    }
    expect((result.manifest.floorOverageItems ?? []).sort()).toEqual(["feat:1", "static:1"]);
  });

  test("AC-18: prior manifest.effectiveBudget undefined — result.manifest.effectiveBudget equals the target profile's preferredPromptTokens", () => {
    const orch = new ContextOrchestrator([]);
    const chunks = [makeChunk({ id: "sess:1", kind: "session", scope: "session", tokens: 100, score: 0.9 })];
    const prior = makeBundle(chunks, { agentId: "local" });
    expect(prior.manifest.effectiveBudget).toBeUndefined();

    const result = orch.rebuildForAgent(prior, {});

    expect(result.manifest.effectiveBudget).toBe(LOCAL_CEILING);
  });

  test("AC-19: agent-swap with a target ceiling smaller than the prior payload — a failure-note chunk is injected referencing the failure", () => {
    const orch = new ContextOrchestrator([]);
    const chunks = [
      makeChunk({ id: "sess:1", kind: "session", scope: "session", tokens: 3_000, score: 0.9 }),
      makeChunk({ id: "sess:2", kind: "session", scope: "session", tokens: 3_000, score: 0.8 }),
    ];
    const prior = makeBundle(chunks, { agentId: "claude", effectiveBudget: 16_000 });
    const failure: AdapterFailure = { ...AVAILABILITY_FAILURE, message: "test-failure" };

    const result = orch.rebuildForAgent(prior, { newAgentId: "local", failure });

    const failureChunk = result.chunks.find((c) => c.id.startsWith("failure-note:"));
    expect(failureChunk).toBeDefined();
    expect(failureChunk?.content).toContain("test-failure");
  });

  test("AC-20: repeated rebuilds are idempotent — a second rebuild reports the same manifest.usedTokens", () => {
    const orch = new ContextOrchestrator([]);
    const prior = overBudgetNonFloorBundle();

    const result1 = orch.rebuildForAgent(prior, {});
    const result2 = orch.rebuildForAgent(result1, {});

    expect(result2.manifest.usedTokens).toBe(result1.manifest.usedTokens);
  });

  test("AC-21: chunks all fit — result.chunks preserves prior.chunks' relative order element-by-index", () => {
    const orch = new ContextOrchestrator([]);
    const chunks = [
      makeChunk({ id: "sess:c", kind: "session", scope: "session", tokens: 100, score: 0.3 }),
      makeChunk({ id: "sess:a", kind: "session", scope: "session", tokens: 100, score: 0.9 }),
      makeChunk({ id: "sess:b", kind: "session", scope: "session", tokens: 100, score: 0.6 }),
    ];
    const prior = makeBundle(chunks, { agentId: "local", effectiveBudget: LOCAL_CEILING });

    const result = orch.rebuildForAgent(prior, {});

    expect(result.chunks.map((c) => c.id)).toEqual(prior.chunks.map((c) => c.id));
  });

  test("AC-22: agent-swap with all prior chunks fitting — chunkIdMap pairs every prior chunk ID with itself; the failure-note maps to its own injected ID", () => {
    const orch = new ContextOrchestrator([]);
    const chunks = [
      makeChunk({ id: "sess:1", kind: "session", scope: "session", tokens: 100, score: 0.9 }),
      makeChunk({ id: "sess:2", kind: "session", scope: "session", tokens: 100, score: 0.8 }),
    ];
    const prior = makeBundle(chunks, { agentId: "claude", effectiveBudget: 16_000 });
    const failure: AdapterFailure = { ...AVAILABILITY_FAILURE, message: "test-failure" };

    const result = orch.rebuildForAgent(prior, { newAgentId: "local", failure });
    const chunkIdMap = result.manifest.rebuildInfo?.chunkIdMap ?? [];

    const priorEntries = chunkIdMap.filter((e) => !e.newChunkId.startsWith("failure-note:"));
    for (const entry of priorEntries) {
      expect(entry.newChunkId).toBe(entry.priorChunkId);
    }
    const failureEntries = chunkIdMap.filter((e) => e.newChunkId.startsWith("failure-note:"));
    const failureChunkId = result.chunks.find((c) => c.id.startsWith("failure-note:"))?.id;
    expect(failureChunkId).toBeDefined();
    expect(failureEntries.some((e) => e.newChunkId === failureChunkId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 — packChunks best-of(greedy, largest-feasible) repair (AC-23..AC-28)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — packChunks optimality repair", () => {
  let idSeq = 0;
  function makeScored(overrides: Partial<ScoredChunk> = {}): ScoredChunk {
    idSeq++;
    return {
      id: `chunk:${idSeq}`,
      kind: "session",
      scope: "session",
      role: ["all"],
      content: "content",
      tokens: 100,
      rawScore: 0.8,
      score: 0.8,
      roleFiltered: false,
      belowMinScore: false,
      ...overrides,
    };
  }

  test("AC-23: best-of picks the single 900-token/0.9 chunk over greedy's 100-token/0.5 chunk at budget 900", () => {
    const chunks = [
      makeScored({ id: "bulky", tokens: 900, score: 0.9, rawScore: 0.9 }),
      makeScored({ id: "dense", tokens: 100, score: 0.5, rawScore: 0.5 }),
    ];
    const result = packChunks(chunks, 900);
    expect(result.packed.map((c) => c.id)).toEqual(["bulky"]);
  });

  test("AC-24: best-of picks the two 100-token/0.5 chunks (sum 1.0) over the single 900-token/0.9 chunk at budget 900", () => {
    const chunks = [
      makeScored({ id: "bulky", tokens: 900, score: 0.9, rawScore: 0.9 }),
      makeScored({ id: "small1", tokens: 100, score: 0.5, rawScore: 0.5 }),
      makeScored({ id: "small2", tokens: 100, score: 0.5, rawScore: 0.5 }),
    ];
    const result = packChunks(chunks, 900);
    expect(result.packed.map((c) => c.id).sort()).toEqual(["small1", "small2"]);
    expect(result.budgetExcludedIds).toContain("bulky");
  });

  test("AC-25: non-floor-only inputs always report usedTokens <= effectiveBudget and finite", () => {
    const fixtures: ScoredChunk[][] = [
      [makeScored({ tokens: 50, score: 0.4 }), makeScored({ tokens: 500, score: 0.9 })],
      [makeScored({ tokens: 0, score: 0.1 }), makeScored({ tokens: 300, score: 0.7 })],
      [
        makeScored({ tokens: 200, score: 0.2 }),
        makeScored({ tokens: 200, score: 0.3 }),
        makeScored({ tokens: 200, score: 0.9 }),
      ],
      [makeScored({ tokens: 1_000, score: 1.0 })],
      [],
    ];
    for (const chunks of fixtures) {
      const result = packChunks(chunks, 400);
      expect(result.usedTokens).toBeLessThanOrEqual(result.effectiveBudget);
      expect(Number.isFinite(result.usedTokens)).toBe(true);
    }
  });

  test("AC-26: 200 fixed-seed repair-envelope cases each pack within 95% of the exhaustive oracle", () => {
    // mulberry32 — deterministic PRNG so a failure is reproducible across runs.
    function mulberry32(seed: number) {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rand = mulberry32(42);
    const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

    function exhaustiveOptimum(items: { tokens: number; score: number }[], budget: number): number {
      let best = 0;
      const n = items.length;
      for (let mask = 0; mask < 1 << n; mask++) {
        let tokens = 0;
        let score = 0;
        for (let i = 0; i < n; i++) {
          if (mask & (1 << i)) {
            tokens += items[i].tokens;
            score += items[i].score;
          }
        }
        if (tokens <= budget && score > best) best = score;
      }
      return best;
    }

    const CASES = 200;
    for (let case_ = 0; case_ < CASES; case_++) {
      const items: { tokens: number; score: number }[] = [];
      let budget: number;

      if (case_ < CASES / 2) {
        // Every item fits: density-greedy is optimal by construction.
        const n = randInt(1, 12);
        for (let i = 0; i < n; i++) {
          items.push({ tokens: randInt(50, 500), score: Math.round((0.1 + rand() * 0.9) * 100) / 100 });
        }
        budget = items.reduce((sum, item) => sum + item.tokens, 0);
      } else {
        // The bulky item is the largest feasible single item. Greedy sees
        // denser small items first, but their selected score remains below the
        // bulky score because the budget leaves a fractional unused slot.
        const smallCount = randInt(5, 11);
        const smallTokens = randInt(50, 100);
        const greedySlots = randInt(2, 5);
        budget = greedySlots * smallTokens + Math.floor(smallTokens / 2);
        items.push({ tokens: budget, score: 0.9 });
        const smallScore = Math.round((0.9 / greedySlots) * 0.98 * 100) / 100;
        for (let i = 0; i < smallCount; i++) {
          items.push({ tokens: smallTokens, score: smallScore });
        }
      }

      const chunks = items.map((it, i) =>
        makeScored({ id: `case${case_}-${i}`, tokens: it.tokens, score: it.score, rawScore: it.score }),
      );
      const result = packChunks(chunks, budget);
      const packedScore = result.packed.reduce((s, c) => s + c.score, 0);
      const optimum = exhaustiveOptimum(items, budget);

      if (optimum > 0) {
        expect(packedScore).toBeGreaterThanOrEqual(0.95 * optimum);
      } else {
        expect(packedScore).toBe(0);
      }
    }
  });

  test("AC-27: only-floor-kind chunks exceeding budget are all packed with reason 'budget-exceeded-by-floor'", () => {
    const chunks: ScoredChunk[] = [
      makeScored({ id: "f1", kind: "static", scope: "project", score: 0.9, tokens: 1_500 }),
      makeScored({ id: "f2", kind: "feature", scope: "feature", score: 0.8, tokens: 1_200 }),
      makeScored({ id: "f3", kind: "test-coverage", scope: "story", score: 0.7, tokens: 1_000 }),
    ];
    const result = packChunks(chunks, 900);

    expect(result.packed).toHaveLength(3);
    expect(result.packed.every((c) => c.reason === "budget-exceeded-by-floor")).toBe(true);
    expect(result.floorPackedIds).toHaveLength(3);
    expect(result.floorOverageIds).toHaveLength(3);
  });

  test("AC-28: a zero-token chunk is always packed and usedTokens stays finite and non-negative", () => {
    const chunks: ScoredChunk[] = [makeScored({ id: "zero", tokens: 0, score: 0.5 })];
    const result = packChunks(chunks, 900);

    expect(result.packed.some((c) => c.id === "zero")).toBe(true);
    expect(Number.isFinite(result.usedTokens)).toBe(true);
    expect(result.usedTokens).toBeGreaterThanOrEqual(0);
  });
});

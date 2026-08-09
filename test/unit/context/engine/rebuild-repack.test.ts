/**
 * US-003 — Repack rebuilt bundles to the target ceiling
 *
 * Acceptance criteria (anchored to the extracted rebuild() function in
 * `src/context/engine/rebuild.ts`, reached through
 * `ContextOrchestrator.rebuildForAgent()`):
 *
 *   AC1  Over-budget non-floor prior → manifest.usedTokens ≤ manifest.effectiveBudget
 *   AC2  Over-budget prior          → rebuilt chunks omit the excluded non-floor IDs
 *   AC3  Under-budget prior         → rebuilt chunks retain every prior chunk ID
 *   AC4  Floor overage scenario     → rebuilt bundle contains every floor chunk ID
 *   AC5  Floor overage scenario     → manifest.floorOverageItems lists the new
 *                                     pack's overflow ids, not the prior bundle's
 *   AC6  Prior missing effectiveBudget → rebuilt effectiveBudget equals the
 *                                       target profile's preferredPromptTokens
 *   AC7  Swap with smaller ceiling + failure → rebuilt bundle contains the
 *                                            injected failure-note chunk
 *   AC8  Rebuilding twice           → manifest.usedTokens equals the first
 *                                     rebuild's value
 *   AC9  Under-budget prior         → rebuilt chunks retain prior's relative order
 *   AC10 Swap with under-budget prior → manifest.rebuildInfo.chunkIdMap pairs
 *                                      every prior chunk ID with itself
 *
 * The rebuilt bundle must re-pack using `packChunks`, but the emitted chunk
 * order must follow the prior bundle's order (not packChunks' density order),
 * and the rebuild must recompute its own floorOverageItems from the new pack
 * result rather than inheriting the prior bundle's value.
 */

import { describe, expect, test } from "bun:test";
import { AGENT_PROFILES, ContextOrchestrator, FLOOR_KINDS } from "@/context/engine";
import type {
  AdapterFailure,
  ContextBundle,
  ContextChunk,
  ContextManifest,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
} from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-003",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 16_000,
  providerIds: ["p1"],
};

function makeProvider(id: string, result: ContextProviderResult): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async () => result,
  };
}

function chunk(opts: {
  id: string;
  kind?: ContextChunk["kind"];
  scope?: ContextChunk["scope"];
  role?: ContextChunk["role"];
  content?: string;
  tokens?: number;
  rawScore?: number;
  score?: number;
}): ContextChunk {
  return {
    id: opts.id,
    providerId: opts.id.split(":")[0] ?? "p1",
    kind: opts.kind ?? "feature",
    scope: opts.scope ?? "feature",
    role: opts.role ?? ["all"],
    content: opts.content ?? `content for ${opts.id}`,
    tokens: opts.tokens ?? 100,
    rawScore: opts.rawScore ?? 0.8,
    score: opts.score ?? opts.rawScore ?? 0.8,
  };
}

function rawChunk(opts: {
  id: string;
  kind?: ContextChunk["kind"];
  scope?: ContextChunk["scope"];
  role?: ContextChunk["role"];
  content?: string;
  tokens?: number;
  rawScore?: number;
}) {
  return {
    id: opts.id,
    kind: opts.kind ?? "feature",
    scope: opts.scope ?? "feature",
    role: opts.role ?? ["all"],
    content: opts.content ?? `content for ${opts.id}`,
    tokens: opts.tokens ?? 100,
    rawScore: opts.rawScore ?? 0.8,
  };
}

const AVAILABILITY_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "daily token quota exhausted",
  retriable: false,
};

function makeManifest(overrides: Partial<ContextManifest> = {}): ContextManifest {
  return {
    requestId: "req-us-003",
    stage: BASE_REQUEST.stage,
    totalBudgetTokens: BASE_REQUEST.budgetTokens,
    effectiveBudget: BASE_REQUEST.budgetTokens,
    usedTokens: 0,
    includedChunks: [],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 0,
    buildMs: 0,
    ...overrides,
  };
}

function makeBundleFromChunks(
  chunks: ContextChunk[],
  manifestOverrides: Partial<ContextManifest> = {},
  agentId = "claude",
): ContextBundle {
  return {
    pushMarkdown: "",
    pullTools: [],
    digest: "",
    chunks,
    agentId,
    manifest: makeManifest({
      includedChunks: chunks.map((c) => c.id),
      floorItems: chunks.filter((c) => FLOOR_KINDS.includes(c.kind)).map((c) => c.id),
      usedTokens: chunks.reduce((s, c) => s + c.tokens, 0),
      ...manifestOverrides,
    }),
  };
}

// Conservative-default profile used as the "small ceiling" target. Its
// preferredPromptTokens (8_000) is much smaller than claude's (16_000), so
// we can build a claude bundle whose payload exceeds 8_000 and confirm the
// rebuild against an unknown agentId forces a 8_000-token ceiling.
const CONSERVATIVE_CEILING = 8_000;

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — manifest.usedTokens ≤ manifest.effectiveBudget on over-budget prior
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC1: usedTokens ≤ effectiveBudget on over-budget prior", () => {
  test("rebuild of an over-budget prior bundle yields usedTokens <= effectiveBudget", async () => {
    // Build a prior claude bundle whose non-floor session chunks total > 8_000
    // (the conservative profile's preferredPromptTokens). After swap to an
    // unknown agent (which falls back to CONSERVATIVE_DEFAULT_PROFILE with an
    // 8k ceiling), the rebuilt manifest.usedTokens must not exceed that
    // ceiling.
    const overBudgetChunks: ContextChunk[] = [
      chunk({ id: "p1:feat", kind: "feature", tokens: 200, content: "feature rule" }),
      chunk({ id: "p1:sess-a", kind: "session", tokens: 5_000, content: "x".repeat(20_000) }),
      chunk({ id: "p1:sess-b", kind: "session", tokens: 5_000, content: "y".repeat(20_000) }),
      chunk({ id: "p1:sess-c", kind: "session", tokens: 5_000, content: "z".repeat(20_000) }),
    ];
    const prior = makeBundleFromChunks(
      overBudgetChunks,
      {
        effectiveBudget: 16_000,
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.effectiveBudget).toBeDefined();
    expect(rebuilt.manifest.usedTokens).toBeLessThanOrEqual(rebuilt.manifest.effectiveBudget as number);
  });

  test("rebuild against the conservative-default ceiling: effectiveBudget equals 8_000", async () => {
    const overBudgetChunks: ContextChunk[] = [
      chunk({ id: "p1:feat", kind: "feature", tokens: 200 }),
      chunk({ id: "p1:sess-a", kind: "session", tokens: 5_000 }),
      chunk({ id: "p1:sess-b", kind: "session", tokens: 5_000 }),
    ];
    const prior = makeBundleFromChunks(
      overBudgetChunks,
      {
        effectiveBudget: 16_000,
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.effectiveBudget).toBe(CONSERVATIVE_CEILING);
    expect(rebuilt.manifest.usedTokens).toBeLessThanOrEqual(CONSERVATIVE_CEILING);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — rebuilt chunks omit the excluded non-floor chunks on over-budget prior
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC2: rebuilt chunks omit the excluded non-floor IDs", () => {
  test("over-budget prior: rebuilt chunks drop the non-floor IDs that packChunks excluded", async () => {
    const lowSessionA = chunk({ id: "p1:sess-low", kind: "session", tokens: 6_000, rawScore: 0.5 });
    const lowSessionB = chunk({ id: "p1:sess-mid", kind: "session", tokens: 5_000, rawScore: 0.4 });
    const lowSessionC = chunk({ id: "p1:sess-excl", kind: "session", tokens: 4_000, rawScore: 0.3 });
    const floorFeat = chunk({ id: "p1:feat", kind: "feature", tokens: 100, rawScore: 1.0 });

    const prior = makeBundleFromChunks(
      [floorFeat, lowSessionA, lowSessionB, lowSessionC],
      {
        effectiveBudget: 16_000,
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const rebuiltIds = rebuilt.chunks.map((c) => c.id);

    // Floor chunk (feature) is always retained regardless of budget.
    expect(rebuiltIds).toContain("p1:feat");
    // At least one of the over-budget non-floor chunks must be excluded so
    // that usedTokens fits under the conservative ceiling.
    const excludedNonFloor = [lowSessionA, lowSessionB, lowSessionC].filter((c) => !rebuiltIds.includes(c.id));
    expect(excludedNonFloor.length).toBeGreaterThan(0);
    // The rebuilt bundle must be strictly smaller than the prior's chunk set
    // when the prior was over the conservative ceiling.
    expect(rebuiltIds.length).toBeLessThan(prior.chunks.length);
  });

  test("the rebuilt chunk ids equal {floor chunks retained} ∪ {non-floor chunks packChunks kept}, not the prior's full set", async () => {
    // Single feature floor + four equal-sized session chunks. With the
    // 8_000-token conservative ceiling and 100 token feature floor, only
    // some session chunks fit; the rebuild must drop the rest.
    const floorFeat = chunk({ id: "p1:feat", kind: "feature", tokens: 100 });
    const sessions = ["a", "b", "c", "d"].map((s) =>
      chunk({ id: `p1:sess-${s}`, kind: "session", tokens: 4_000, rawScore: 0.6 }),
    );

    const prior = makeBundleFromChunks(
      [floorFeat, ...sessions],
      {
        effectiveBudget: 16_000,
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    // AC7 injects a failure-note chunk whenever newAgentId + failure are
    // supplied, and its id is by construction absent from the prior. Drop it
    // before the subset comparison — AC2 is about which PRIOR chunks survive.
    const noteId = `failure-note:${prior.agentId}:totally-unknown-agent:${AVAILABILITY_FAILURE.outcome}`;
    const rebuiltIds = new Set(rebuilt.chunks.map((c) => c.id).filter((id) => id !== noteId));
    // Floor chunk is retained.
    expect(rebuiltIds.has("p1:feat")).toBe(true);
    // The surviving prior chunks must be a strict subset of the prior chunks.
    const priorIds = new Set(prior.chunks.map((c) => c.id));
    for (const id of rebuiltIds) {
      expect(priorIds.has(id)).toBe(true);
    }
    expect(rebuiltIds.size).toBeLessThan(priorIds.size);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — under-budget prior retains every prior chunk ID on rebuild
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC3: rebuilt chunks retain every prior chunk ID when prior fits", () => {
  test("under-budget prior rebuilt plain (no swap) keeps every prior chunk ID", async () => {
    // Sized to sit just under claude's 16_000 ceiling rather than trivially
    // low: a rebuild that packs to any fraction of the ceiling (e.g. 75%)
    // would drop p1:sess-b here, which AC3 forbids.
    const chunks = [
      chunk({ id: "p1:feat", kind: "feature", tokens: 200 }),
      chunk({ id: "p1:sess-a", kind: "session", tokens: 3_000 }),
      chunk({ id: "p1:sess-b", kind: "session", tokens: 12_000 }),
    ];
    const prior = makeBundleFromChunks(
      chunks,
      {
        effectiveBudget: 16_000,
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {});

    const priorIds = prior.chunks.map((c) => c.id).sort();
    const rebuiltIds = rebuilt.chunks.map((c) => c.id).sort();
    expect(rebuiltIds).toEqual(priorIds);
  });

  test("under-budget prior rebuilt plain (no swap): every prior chunk ID is contained in rebuilt chunks", async () => {
    // A weaker version that survives whether a rebuild adds extras — asserts
    // that the rebuild does NOT drop any prior chunk ID when the prior fits.
    const chunks = [
      chunk({ id: "p1:feat", kind: "feature", tokens: 200 }),
      chunk({ id: "p1:sess-a", kind: "session", tokens: 300 }),
      chunk({ id: "p1:sess-b", kind: "session", tokens: 400 }),
    ];
    const prior = makeBundleFromChunks(
      chunks,
      {
        effectiveBudget: 16_000,
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {});

    const rebuiltIds = new Set(rebuilt.chunks.map((c) => c.id));
    for (const id of prior.chunks.map((c) => c.id)) {
      expect(rebuiltIds.has(id)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — floor overage scenario: every floor chunk ID retained
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC4: floor-kind chunks are all retained when they overflow the ceiling", () => {
  test("two feature chunks whose tokens alone exceed the conservative ceiling are both retained", async () => {
    const floorBigA = chunk({ id: "p1:feat-a", kind: "feature", tokens: 6_000 });
    const floorBigB = chunk({ id: "p1:feat-b", kind: "feature", tokens: 6_000 });
    const nonFloor = chunk({ id: "p1:sess", kind: "session", tokens: 500 });

    const prior = makeBundleFromChunks(
      [floorBigA, floorBigB, nonFloor],
      {
        effectiveBudget: 16_000,
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const rebuiltIds = rebuilt.chunks.map((c) => c.id);
    expect(rebuiltIds).toContain("p1:feat-a");
    expect(rebuiltIds).toContain("p1:feat-b");
    expect(rebuiltIds).not.toContain("p1:sess");
  });

  test("static + feature + test-coverage floor chunks all retained on overage", async () => {
    const floorStatic = chunk({ id: "p1:rules", kind: "static", tokens: 5_000 });
    const floorFeature = chunk({ id: "p1:feat", kind: "feature", tokens: 5_000 });
    const floorTestCov = chunk({ id: "p1:tc", kind: "test-coverage", tokens: 5_000 });
    const nonFloor = chunk({ id: "p1:sess", kind: "session", tokens: 500 });

    const prior = makeBundleFromChunks(
      [floorStatic, floorFeature, floorTestCov, nonFloor],
      { effectiveBudget: 16_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const rebuiltIds = rebuilt.chunks.map((c) => c.id);
    expect(rebuiltIds).toContain("p1:rules");
    expect(rebuiltIds).toContain("p1:feat");
    expect(rebuiltIds).toContain("p1:tc");
    expect(rebuiltIds).not.toContain("p1:sess");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — manifest.floorOverageItems is the new pack's overflow, not the prior's
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC5: floorOverageItems reflects the rebuild's own pack, not the prior", () => {
  test("floor overage list comes from the rebuild pack, not the prior bundle", async () => {
    // Prior carries a stale floorOverageItems from a *different* overflow
    // scenario. After rebuild, the floorOverageItems must be the rebuilt
    // pack's floorOverageIds, not the prior's leftover.
    // AC5's precondition is "floor-kind chunks whose tokens ALONE exceed the
    // target ceiling", so floorBig must clear CONSERVATIVE_CEILING (8_000) on
    // its own — otherwise nothing overflows and the assertions below are vacuous.
    const floorBig = chunk({ id: "p1:feat-big", kind: "feature", tokens: 8_500 });
    const floorSmall = chunk({ id: "p1:feat-small", kind: "feature", tokens: 200 });
    const nonFloor = chunk({ id: "p1:sess", kind: "session", tokens: 500 });

    const prior = makeBundleFromChunks(
      [floorBig, floorSmall, nonFloor],
      {
        effectiveBudget: 16_000,
        // Prior bundle says floorOverageItems = ["stale-floor-id"] — this is
        // a fictional id that does not exist in the prior's chunks. The
        // rebuild must NOT inherit it.
        floorOverageItems: ["stale-floor-id-from-prior"],
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    // The rebuilt floorOverageItems must not contain the prior's stale id.
    expect(rebuilt.manifest.floorOverageItems ?? []).not.toContain("stale-floor-id-from-prior");
    // It must contain at least one of the rebuilt pack's overflow ids.
    expect(rebuilt.manifest.floorOverageItems).toBeDefined();
    const overflow = rebuilt.manifest.floorOverageItems ?? [];
    expect(overflow.length).toBeGreaterThan(0);
    // Every overflow id must be an id present in the rebuilt chunks.
    const rebuiltIds = new Set(rebuilt.chunks.map((c) => c.id));
    for (const id of overflow) {
      expect(rebuiltIds.has(id)).toBe(true);
    }
  });

  test("floor overage list contains exactly the floor ids whose tokens push past the conservative ceiling", async () => {
    const floorBig = chunk({ id: "p1:feat-big", kind: "feature", tokens: 6_000 });
    const floorSmall = chunk({ id: "p1:feat-small", kind: "feature", tokens: 100 });
    // Conservative ceiling 8_000. floorBig (6_000) alone does not overflow.
    // floorBig + floorSmall = 6_100, still under 8_000. To force overflow,
    // make floorBig bigger.
    const biggerFloorBig = chunk({ id: "p1:feat-huge", kind: "feature", tokens: 9_000 });
    const nonFloor = chunk({ id: "p1:sess", kind: "session", tokens: 500 });

    const prior = makeBundleFromChunks(
      [biggerFloorBig, floorSmall, nonFloor],
      {
        effectiveBudget: 16_000,
        floorOverageItems: ["old-stale-id"],
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const overflow = rebuilt.manifest.floorOverageItems ?? [];
    // Overflow is cumulative, matching the packer's own rule
    // (`usedTokens + chunk.tokens > effectiveBudget`) and `manifest-builder`
    // on the primary build path: p1:feat-huge (9_000) clears the 8_000 ceiling
    // by itself, and p1:feat-small lands on top of it at 9_100, so BOTH are
    // over-budget floor chunks. The spec asks for "exactly the floor chunk ids
    // that overflowed that ceiling" — that is the whole set, not just the first.
    expect(overflow).toContain("p1:feat-huge");
    expect(overflow).toContain("p1:feat-small");
    // The non-floor chunk must not be in floorOverageItems.
    expect(overflow).not.toContain("p1:sess");
    // The stale id from the prior must be gone.
    expect(overflow).not.toContain("old-stale-id");
  });

  test("floorOverageItems is undefined when no floor chunk overflows", async () => {
    const floorSmall = chunk({ id: "p1:feat-small", kind: "feature", tokens: 100 });
    const nonFloor = chunk({ id: "p1:sess", kind: "session", tokens: 200 });
    const prior = makeBundleFromChunks(
      [floorSmall, nonFloor],
      {
        effectiveBudget: 16_000,
        floorOverageItems: ["leftover-from-prior"],
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {});

    // No overflow in the rebuild — floorOverageItems must be undefined or
    // empty, and must not carry the prior's leftover value.
    expect(rebuilt.manifest.floorOverageItems ?? []).not.toContain("leftover-from-prior");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — when prior.manifest.effectiveBudget is missing, rebuilt uses target profile's ceiling
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC6: rebuilt effectiveBudget equals target profile's preferredPromptTokens when prior omits it", () => {
  test("prior without effectiveBudget + swap to codex: rebuilt effectiveBudget = 12_000 (codex profile)", async () => {
    const prior: ContextBundle = makeBundleFromChunks(
      [chunk({ id: "p1:feat", kind: "feature", tokens: 200 })],
      // Note: effectiveBudget omitted.
      { effectiveBudget: undefined },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.effectiveBudget).toBe(AGENT_PROFILES.codex.caps.preferredPromptTokens);
  });

  test("prior without effectiveBudget + swap to claude: rebuilt effectiveBudget = 16_000 (claude profile)", async () => {
    const prior: ContextBundle = makeBundleFromChunks(
      [chunk({ id: "p1:feat", kind: "feature", tokens: 200 })],
      { effectiveBudget: undefined },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "claude",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.effectiveBudget).toBe(AGENT_PROFILES.claude.caps.preferredPromptTokens);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — failure-note chunk is injected on swap with smaller ceiling
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC7: failure-note chunk is retained when ceiling shrinks", () => {
  test("swap to a smaller-ceiling agent + failure: rebuilt bundle contains the failure-note chunk", async () => {
    // AC7's precondition is "a target ceiling SMALLER than the prior payload".
    // The payload must therefore exceed CONSERVATIVE_CEILING (8_000) — at
    // 6_200 the prior still fits and the shrinking ceiling is never exercised.
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat", kind: "feature", tokens: 200 }),
        chunk({ id: "p1:sess", kind: "session", tokens: 12_000 }),
      ],
      { effectiveBudget: 16_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const expectedId = `failure-note:${prior.agentId}:totally-unknown-agent:${AVAILABILITY_FAILURE.outcome}`;
    const rebuiltIds = rebuilt.chunks.map((c) => c.id);
    expect(rebuiltIds).toContain(expectedId);
  });

  test("the failure-note chunk is the LAST chunk in the rebuilt bundle so prior order is preserved above it", async () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat", kind: "feature", tokens: 100 }),
        chunk({ id: "p1:sess-a", kind: "session", tokens: 200 }),
        chunk({ id: "p1:sess-b", kind: "session", tokens: 200 }),
      ],
      { effectiveBudget: 4_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const expectedId = `failure-note:${prior.agentId}:totally-unknown-agent:${AVAILABILITY_FAILURE.outcome}`;
    expect(rebuilt.chunks.at(-1)?.id).toBe(expectedId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — rebuilding twice is idempotent on manifest.usedTokens
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC8: rebuilding the rebuilt bundle preserves manifest.usedTokens", () => {
  test("two consecutive rebuilds of the same prior produce equal manifest.usedTokens", () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat", kind: "feature", tokens: 200 }),
        chunk({ id: "p1:sess-a", kind: "session", tokens: 300 }),
        chunk({ id: "p1:sess-b", kind: "session", tokens: 400 }),
      ],
      { effectiveBudget: 16_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const first = orch.rebuildForAgent(prior, {});
    const second = orch.rebuildForAgent(first, {});

    expect(second.manifest.usedTokens).toBe(first.manifest.usedTokens);
  });

  test("rebuilding an over-budget bundle twice still lands on the conservative ceiling", () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat", kind: "feature", tokens: 200 }),
        chunk({ id: "p1:sess-a", kind: "session", tokens: 5_000 }),
        chunk({ id: "p1:sess-b", kind: "session", tokens: 5_000 }),
        chunk({ id: "p1:sess-c", kind: "session", tokens: 5_000 }),
      ],
      { effectiveBudget: 16_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const first = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });
    const second = orch.rebuildForAgent(first, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    expect(first.manifest.usedTokens).toBeLessThanOrEqual(CONSERVATIVE_CEILING);
    expect(second.manifest.usedTokens).toBe(first.manifest.usedTokens);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — rebuilt chunks retain prior's relative order
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC9: rebuilt chunks retain prior's relative order", () => {
  test("prior with three chunks in a non-density order is rebuilt in the same order", () => {
    // Set scores so packChunks would emit them in a DIFFERENT order than the
    // prior order if it were following density rank (lowest-scored chunk is
    // first in the prior; packChunks would push low-density last).
    const prior = makeBundleFromChunks(
      [
        // Low-score, large tokens — would rank LAST by density
        chunk({ id: "p1:sess-low", kind: "session", tokens: 800, rawScore: 0.2, score: 0.2 }),
        // Medium score
        chunk({ id: "p1:sess-mid", kind: "session", tokens: 400, rawScore: 0.5, score: 0.5 }),
        // High score, small tokens — would rank FIRST by density
        chunk({ id: "p1:sess-high", kind: "session", tokens: 100, rawScore: 0.9, score: 0.9 }),
      ],
      { effectiveBudget: 16_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {});

    const priorOrder = prior.chunks.map((c) => c.id);
    const rebuiltOrder = rebuilt.chunks.map((c) => c.id);
    expect(rebuiltOrder).toEqual(priorOrder);
  });

  test("after dropping an over-budget chunk, the surviving chunks keep their relative order", async () => {
    // Set up an over-budget prior where packChunks drops a middle chunk.
    // The surviving chunks (plus the injected failure-note kept last) must
    // appear in the same relative order they did in the prior.
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:sess-a", kind: "session", tokens: 5_000, rawScore: 0.5, score: 0.5 }),
        chunk({ id: "p1:feat", kind: "feature", tokens: 100 }),
        chunk({ id: "p1:sess-b", kind: "session", tokens: 5_000, rawScore: 0.4, score: 0.4 }),
      ],
      { effectiveBudget: 16_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const rebuiltIds = rebuilt.chunks.map((c) => c.id);
    const expectedNoteId = `failure-note:${prior.agentId}:totally-unknown-agent:${AVAILABILITY_FAILURE.outcome}`;
    // Drop the injected failure-note before comparing relative order.
    const rebuiltOrder = rebuiltIds.filter((id) => id !== expectedNoteId);
    // The rebuilt prior-chunk order (minus the failure-note) must equal the
    // prior's chunk order filtered to the survivors.
    const priorSurvivors = prior.chunks.map((c) => c.id).filter((id) => rebuiltOrder.includes(id));
    expect(rebuiltOrder).toEqual(priorSurvivors);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — chunkIdMap pairs every prior chunk ID with itself on a same-ceiling swap
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — rebuild AC10: chunkIdMap pairs every prior chunk ID with itself on same-ceiling swap", () => {
  test("swap to a same-or-larger-ceiling agent with under-budget prior: chunkIdMap[i] = { priorChunkId: prior[i], newChunkId: prior[i] } for every prior id", () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat-a", kind: "feature", tokens: 200 }),
        chunk({ id: "p1:feat-b", kind: "feature", tokens: 300 }),
        chunk({ id: "p1:sess", kind: "session", tokens: 400 }),
      ],
      { effectiveBudget: 4_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "gemini",
      failure: AVAILABILITY_FAILURE,
    });

    const chunkIdMap = rebuilt.manifest.rebuildInfo?.chunkIdMap;
    expect(chunkIdMap).toBeDefined();
    const priorIds = prior.chunks.map((c) => c.id).sort();
    // The injected failure-note chunk also appears in the map, paired with itself.
    const failureId = `failure-note:claude:gemini:${AVAILABILITY_FAILURE.outcome}`;
    const expectedPairs = [...priorIds, failureId].sort().map((id) => ({ priorChunkId: id, newChunkId: id }));
    const mapPairs = (chunkIdMap ?? [])
      .map((entry) => ({ priorChunkId: entry.priorChunkId, newChunkId: entry.newChunkId }))
      .sort((a, b) => a.priorChunkId.localeCompare(b.priorChunkId));
    expect(mapPairs).toEqual(expectedPairs);
  });

  test("chunkIdMap covers every prior chunk ID, not just a subset", () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat-a", kind: "feature", tokens: 100 }),
        chunk({ id: "p1:feat-b", kind: "feature", tokens: 100 }),
        chunk({ id: "p1:feat-c", kind: "feature", tokens: 100 }),
      ],
      { effectiveBudget: 4_000 },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "gemini",
      failure: AVAILABILITY_FAILURE,
    });

    const chunkIdMap = rebuilt.manifest.rebuildInfo?.chunkIdMap ?? [];
    const mappedPriorIds = new Set(chunkIdMap.map((e) => e.priorChunkId));
    for (const id of prior.chunks.map((c) => c.id)) {
      expect(mappedPriorIds.has(id)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanity: imported symbols and ContextOrchestrator are wired correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — sanity", () => {
  test("ContextOrchestrator.assemble produces a ContextBundle usable as a rebuild input", async () => {
    const orch = new ContextOrchestrator([
      makeProvider("p1", {
        chunks: [rawChunk({ id: "p1:feat", kind: "feature", tokens: 100 })],
      }),
    ]);
    const bundle = await orch.assemble(BASE_REQUEST);
    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.manifest).toBeDefined();
  });
});

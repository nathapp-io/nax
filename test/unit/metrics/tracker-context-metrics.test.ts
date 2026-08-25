/**
 * AC-18: StoryMetrics.context.providers populated from context manifests.
 *
 * Verifies that collectStoryMetrics() reads on-disk context manifests for the
 * story and aggregates per-provider metrics (tokensProduced, chunksProduced,
 * chunksKept, wallClockMs, timedOut, failed) across all pipeline stages.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeMockRuntime, makeStory, makeTestContext } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import type { ProviderBudgetPressure, PullCallRecord } from "@/context/engine";
import { _manifestStoreDeps } from "@/context/engine/manifest-store";
import type { ContextManifest } from "@/context/engine/types";
import { collectStoryMetrics } from "@/metrics/tracker";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd";

const PROJECT_DIR = "/repo";
const FEATURE = "test-feature";
const STORY_ID = "US-001";

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  const story = makeStory({ id: STORY_ID, status: "passed", passes: true, attempts: 1 });
  const ctx = makeTestContext({
    config: DEFAULT_CONFIG,
    prd: {
      project: "test",
      feature: FEATURE,
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    } satisfies PRD,
    story,
    stories: [story],
    routing: { complexity: "medium", modelTier: "balanced", testStrategy: "test-after", reasoning: "test" },
    workdir: PROJECT_DIR,
    projectDir: PROJECT_DIR,
    ...overrides,
  });
  return Object.assign(ctx, {
    agentResult: { success: true, output: "", estimatedCostUsd: 0.01, durationMs: 5000 },
    runtime: makeMockRuntime(),
  });
}

function makeManifest(overrides?: Partial<ContextManifest>): ContextManifest {
  return {
    requestId: "req-001",
    stage: "execution",
    totalBudgetTokens: 8000,
    usedTokens: 500,
    includedChunks: [],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 50,
    buildMs: 120,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock manifest store deps
// ─────────────────────────────────────────────────────────────────────────────

let origListFeatureDirs: typeof _manifestStoreDeps.listFeatureDirs;
let origListManifestFiles: typeof _manifestStoreDeps.listManifestFiles;
let origFileExists: typeof _manifestStoreDeps.fileExists;
let origReadFile: typeof _manifestStoreDeps.readFile;

function mockManifests(manifests: Record<string, ContextManifest | string>) {
  // manifests: key = "<featureId>/<stage>" → manifest, or pre-serialized JSON
  // text for corrupt-on-disk adversarial cases (the tracker reads manifests as
  // JSON text, so corruption is expressed here as text, not as a typed object).
  _manifestStoreDeps.listFeatureDirs = async () => [FEATURE];
  _manifestStoreDeps.listManifestFiles = async () =>
    Object.keys(manifests)
      .filter((k) => k.startsWith(`${FEATURE}/`))
      .map((k) => `context-manifest-${k.split("/")[1]}.json`);
  _manifestStoreDeps.fileExists = async () => true;
  _manifestStoreDeps.readFile = async (path: string) => {
    const stage = path.replace(/.*context-manifest-/, "").replace(/\.json$/, "");
    const m = manifests[`${FEATURE}/${stage}`];
    return typeof m === "string" ? m : m ? JSON.stringify(m) : "{}";
  };
}

beforeEach(() => {
  origListFeatureDirs = _manifestStoreDeps.listFeatureDirs;
  origListManifestFiles = _manifestStoreDeps.listManifestFiles;
  origFileExists = _manifestStoreDeps.fileExists;
  origReadFile = _manifestStoreDeps.readFile;
});

afterEach(() => {
  _manifestStoreDeps.listFeatureDirs = origListFeatureDirs;
  _manifestStoreDeps.listManifestFiles = origListManifestFiles;
  _manifestStoreDeps.fileExists = origFileExists;
  _manifestStoreDeps.readFile = origReadFile;
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("collectStoryMetrics — AC-18 context.providers", () => {
  test("context is undefined when projectDir is absent", async () => {
    const ctx = makeCtx({ projectDir: undefined } as Partial<PipelineContext>);
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context).toBeUndefined();
  });

  test("context is undefined when no manifests exist", async () => {
    mockManifests({});
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context).toBeUndefined();
  });

  test("populates chunksProduced from providerResults.chunkCount", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 3, durationMs: 50, tokensProduced: 300 },
        ],
        includedChunks: ["static-rules:a:001", "static-rules:b:002", "static-rules:c:003"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["static-rules"]?.chunksProduced).toBe(3);
  });

  test("populates chunksKept by counting included chunks matching provider prefix", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 3, durationMs: 50, tokensProduced: 300 },
          { providerId: "git-history", status: "ok", chunkCount: 2, durationMs: 30, tokensProduced: 150 },
        ],
        includedChunks: [
          "static-rules:a:001",
          "static-rules:b:002",
          "git-history:c:003", // only 1 of 2 git-history chunks kept
        ],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["static-rules"]?.chunksKept).toBe(2);
    expect(metrics.context?.providers["git-history"]?.chunksKept).toBe(1);
  });

  test("populates wallClockMs from providerResults.durationMs", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "code-neighbor", status: "ok", chunkCount: 1, durationMs: 80, tokensProduced: 40 },
        ],
        includedChunks: ["code-neighbor:x:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["code-neighbor"]?.wallClockMs).toBe(80);
  });

  test("timedOut is true when any stage shows timeout for that provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "pull-tool", status: "timeout", chunkCount: 0, durationMs: 5000, tokensProduced: 0 },
        ],
        includedChunks: [],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["pull-tool"]?.timedOut).toBe(true);
    expect(metrics.context?.providers["pull-tool"]?.failed).toBe(false);
  });

  test("failed is true when any stage shows failed for that provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          {
            providerId: "plugin-rag",
            status: "failed",
            chunkCount: 0,
            durationMs: 20,
            tokensProduced: 0,
            error: "oops",
          },
        ],
        includedChunks: [],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["plugin-rag"]?.failed).toBe(true);
    expect(metrics.context?.providers["plugin-rag"]?.timedOut).toBe(false);
  });

  test("aggregates metrics across multiple stages for the same provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 2, durationMs: 40, tokensProduced: 200 },
        ],
        includedChunks: ["static-rules:a:001", "static-rules:b:002"],
      }),
      [`${FEATURE}/tdd-implementer`]: makeManifest({
        stage: "tdd-implementer",
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 2, durationMs: 35, tokensProduced: 200 },
        ],
        includedChunks: ["static-rules:a:001"], // only 1 kept in this stage
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    const p = metrics.context?.providers["static-rules"];
    expect(p?.chunksProduced).toBe(4); // 2 + 2
    expect(p?.chunksKept).toBe(3); // 2 + 1
    expect(p?.wallClockMs).toBe(75); // 40 + 35
    expect(p?.tokensProduced).toBe(400); // 200 + 200
  });

  test("tokensProduced sums across stages", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "code-neighbor", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 120 },
        ],
        includedChunks: ["code-neighbor:x:001"],
      }),
      [`${FEATURE}/verify`]: makeManifest({
        providerResults: [
          { providerId: "code-neighbor", status: "ok", chunkCount: 1, durationMs: 8, tokensProduced: 100 },
        ],
        includedChunks: ["code-neighbor:x:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["code-neighbor"]?.tokensProduced).toBe(220);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003: floor overage in StoryMetrics.context (AC-2, AC-3)
// ─────────────────────────────────────────────────────────────────────────────

describe("collectStoryMetrics — US-003 context.floorOverage (AC-2, AC-3)", () => {
  test("AC-2: context.floorOverage records the *delta* over the effective budget (not the sum of overflowing chunks)", async () => {
    // Two floor chunks totaling 13,000 tokens packed against an effective
    // budget of 8,000. The overage is 13,000 - 8,000 = 5,000 — NOT the sum
    // of the floor chunks themselves. A test that asserted the floor total
    // would overstate the overage by exactly the budget amount.
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        totalBudgetTokens: 8_000,
        effectiveBudget: 8_000,
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 2, durationMs: 50, tokensProduced: 13_000 },
        ],
        includedChunks: ["static-rules:a:001", "static-rules:b:002"],
        floorItems: ["static-rules:a:001", "static-rules:b:002"],
        floorOverageItems: ["static-rules:a:001", "static-rules:b:002"],
        chunkTokens: { "static-rules:a:001": 9_000, "static-rules:b:002": 4_000 },
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.floorOverage).toBeDefined();
    expect(metrics.context?.floorOverage?.overageTokens).toBe(5_000);
  });

  test("AC-3: context.floorOverage records 0 overage tokens when floor chunks fit within effective budget", async () => {
    // Floor items are present but the sum (200) is well under the
    // effectiveBudget (1,000); floorOverageItems is absent on the manifest.
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        totalBudgetTokens: 1_000,
        effectiveBudget: 1_000,
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 200 },
        ],
        includedChunks: ["static-rules:a:001"],
        floorItems: ["static-rules:a:001"],
        // no floorOverageItems — floor fit within budget
        chunkTokens: { "static-rules:a:001": 200 },
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.floorOverage).toBeDefined();
    expect(metrics.context?.floorOverage?.overageTokens).toBe(0);
  });

  test("context.floorOverage aggregates per-stage deltas across multiple stages (does NOT sum floor totals)", async () => {
    // Two stages, each contributing a 1,000-token overage:
    //   stage A: floor=5,000, effective=4,000 → overage=1,000
    //   stage B: floor=7,000, effective=6,000 → overage=1,000
    // Total overage = 2,000. A naive "sum floor tokens" would report 12,000.
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        totalBudgetTokens: 4_000,
        effectiveBudget: 4_000,
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 5_000 },
        ],
        includedChunks: ["static-rules:a:001"],
        floorItems: ["static-rules:a:001"],
        floorOverageItems: ["static-rules:a:001"],
        chunkTokens: { "static-rules:a:001": 5_000 },
      }),
      [`${FEATURE}/verify`]: makeManifest({
        stage: "verify",
        totalBudgetTokens: 6_000,
        effectiveBudget: 6_000,
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 7_000 },
        ],
        includedChunks: ["static-rules:b:002"],
        floorItems: ["static-rules:b:002"],
        floorOverageItems: ["static-rules:b:002"],
        chunkTokens: { "static-rules:b:002": 7_000 },
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.floorOverage?.overageTokens).toBe(2_000);
  });

  test("manifest without effectiveBudget contributes 0 (legacy write)", async () => {
    // Manifests written before US-003 lack effectiveBudget; they must not
    // contribute a wrong number based on totalBudgetTokens alone.
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        // totalBudgetTokens: 8_000, effectiveBudget omitted
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 9_000 },
        ],
        includedChunks: ["static-rules:a:001"],
        floorItems: ["static-rules:a:001"],
        floorOverageItems: ["static-rules:a:001"],
        chunkTokens: { "static-rules:a:001": 9_000 },
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.floorOverage?.overageTokens).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004: provider budget pressure in StoryMetrics.context.providers
// ─────────────────────────────────────────────────────────────────────────────

describe("collectStoryMetrics — US-004 context.providers[].budgetPressure", () => {
  function providerResultWithPressure(pressure: ProviderBudgetPressure) {
    return [
      {
        providerId: "static-rules",
        status: "ok" as const,
        chunkCount: 1,
        durationMs: 10,
        tokensProduced: 100,
        budgetPressure: pressure,
      },
    ];
  }

  test("AC-3: budgetPressure.overageTokens sums across stage manifests for the same provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: providerResultWithPressure({
          overageTokens: 200,
          droppedCount: 0,
          droppedTokens: 0,
          droppedIds: [],
        }),
        includedChunks: ["static-rules:a:001"],
      }),
      [`${FEATURE}/verify`]: makeManifest({
        stage: "verify",
        providerResults: providerResultWithPressure({
          overageTokens: 300,
          droppedCount: 0,
          droppedTokens: 0,
          droppedIds: [],
        }),
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.context?.providers["static-rules"]?.budgetPressure?.overageTokens).toBe(500);
  });

  test("AC-4: budgetPressure.droppedCount sums across stage manifests for the same provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: providerResultWithPressure({
          overageTokens: 0,
          droppedCount: 3,
          droppedTokens: 0,
          droppedIds: [],
        }),
        includedChunks: ["static-rules:a:001"],
      }),
      [`${FEATURE}/verify`]: makeManifest({
        stage: "verify",
        providerResults: providerResultWithPressure({
          overageTokens: 0,
          droppedCount: 7,
          droppedTokens: 0,
          droppedIds: [],
        }),
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.context?.providers["static-rules"]?.budgetPressure?.droppedCount).toBe(10);
  });

  test("AC-5: budgetPressure.droppedTokens sums across stage manifests for the same provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: providerResultWithPressure({
          overageTokens: 0,
          droppedCount: 0,
          droppedTokens: 1_000,
          droppedIds: [],
        }),
        includedChunks: ["static-rules:a:001"],
      }),
      [`${FEATURE}/verify`]: makeManifest({
        stage: "verify",
        providerResults: providerResultWithPressure({
          overageTokens: 0,
          droppedCount: 0,
          droppedTokens: 2_000,
          droppedIds: [],
        }),
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.context?.providers["static-rules"]?.budgetPressure?.droppedTokens).toBe(3_000);
  });

  test("AC-6: budgetPressure is omitted when the provider's manifest entry carries no budgetPressure field", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 100 },
        ],
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.context?.providers["static-rules"]?.budgetPressure).toBeUndefined();
  });

  test("AC-7: a legacy manifest with no budgetPressure on any provider yields budgetPressure=undefined for every provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 100 },
          { providerId: "git-history", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 50 },
        ],
        includedChunks: ["static-rules:a:001", "git-history:b:002"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.context?.providers["static-rules"]?.budgetPressure).toBeUndefined();
    expect(metrics.context?.providers["git-history"]?.budgetPressure).toBeUndefined();
  });

  test("AC-8: the aggregated budgetPressure never carries a droppedIds property, even if the stored manifest had one", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: providerResultWithPressure({
          overageTokens: 50,
          droppedCount: 2,
          droppedTokens: 200,
          droppedIds: ["id1", "id2"],
        }),
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    const pressure = metrics.context?.providers["static-rules"]?.budgetPressure;

    expect(pressure).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(pressure ?? {}, "droppedIds")).toBe(false);
    expect(pressure?.overageTokens).toBe(50);
    expect(pressure?.droppedCount).toBe(2);
    expect(pressure?.droppedTokens).toBe(200);
  });

  // Adversarial review — malformed persisted JSON must not corrupt aggregates
  test("malformed pressure (NaN, negative, non-number, missing field) contributes zero, not a corrupted value", async () => {
    // Mirrors AC-7's "legacy contributes zero rather than inferring" rule: a
    // stage manifest whose pressure fields are not finite nonnegative numbers
    // contributes zero for that field, never NaN/negative/string.
    // Corruption is expressed as raw manifest JSON — the disk form the tracker
    // actually reads — not as a strong-typed object. (NaN serializes to null.)
    mockManifests({
      [`${FEATURE}/execution`]: JSON.stringify({
        ...makeManifest(),
        includedChunks: ["static-rules:a:001"],
        providerResults: [
          {
            providerId: "static-rules",
            status: "ok",
            chunkCount: 1,
            durationMs: 10,
            tokensProduced: 100,
            budgetPressure: { overageTokens: Number.NaN, droppedCount: -5, droppedTokens: "lots" },
          },
        ],
      }),
      [`${FEATURE}/verify`]: JSON.stringify({
        ...makeManifest(),
        stage: "verify",
        includedChunks: ["static-rules:a:001"],
        providerResults: [
          {
            providerId: "static-rules",
            status: "ok",
            chunkCount: 1,
            durationMs: 10,
            tokensProduced: 100,
            // droppedCount missing entirely — should be treated as 0
            budgetPressure: { overageTokens: 100, droppedTokens: 50 },
          },
        ],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    const pressure = metrics.context?.providers["static-rules"]?.budgetPressure;

    expect(pressure).toBeDefined();
    expect(pressure?.overageTokens).toBe(100); // invalid (NaN serialized to null)→0, then +100
    expect(pressure?.droppedCount).toBe(0); // -5→0, missing→0
    expect(pressure?.droppedTokens).toBe(50); // "lots"→0, then +50
    // All fields must remain finite numbers, never NaN / Infinity / string
    expect(Number.isFinite(pressure?.overageTokens)).toBe(true);
    expect(Number.isFinite(pressure?.droppedCount)).toBe(true);
    expect(Number.isFinite(pressure?.droppedTokens)).toBe(true);
  });

  test("a manifest with an entirely non-object budgetPressure contributes zero (not a thrown error)", async () => {
    // Defense against hand-edited / corrupt JSON: budgetPressure is not an
    // object at all — aggregate stays clean (no pressure surfaced) rather
    // than crashing or producing NaN.
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          {
            providerId: "static-rules",
            status: "ok" as const,
            chunkCount: 1,
            durationMs: 10,
            tokensProduced: 100,
            budgetPressure: JSON.parse('"not-an-object"'),
          },
        ],
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.context?.providers["static-rules"]?.budgetPressure).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spec AC-18: StoryMetrics.context.pullCalls tracks invocations. Sourced from
// the run-scoped counter threaded through CallContext, so it reflects what the
// agent actually asked for rather than what was offered.
// ─────────────────────────────────────────────────────────────────────────────

describe("collectStoryMetrics — context.pullCalls (AC-18)", () => {
  const CALL = {
    tool: "query_neighbor",
    query: "src/a.ts",
    at: "2026-08-03T00:00:00.000Z",
    tokensReturned: 42,
    chunkIds: ["code-neighbor:a:001"],
  };

  function ctxWithCalls(calls: PullCallRecord[]) {
    const ctx = makeCtx();
    ctx.contextToolRunCounter = { count: calls.length, calls };
    return ctx as never;
  }

  test("surfaces the recorded invocations on the story's context metrics", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          { providerId: "code-neighbor", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 100 },
        ],
        includedChunks: ["code-neighbor:a:001"],
      }),
    });

    const metrics = await collectStoryMetrics(ctxWithCalls([CALL]), new Date().toISOString());

    expect(metrics.context?.pullCalls).toHaveLength(1);
    expect(metrics.context?.pullCalls?.[0]).toMatchObject({ tool: "query_neighbor", query: "src/a.ts" });
  });

  test("omits pullCalls entirely when the story made none", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          { providerId: "code-neighbor", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 100 },
        ],
        includedChunks: ["code-neighbor:a:001"],
      }),
    });

    const metrics = await collectStoryMetrics(ctxWithCalls([]), new Date().toISOString());

    expect(metrics.context?.pullCalls).toBeUndefined();
  });
});

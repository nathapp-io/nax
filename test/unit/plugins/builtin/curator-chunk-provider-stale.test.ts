/**
 * US-002 — Carry provider and staleness axes onto chunk observations.
 *
 * Asserts the wiring between `collectObservations` and `runHeuristics`:
 *
 *  - `collectObservations` projects the manifest's `chunkProviders` map onto
 *    both `chunk-included` and `chunk-excluded` observation payloads (when
 *    present), and projects the per-entry `stale` flag onto
 *    `chunk-excluded` payloads (when present).
 *  - `runHeuristics` (specifically `h5StaleChunk`) fires on
 *    `payload.stale === true`, NOT on `payload.reason === "stale"`.
 *  - The two compose without a hand-built observation fixture between the
 *    producer (collector) and the consumer (heuristic).
 */

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeNaxConfig, withTempDir } from "@test/helpers";
import type { CuratorPostRunContext, Observation } from "@/plugins/builtin/curator";
import { collectObservations } from "@/plugins/builtin/curator";
import type { CuratorThresholds } from "@/plugins/builtin/curator/heuristics";
import { runHeuristics } from "@/plugins/builtin/curator/heuristics";

/**
 * Run `body` against a temp workdir that has the .nax/features layout for a
 * "feat-auth" / "US-001" story whose `context-manifest-review.json` carries
 * the supplied manifest.
 *
 * The temp root is auto-removed via `withTempDir` once `body` resolves —
 * otherwise repeated test runs would pile up fixture trees in $TMPDIR.
 *
 * `body` receives the `workdir` (parent of `.nax/`) and a fully-formed
 * `CuratorPostRunContext` pointed at it.
 */
async function withManifestFixture(
  manifest: Record<string, unknown>,
  opts: { runId?: string } | undefined,
  body: (workdir: string, context: CuratorPostRunContext) => Promise<void>,
): Promise<void> {
  await withTempDir(async (root) => {
    const workdir = join(root, "work");
    const storyDir = join(workdir, ".nax", "features", "feat-auth", "stories", "US-001");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "context-manifest-review.json"), JSON.stringify(manifest));

    const context: CuratorPostRunContext = {
      runId: opts?.runId ?? "run-us002",
      feature: "feat-auth",
      workdir,
      prdPath: join(workdir, ".nax", "features", "feat-auth", "prd.json"),
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 0,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: makeNaxConfig(),
      outputDir: join(root, "out"),
      globalDir: join(root, "global"),
      projectKey: "test-project-us002",
      curatorRollupPath: join(root, "rollup.jsonl"),
    };

    await body(workdir, context);
  });
}

const DEFAULT_THRESHOLDS: CuratorThresholds = {
  repeatedFinding: 2,
  emptyKeyword: 2,
  rectifyAttempts: 3,
  escalationChain: 2,
  staleChunkRuns: 2,
  unchangedOutcome: 3,
};

// ---------------------------------------------------------------------------
// AC-1: chunkProviders entry on an included chunk emits `provider` on the
// chunk-included observation payload.
// ---------------------------------------------------------------------------

describe("collectObservations — chunk-included provider projection (US-002 AC-1)", () => {
  test("emits provider on chunk-included when chunkProviders maps the chunk ID to 'static-rules'", async () => {
    await withManifestFixture(
      {
        stage: "review",
        includedChunks: ["static-rules:abc"],
        excludedChunks: [],
        providerResults: [],
        chunkSummaries: { "static-rules:abc": "Auth rules" },
        chunkProviders: { "static-rules:abc": "static-rules" },
      },
      undefined,
      async (_workdir, context) => {
        const observations = await collectObservations(context);
        const included = observations.filter((o) => o.kind === "chunk-included");
        expect(included).toHaveLength(1);
        expect(included[0].payload.chunkId).toBe("static-rules:abc");
        expect(included[0].payload.provider).toBe("static-rules");
      },
    );
  });

  test("AC-2: omits provider on chunk-included when no chunkProviders entry exists", async () => {
    await withManifestFixture(
      {
        stage: "review",
        includedChunks: ["feature-context:abc"],
        excludedChunks: [],
        providerResults: [],
        chunkSummaries: { "feature-context:abc": "Auth context" },
        // No chunkProviders map at all.
      },
      undefined,
      async (_workdir, context) => {
        const observations = await collectObservations(context);
        const included = observations.filter((o) => o.kind === "chunk-included");
        expect(included).toHaveLength(1);
        expect(included[0].payload.chunkId).toBe("feature-context:abc");
        // Missing entry → no provider key, no placeholder.
        expect("provider" in included[0].payload).toBe(false);
      },
    );
  });

  test("emits provider only for chunks present in chunkProviders when the map is partial", async () => {
    await withManifestFixture(
      {
        stage: "review",
        includedChunks: ["static-rules:abc", "feature-context:def"],
        excludedChunks: [],
        providerResults: [],
        chunkSummaries: { "static-rules:abc": "Rules", "feature-context:def": "Ctx" },
        chunkProviders: { "static-rules:abc": "static-rules" },
      },
      undefined,
      async (_workdir, context) => {
        const observations = await collectObservations(context);
        const included = observations.filter((o) => o.kind === "chunk-included");
        expect(included).toHaveLength(2);
        const withProvider = included.find((o) => o.payload.chunkId === "static-rules:abc");
        const withoutProvider = included.find((o) => o.payload.chunkId === "feature-context:def");
        expect(withProvider?.payload.provider).toBe("static-rules");
        expect(withoutProvider).toBeDefined();
        if (withoutProvider) {
          expect("provider" in withoutProvider.payload).toBe(false);
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// AC-3: chunkProviders entry on an excluded chunk emits `provider` on the
// chunk-excluded observation payload.
// ---------------------------------------------------------------------------

describe("collectObservations — chunk-excluded provider projection (US-002 AC-3)", () => {
  test("emits provider on chunk-excluded when chunkProviders maps the chunk ID to 'git-history'", async () => {
    await withManifestFixture(
      {
        stage: "review",
        includedChunks: [],
        excludedChunks: [{ id: "git-history:abc", reason: "below-min-score" }],
        providerResults: [],
        chunkSummaries: { "git-history:abc": "Recent diff" },
        chunkProviders: { "git-history:abc": "git-history" },
      },
      undefined,
      async (_workdir, context) => {
        const observations = await collectObservations(context);
        const excluded = observations.filter((o) => o.kind === "chunk-excluded");
        expect(excluded).toHaveLength(1);
        expect(excluded[0].payload.chunkId).toBe("git-history:abc");
        expect(excluded[0].payload.provider).toBe("git-history");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// AC-4 / AC-5: excludedChunks entry's `stale` flag is projected onto the
// chunk-excluded observation payload.
// ---------------------------------------------------------------------------

describe("collectObservations — chunk-excluded stale flag projection (US-002 AC-4/AC-5)", () => {
  test("AC-4: emits stale=true on chunk-excluded when manifest entry carries stale=true", async () => {
    await withManifestFixture(
      {
        stage: "review",
        includedChunks: [],
        excludedChunks: [{ id: "rules:def", reason: "budget", stale: true }],
        providerResults: [],
        chunkSummaries: { "rules:def": "Rules" },
      },
      undefined,
      async (_workdir, context) => {
        const observations = await collectObservations(context);
        const excluded = observations.filter((o) => o.kind === "chunk-excluded");
        expect(excluded).toHaveLength(1);
        expect(excluded[0].payload.chunkId).toBe("rules:def");
        expect(excluded[0].payload.stale).toBe(true);
        // The mechanical cause is preserved alongside the staleness signal.
        expect(excluded[0].payload.reason).toBe("budget");
      },
    );
  });

  test("AC-5: emits stale=false on chunk-excluded when manifest entry carries stale=false", async () => {
    await withManifestFixture(
      {
        stage: "review",
        includedChunks: [],
        excludedChunks: [{ id: "rules:def", reason: "budget", stale: false }],
        providerResults: [],
        chunkSummaries: { "rules:def": "Rules" },
      },
      undefined,
      async (_workdir, context) => {
        const observations = await collectObservations(context);
        const excluded = observations.filter((o) => o.kind === "chunk-excluded");
        expect(excluded).toHaveLength(1);
        expect(excluded[0].payload.stale).toBe(false);
      },
    );
  });

  test("emits chunk-excluded without stale key when manifest entry omits it", async () => {
    await withManifestFixture(
      {
        stage: "review",
        includedChunks: [],
        excludedChunks: [{ id: "rules:def", reason: "budget" }],
        providerResults: [],
        chunkSummaries: { "rules:def": "Rules" },
      },
      undefined,
      async (_workdir, context) => {
        const observations = await collectObservations(context);
        const excluded = observations.filter((o) => o.kind === "chunk-excluded");
        expect(excluded).toHaveLength(1);
        // Absent → no stale key.
        expect("stale" in excluded[0].payload).toBe(false);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// AC-6 / AC-7: h5StaleChunk fires on `payload.stale === true` (not on the
// legacy `payload.reason === "stale"` heuristic).
// ---------------------------------------------------------------------------

describe("h5StaleChunk — fires on payload.stale === true (US-002 AC-6/AC-7)", () => {
  test("AC-6: emits an H5 proposal when the same chunk ID carries payload.stale=true across distinct runs == threshold", () => {
    const obs = [
      makeExcluded("rules:def", "run-1", "story-1", "budget", true),
      makeExcluded("rules:def", "run-2", "story-1", "budget", true),
    ];
    const proposals = runHeuristics(obs, { ...DEFAULT_THRESHOLDS, staleChunkRuns: 2 });
    const h5 = proposals.find((p) => p.id === "H5");
    expect(h5).toBeDefined();
    expect(h5?.description).toContain("rules:def");
    expect(h5?.target.action).toBe("drop");
  });

  test("AC-7: emits NO H5 proposal when the same chunk ID carries payload.stale=false across the same number of distinct runs", () => {
    const obs = [
      makeExcluded("rules:def", "run-1", "story-1", "budget", false),
      makeExcluded("rules:def", "run-2", "story-1", "budget", false),
    ];
    const proposals = runHeuristics(obs, { ...DEFAULT_THRESHOLDS, staleChunkRuns: 2 });
    expect(proposals.find((p) => p.id === "H5")).toBeUndefined();
  });

  test("does not fire on the legacy `reason: 'stale'` shape (the obsolete trigger)", () => {
    const obs = [
      makeExcludedLegacyReason("rules:def", "run-1", "story-1", "stale"),
      makeExcludedLegacyReason("rules:def", "run-2", "story-1", "stale"),
    ];
    const proposals = runHeuristics(obs, { ...DEFAULT_THRESHOLDS, staleChunkRuns: 2 });
    // The new heuristic must key on `payload.stale === true`, not on
    // `payload.reason === "stale"`, since staleness is an orthogonal axis.
    expect(proposals.find((p) => p.id === "H5")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-8: collectObservations → runHeuristics end-to-end, no hand-built
// observation fixture between producer and consumer.
// ---------------------------------------------------------------------------

describe("end-to-end — collectObservations → runHeuristics (US-002 AC-8)", () => {
  test("emits an H5 proposal without a hand-built observation fixture", async () => {
    const threshold = 2;

    // Two distinct runs emitting stale=true on the same chunk ID. The
    // threshold is met via real collector output — no in-memory fixture.
    // Each run lives in its own auto-cleaned temp dir; observations are
    // collected INSIDE the withTempDir window because the manifest file on
    // disk is what `collectObservations` reads, and that file evaporates
    // when the temp dir tears down.
    const perRunObs: Observation[][] = [];
    for (let i = 0; i < threshold; i += 1) {
      await withManifestFixture(
        {
          stage: "review",
          includedChunks: [],
          excludedChunks: [{ id: "rules:def", reason: "budget", stale: true }],
          providerResults: [],
          chunkSummaries: { "rules:def": "Rules" },
        },
        { runId: `run-e2e-${i + 1}` },
        async (_workdir, context) => {
          perRunObs.push(await collectObservations(context));
        },
      );
    }

    const allObs = perRunObs.flat();

    const proposals = runHeuristics(allObs, { ...DEFAULT_THRESHOLDS, staleChunkRuns: threshold });
    const h5 = proposals.find((p) => p.id === "H5");
    expect(h5).toBeDefined();
    expect(h5?.description).toContain("rules:def");
    // Cross-run grouping by chunkId uses the distinct runIds.
    expect(h5?.evidence).toContain(`${threshold} runs`);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ExcludedObservation {
  schemaVersion: 3;
  projectKey: string;
  runId: string;
  featureId: string;
  storyId: string;
  stage: string;
  ts: string;
  kind: "chunk-excluded";
  payload: {
    chunkId: string;
    label: string;
    reason?: string;
    provider?: string;
    stale?: boolean;
  };
}

function makeExcluded(
  chunkId: string,
  runId: string,
  storyId: string,
  reason: string,
  stale: boolean,
): ExcludedObservation {
  return {
    schemaVersion: 3,
    projectKey: "test-proj",
    runId,
    featureId: "feat-1",
    storyId,
    stage: "context",
    ts: "2026-05-04T00:00:00Z",
    kind: "chunk-excluded",
    payload: { chunkId, label: chunkId, reason, stale },
  };
}

/**
 * The pre-US-002 fixture shape: H5 fired on `payload.reason === "stale"`.
 * Kept here so the "does not fire" assertion is explicit about what the
 * new heuristic does NOT match — the regression direction matters.
 */
function makeExcludedLegacyReason(
  chunkId: string,
  runId: string,
  storyId: string,
  reason: string,
): ExcludedObservation {
  return {
    schemaVersion: 3,
    projectKey: "test-proj",
    runId,
    featureId: "feat-1",
    storyId,
    stage: "context",
    ts: "2026-05-04T00:00:00Z",
    kind: "chunk-excluded",
    payload: { chunkId, label: chunkId, reason },
  };
}

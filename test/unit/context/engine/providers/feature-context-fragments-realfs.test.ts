/**
 * Fragment read-back — real-filesystem behaviour.
 *
 * The sibling `feature-context-fragments.test.ts` stubs `readFragment` and
 * `listFragmentStoryIds`, and its stubs ignore the `projectDir` argument
 * entirely. That is why the read path could ship broken: the provider passed
 * `${repoRoot}/.nax` as the store's `projectDir`, but the store owns the
 * `.nax` segment itself (`fragmentPath` -> `featureDir` -> `featuresDir`), so
 * every read resolved to `<repoRoot>/.nax/.nax/features/...` and found
 * nothing. Capture and read were tested on opposite sides of a stub, so the
 * path contract between them was untested by construction.
 *
 * These tests therefore write fragments with the REAL `writeFragment` and read
 * them back through the REAL provider against a REAL temp directory. Only
 * `createV1Provider` is stubbed, to keep the legacy context.md path out of the
 * assertions. Do not stub the fragment store here — that would reintroduce the
 * blind spot this file exists to cover.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NaxConfig } from "@/config/types";
import { FeatureContextProviderV2, _featureContextV2Deps } from "@/context/engine";
import type { ContextRequest, RawChunk } from "@/context/engine/types";
import { renderFragmentBody, writeFragment } from "@/context/fragments";
import type { UserStory } from "@/prd";
import { cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";

const FEATURE_ID = "feat-readback";
const FRAGMENT_MAX_TOKENS = 400;

let repoRoot: string;

type DepsShape = typeof _featureContextV2Deps;
let origCreateV1Provider: DepsShape["createV1Provider"];

beforeEach(() => {
  repoRoot = makeTempDir();
  origCreateV1Provider = _featureContextV2Deps.createV1Provider;
  // The legacy context.md path is irrelevant here and would otherwise touch
  // disk; every assertion below filters on the `feature-fragment:` prefix.
  _featureContextV2Deps.createV1Provider = (() =>
    ({
      getContext: async () => null,
    }) as ReturnType<DepsShape["createV1Provider"]>) as DepsShape["createV1Provider"];
});

afterEach(() => {
  _featureContextV2Deps.createV1Provider = origCreateV1Provider;
  cleanupTempDir(repoRoot);
});

function makeFragmentsConfig(overrides: { decay?: number; enabled?: boolean } = {}): NaxConfig {
  return {
    context: {
      v2: {
        fragments: {
          enabled: overrides.enabled ?? true,
          decay: overrides.decay ?? 0.6,
          maxTokens: FRAGMENT_MAX_TOKENS,
          extractor: "deterministic",
        },
      },
    },
  } as unknown as NaxConfig;
}

function storyWith(id: string, dependencies: readonly string[] = []): UserStory {
  return makeStory({ id, dependencies: [...dependencies] });
}

/** Write a real prd.json where the provider's `featurePrdPath` expects it. */
async function writePRD(stories: readonly UserStory[]): Promise<void> {
  const dir = join(repoRoot, ".nax", "features", FEATURE_ID);
  await mkdir(dir, { recursive: true });
  const prd = makePRD({ feature: FEATURE_ID, userStories: stories as UserStory[] });
  await writeFile(join(dir, "prd.json"), JSON.stringify(prd, null, 2), "utf-8");
}

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-002",
    featureId: FEATURE_ID,
    repoRoot,
    packageDir: repoRoot,
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

function fragmentChunks(chunks: RawChunk[]): RawChunk[] {
  return chunks.filter((c) => c.id.startsWith("feature-fragment:"));
}

describe("FeatureContextProviderV2 fragment read-back (real fs)", () => {
  test("reads back a fragment written by the real capture path", async () => {
    // Capture exactly as completionStage does: projectDir is the repo root,
    // and the store appends the `.nax/features/<id>/fragments` segments.
    const body = renderFragmentBody(
      "US-001",
      "Resolve profile contestants",
      ["Given a profile name, when resolved, then the overlay is merged"],
      ["src/bakeoff/preflight.ts"],
    );
    await writeFragment(repoRoot, FEATURE_ID, "US-001", body, FRAGMENT_MAX_TOKENS);
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"])]);

    const provider = new FeatureContextProviderV2(storyWith("US-002", ["US-001"]), makeFragmentsConfig());
    const result = await provider.fetch(makeRequest());

    const fragments = fragmentChunks(result.chunks);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.id).toBe("feature-fragment:US-001");
    expect(fragments[0]?.content).toContain("src/bakeoff/preflight.ts");
  });

  test("scores a transitive dependency by distance", async () => {
    for (const id of ["US-001", "US-002"]) {
      await writeFragment(
        repoRoot,
        FEATURE_ID,
        id,
        renderFragmentBody(id, `story ${id}`, ["ac"], [`src/${id}.ts`]),
        FRAGMENT_MAX_TOKENS,
      );
    }
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"]), storyWith("US-003", ["US-002"])]);

    const provider = new FeatureContextProviderV2(storyWith("US-003", ["US-002"]), makeFragmentsConfig({ decay: 0.5 }));
    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    const byId = new Map(fragmentChunks(result.chunks).map((c) => [c.id, c]));
    expect(byId.get("feature-fragment:US-002")?.rawScore).toBeCloseTo(0.5, 10);
    expect(byId.get("feature-fragment:US-001")?.rawScore).toBeCloseTo(0.25, 10);
  });

  test("bounds the fragment set by token budget, keeping the nearest dependencies", async () => {
    // Fragments are floor-kind, so nothing downstream can drop them; the
    // provider's own bound is the only thing between a long dependency chain
    // and an unmetered injection. A 2_000-token stage yields a 400-token
    // fragment budget, so only the two nearest of four ~143-token fragments
    // survive (2 x 143 = 286 fits; a third would reach 429).
    const filler = "src/some/module/with/a/reasonably/long/path.ts";
    const chain = ["US-001", "US-002", "US-003", "US-004"];
    for (const id of chain) {
      await writeFragment(
        repoRoot,
        FEATURE_ID,
        id,
        renderFragmentBody(
          id,
          `story ${id}`,
          [`ac for ${id}`],
          Array.from({ length: 10 }, () => filler),
        ),
        FRAGMENT_MAX_TOKENS,
      );
    }
    await writePRD([
      storyWith("US-001"),
      storyWith("US-002", ["US-001"]),
      storyWith("US-003", ["US-002"]),
      storyWith("US-004", ["US-003"]),
      storyWith("US-005", ["US-004"]),
    ]);

    const provider = new FeatureContextProviderV2(storyWith("US-005", ["US-004"]), makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-005", budgetTokens: 2_000 }));

    const fragments = fragmentChunks(result.chunks);
    const totalTokens = fragments.reduce((sum, c) => sum + c.tokens, 0);

    expect(fragments.map((c) => c.id)).toEqual(["feature-fragment:US-004", "feature-fragment:US-003"]);
    expect(totalTokens).toBeLessThanOrEqual(400);
  });

  test("never drops the nearest fragment, even when the stage budget is tiny", async () => {
    // Guards the `Math.max(maxTokens, share)` floor: a small budget must
    // degrade to "nearest only", never to silently nothing.
    await writeFragment(
      repoRoot,
      FEATURE_ID,
      "US-001",
      renderFragmentBody("US-001", "story US-001", ["ac"], ["src/a.ts"]),
      FRAGMENT_MAX_TOKENS,
    );
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"])]);

    const provider = new FeatureContextProviderV2(storyWith("US-002", ["US-001"]), makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ budgetTokens: 10 }));

    expect(fragmentChunks(result.chunks).map((c) => c.id)).toEqual(["feature-fragment:US-001"]);
  });

  test("emits nothing when the feature has no fragments on disk", async () => {
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"])]);

    const provider = new FeatureContextProviderV2(storyWith("US-002", ["US-001"]), makeFragmentsConfig());
    const result = await provider.fetch(makeRequest());

    expect(fragmentChunks(result.chunks)).toHaveLength(0);
  });
});

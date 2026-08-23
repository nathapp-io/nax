/**
 * query_feature_context pull tool — fragment reachability.
 *
 * The push path derives `featureId` from `ctx.featureDir` and sets it on the
 * ContextRequest; the pull path built its own request without one, and
 * `collectFragmentChunks` early-returns on `!request.featureId`. So the pull
 * tool was fragment-blind even after the read path's store lookup was fixed
 * (#1601) — an agent that asked for its dependencies' context got the
 * context.md entries and nothing else.
 *
 * `featureId` now rides on the ContextBundle (like `agentId`), which is
 * already threaded into the tool runtime, so no new plumbing crosses
 * build-hop-callback.
 *
 * Real filesystem, real fragment store — the same reason as
 * feature-context-fragments-realfs.test.ts: stubbing the store is what let
 * the original path defect ship.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextToolRuntimeConfig } from "@/config/selectors";
import { PullToolBudget, createRunCallCounter, handleQueryFeatureContext } from "@/context/engine";
import { _featureContextV2Deps } from "@/context/engine";
import { renderFragmentBody, writeFragment } from "@/context/fragments";
import type { UserStory } from "@/prd";
import { cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";

const FEATURE_ID = "feat-pull";
const FRAGMENT_MAX_TOKENS = 400;

let repoRoot: string;

type DepsShape = typeof _featureContextV2Deps;
let origCreateV1Provider: DepsShape["createV1Provider"];

beforeEach(() => {
  repoRoot = makeTempDir();
  origCreateV1Provider = _featureContextV2Deps.createV1Provider;
  _featureContextV2Deps.createV1Provider = (() =>
    ({
      getContext: async () => null,
    }) as ReturnType<DepsShape["createV1Provider"]>) as DepsShape["createV1Provider"];
});

afterEach(() => {
  _featureContextV2Deps.createV1Provider = origCreateV1Provider;
  cleanupTempDir(repoRoot);
});

function fragmentsConfig(): ContextToolRuntimeConfig {
  return {
    context: {
      v2: {
        fragments: { enabled: true, decay: 0.6, maxTokens: FRAGMENT_MAX_TOKENS, extractor: "deterministic" },
      },
    },
  } as unknown as ContextToolRuntimeConfig;
}

function storyWith(id: string, dependencies: readonly string[] = []): UserStory {
  return makeStory({ id, dependencies: [...dependencies] });
}

async function writePRD(stories: readonly UserStory[]): Promise<void> {
  const dir = join(repoRoot, ".nax", "features", FEATURE_ID);
  await mkdir(dir, { recursive: true });
  const prd = makePRD({ feature: FEATURE_ID, userStories: stories as UserStory[] });
  await writeFile(join(dir, "prd.json"), JSON.stringify(prd, null, 2), "utf-8");
}

async function seedFragment(storyId: string, filePath: string): Promise<void> {
  await writeFragment(
    repoRoot,
    FEATURE_ID,
    storyId,
    renderFragmentBody(storyId, `story ${storyId}`, ["an acceptance criterion"], [filePath]),
    FRAGMENT_MAX_TOKENS,
  );
}

describe("handleQueryFeatureContext — fragments", () => {
  test("returns a dependency's fragment when the feature is known", async () => {
    await seedFragment("US-001", "src/target/module.ts");
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"])]);

    const output = await handleQueryFeatureContext(
      {},
      storyWith("US-002", ["US-001"]),
      fragmentsConfig(),
      repoRoot,
      new PullToolBudget(10, 100, createRunCallCounter()),
      2_000,
      FEATURE_ID,
    );

    expect(output).toContain("src/target/module.ts");
  });

  test("returns no fragment content when the feature is unknown", async () => {
    // Guards the early return rather than pretending it cannot happen: a
    // caller with no featureId must degrade quietly, not throw.
    await seedFragment("US-001", "src/target/module.ts");
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"])]);

    const output = await handleQueryFeatureContext(
      {},
      storyWith("US-002", ["US-001"]),
      fragmentsConfig(),
      repoRoot,
      new PullToolBudget(10, 100, createRunCallCounter()),
      2_000,
    );

    expect(output).not.toContain("src/target/module.ts");
  });
});

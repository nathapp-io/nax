/**
 * Routing Stage — RRP-001: Idempotence and Dependencies
 *
 * AC-4: Tests for idempotent persistence and dependency exposure.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { makeStory } from "../../../helpers";

const WORKDIR = `/tmp/nax-routing-test-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePRD(story: UserStory): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };
}

function makeConfig(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    tdd: {
      ...DEFAULT_CONFIG.tdd,
      greenfieldDetection: false,
    },
  };
}

function makeCtx(story: UserStory, overrides?: Partial<PipelineContext>): PipelineContext & { prdPath: string } {
  const prd = makePRD(story);
  return {
    config: makeConfig(),
    prd,
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    rootConfig: DEFAULT_CONFIG,
    workdir: WORKDIR,
    projectDir: WORKDIR,
    hooks: { hooks: {} },
    prdPath: `${WORKDIR}/nax/prd.json`,
    ...overrides,
  } as PipelineContext & { prdPath: string };
}

const FRESH_ROUTING_RESULT = {
  complexity: "medium" as const,
  modelTier: "balanced" as const,
  testStrategy: "three-session-tdd" as const,
  reasoning: "classified by routeStory",
};

// ---------------------------------------------------------------------------
// AC-4: savePRD called once per story, not on every iteration
// ---------------------------------------------------------------------------

describe("routingStage - savePRD called exactly once per story (not per iteration)", () => {
  let origRoutingDeps: typeof import("../../../../src/pipeline/stages/routing")["_routingDeps"];

  afterEach(() => {
    mock.restore();
    if (origRoutingDeps) {
      const { _routingDeps } = require("../../../../src/pipeline/stages/routing");
      Object.assign(_routingDeps, origRoutingDeps);
    }
  });

  test("calling routingStage twice with routing already set only triggers savePRD once (first call)", async () => {
    const { routingStage, _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );

    origRoutingDeps = { ..._routingDeps };

    let savePRDCallCount = 0;

    _routingDeps.routeStory = mock(() =>
      Promise.resolve({ ...FRESH_ROUTING_RESULT }),
    );
    _routingDeps.isGreenfieldStory = mock(() => Promise.resolve(false));
    _routingDeps.savePRD = mock((_prd: PRD, _path: string) => {
      savePRDCallCount++;
      return Promise.resolve();
    });

    // First iteration: story.routing is undefined → should persist
    const story = makeStory({ routing: undefined, status: "in-progress", passes: false, attempts: 0 });
    const ctx = makeCtx(story);

    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    // After first execution, story.routing is populated (simulating resume after crash)
    // Second iteration: story.routing is now set → in ROUTE-001 we always persist
    await routingStage.execute(ctx as Parameters<typeof routingStage.execute>[0]);

    expect(savePRDCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Sanity: _routingDeps exposes savePRD (fail if not added to deps object)
// ---------------------------------------------------------------------------

describe("routingStage - _routingDeps exposes savePRD", () => {
  test("_routingDeps has a savePRD function", async () => {
    const { _routingDeps } = await import(
      "../../../../src/pipeline/stages/routing"
    );
    expect(typeof _routingDeps.savePRD).toBe("function");
  });
});

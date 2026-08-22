/**
 * Unit tests for context stage — Story: Resolve and thread complete scope files (AC-8).
 *
 * AC-8: When contextStage.execute(ctx) runs with context.v2.enabled true and a
 * stub provider, then its fetch request scopeFiles equals resolveScopeFiles(ctx)'s
 * result.
 *
 * Tests run contextStage.execute() with `_contextStageDeps.createOrchestrator`
 * replaced by a stub that captures the ContextRequest, then assert on the
 * captured `request.scopeFiles`.
 *
 * The resolveScopeFiles function is invoked in-process — tests use its real
 * shape (returns deduped, sorted union) so we can match the exact list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ContextBundle, ContextRequest } from "@/context/engine";
import { _scopeFilesDeps, resolveScopeFiles } from "@/pipeline";
import { _contextStageDeps, contextStage } from "@/pipeline/stages";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";
import { makeNaxConfig, makeStory } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origCreateOrchestrator: typeof _contextStageDeps.createOrchestrator;
let origReadDigest: typeof _contextStageDeps.readDigest;
let origWriteDigest: typeof _contextStageDeps.writeDigest;
let origUuid: typeof _contextStageDeps.uuid;
let origResolveEffectiveRef: typeof _scopeFilesDeps.resolveEffectiveRef;
let origCollectDiffFileList: typeof _scopeFilesDeps.collectDiffFileList;

beforeEach(() => {
  origCreateOrchestrator = _contextStageDeps.createOrchestrator;
  origReadDigest = _contextStageDeps.readDigest;
  origWriteDigest = _contextStageDeps.writeDigest;
  origUuid = _contextStageDeps.uuid;
  origResolveEffectiveRef = _scopeFilesDeps.resolveEffectiveRef;
  origCollectDiffFileList = _scopeFilesDeps.collectDiffFileList;
});

afterEach(() => {
  _contextStageDeps.createOrchestrator = origCreateOrchestrator;
  _contextStageDeps.readDigest = origReadDigest;
  _contextStageDeps.writeDigest = origWriteDigest;
  _contextStageDeps.uuid = origUuid;
  _scopeFilesDeps.resolveEffectiveRef = origResolveEffectiveRef;
  _scopeFilesDeps.collectDiffFileList = origCollectDiffFileList;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeBundle(): ContextBundle {
  return {
    pushMarkdown: "## Context\n\nstub bundle",
    pullTools: [],
    digest: "stub-digest",
    manifest: {
      requestId: "req-stub",
      stage: "context",
      totalBudgetTokens: 8_000,
      usedTokens: 10,
      includedChunks: [],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 1,
      buildMs: 1,
    },
    chunks: [],
  };
}

function makeCtx(story: UserStory): PipelineContext {
  return {
    config: makeNaxConfig({
      context: {
        v2: { enabled: true },
        featureEngine: { enabled: false, budgetTokens: 8_000 },
      },
    }),
    rootConfig: {} as PipelineContext["rootConfig"],
    prd: {} as PipelineContext["prd"],
    story,
    stories: [story],
    routing: { testStrategy: "tdd-simple" } as PipelineContext["routing"],
    projectDir: "/repo",
    workdir: "/repo",
    hooks: {} as PipelineContext["hooks"],
  } as PipelineContext;
}

/** Captures the ContextRequest the contextStage hands to orchestrator.assemble(). */
function captureContextRequest(): {
  captured: ContextRequest | null;
} {
  const ref: { captured: ContextRequest | null } = { captured: null };
  _contextStageDeps.createOrchestrator = () =>
    ({
      async assemble(req: ContextRequest) {
        ref.captured = req;
        return makeBundle();
      },
      rebuildForAgent: () => makeBundle(),
    }) as unknown as ReturnType<typeof _contextStageDeps.createOrchestrator>;
  // Suppress scratch + digests so the stage stays hermetic.
  _contextStageDeps.readDigest = async () => "";
  _contextStageDeps.writeDigest = async () => {};
  _contextStageDeps.uuid = () => "stub-uuid";
  return ref;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: contextStage threads resolveScopeFiles() output into the ContextRequest
// ─────────────────────────────────────────────────────────────────────────────

describe("contextStage — scope files threading (AC-8)", () => {
  test("AC-8: fetch request scopeFiles equals resolveScopeFiles(ctx)'s result when only declared sources", async () => {
    const story = makeStory({
      contextFiles: ["src/a.ts", "src/b.ts"],
      expectedFiles: ["src/c.ts"],
    });
    // Diff returns nothing — scope reduces to declared union.
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const capture = captureContextRequest();

    const ctx = makeCtx(story);
    await contextStage.execute(ctx);

    const expected = await resolveScopeFiles(ctx);
    // AC-8: the captured scopeFiles must equal the resolver's output.
    expect(capture.captured?.scopeFiles).toEqual(expected);
    // Sanity: scopeFiles was actually populated (not omitted/undefined).
    expect(capture.captured?.scopeFiles).toBeDefined();
    expect(capture.captured?.scopeFiles?.length).toBeGreaterThan(0);
  });

  test("AC-8 (boundary): fetch request scopeFiles matches the resolver when diff contributes no new paths", async () => {
    const story = makeStory({
      contextFiles: ["src/declared.ts"],
      expectedFiles: [],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    // Empty diff — scope must still contain declared-only contents.
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const capture = captureContextRequest();

    const ctx = makeCtx(story);
    await contextStage.execute(ctx);

    const expected = await resolveScopeFiles(ctx);
    expect(capture.captured?.scopeFiles).toEqual(expected);
    // The captured value is the actual declared source — proves wiring isn't dropping it.
    expect(capture.captured?.scopeFiles).toEqual(["src/declared.ts"]);
  });
});

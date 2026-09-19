/**
 * Unit tests for context stage — pin the producer of ContextRequest's
 * `storyWorkdir` / `contextFilesCanonical` fields (path-frame follow-up
 * review, BLOCKER 2).
 *
 * src/pipeline/stages/context.ts:176-177 sets both fields on the initial
 * ContextRequest build (contextStage.execute, the first assembly of every
 * story). Before this file existed, `grep -rn "storyWorkdir|contextFilesCanonical"
 * test/` found only provider-side request LITERALS — nothing asserted this
 * producer actually sets them. Deleting either line leaves both git-history
 * and code-neighbor falling back to `?? "."`, which is QUIETER than the bug
 * it replaced: no warn, no `unreachable` entries, just silently wrong joins.
 *
 * Tests run contextStage.execute() with `_contextStageDeps.createOrchestrator`
 * replaced by a stub that captures the ContextRequest, mirroring the harness
 * in context-scope-files.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeContextOrchestrator, makeNaxConfig, makeStory } from "@test/helpers";
import type { ConfigSelector } from "@/config";
import type { ContextBundle, ContextRequest } from "@/context/engine";
import { _scopeFilesDeps } from "@/pipeline";
import { _contextStageDeps, contextStage } from "@/pipeline/stages";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";
import type { PackageView } from "@/runtime";

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
  _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
  _scopeFilesDeps.collectDiffFileList = async () => [];
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

function makeCtx(story: UserStory, workdir: string): PipelineContext {
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
    workdir,
    hooks: {} as PipelineContext["hooks"],
  } as PipelineContext;
}

/** Build a PackageView fixture without `as` casts. */
function makePackageView(packageDir: string, repoRoot: string, config: PipelineContext["config"]): PackageView {
  return {
    packageDir,
    relativeFromRoot: packageDir,
    repoRoot,
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
}

/** Captures the ContextRequest the contextStage hands to orchestrator.assemble(). */
function captureContextRequest(): {
  captured: ContextRequest | null;
} {
  const ref: { captured: ContextRequest | null } = { captured: null };
  _contextStageDeps.createOrchestrator = mock(() =>
    makeContextOrchestrator({
      async assemble(req: ContextRequest) {
        ref.captured = req;
        return makeBundle();
      },
      rebuildForAgent: () => makeBundle(),
    }),
  );
  _contextStageDeps.readDigest = async () => "";
  _contextStageDeps.writeDigest = async () => {};
  _contextStageDeps.uuid = () => "stub-uuid-0000-0000-000000000000";
  return ref;
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKER 2 — producer pins storyWorkdir / contextFilesCanonical
// ─────────────────────────────────────────────────────────────────────────────

describe("contextStage — producer pins storyWorkdir / contextFilesCanonical (BLOCKER 2)", () => {
  test("threads storyWorkdir and stamps contextFilesCanonical=true for a workdirSource-stamped monorepo story", async () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      contextFiles: ["packages/app/src/a.ts"],
    });
    const capture = captureContextRequest();

    await contextStage.execute(makeCtx(story, "/repo/packages/app"));

    expect(capture.captured?.storyWorkdir).toBe("packages/app");
    expect(capture.captured?.contextFilesCanonical).toBe(true);
  });

  test("threads storyWorkdir '.' and stamps contextFilesCanonical=false for an unstamped root story", async () => {
    const story = makeStory({
      contextFiles: ["src/a.ts"],
    });
    const capture = captureContextRequest();

    await contextStage.execute(makeCtx(story, "/repo"));

    expect(capture.captured?.storyWorkdir).toBe(".");
    expect(capture.captured?.contextFilesCanonical).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 / AC8-AC10 (context stage side): pin the producer of ContextRequest's
// new `execRoot` field. Mirrors `assembleForStage`'s producer at stage-
// assembler.ts:215 — same `storyExecRoot(ctx.packageView)` derivation. Two
// producers must agree on the spelling; the context stage builds the FIRST
// ContextRequest for every story, and a producer regression here is exactly
// the "silently dropped field" defect that BLOCKER 2 was written to catch
// for `storyWorkdir`/`contextFilesCanonical`.
// ─────────────────────────────────────────────────────────────────────────────

describe("contextStage — producer pins execRoot (US-001)", () => {
  test("with a worktree-prefixed packageView, execRoot = <root>/.nax-wt/<storyId>", async () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      contextFiles: ["packages/app/src/a.ts"],
    });
    const capture = captureContextRequest();

    const ctx = makeCtx(story, "/repo/.nax-wt/US-001/packages/app");
    ctx.packageView = makePackageView(".nax-wt/US-001/packages/app", "/repo", ctx.config);

    await contextStage.execute(ctx);

    expect(capture.captured?.execRoot).toBe("/repo/.nax-wt/US-001");
  });

  test("with a non-worktree packageView, execRoot = repoRoot", async () => {
    const story = makeStory({
      workdir: "packages/app",
      workdirSource: "stated",
      contextFiles: ["packages/app/src/a.ts"],
    });
    const capture = captureContextRequest();

    const ctx = makeCtx(story, "/repo/packages/app");
    ctx.packageView = makePackageView("packages/app", "/repo", ctx.config);

    await contextStage.execute(ctx);

    expect(capture.captured?.execRoot).toBe("/repo");
  });

  test("with no packageView on the pipeline context, execRoot is unset", async () => {
    const story = makeStory({
      contextFiles: ["src/a.ts"],
    });
    const capture = captureContextRequest();

    // The local `makeCtx` factory (defined above) does not set `runtime` —
    // it returns the pull-tool-handler shape (no story, no runtime, no
    // packageView), so execRoot stays unset.
    const ctx = makeCtx(story, "/repo");
    ctx.packageView = undefined;

    await contextStage.execute(ctx);

    expect(capture.captured?.execRoot).toBeUndefined();
  });
});

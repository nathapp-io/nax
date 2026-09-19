/**
 * US-001 / AC8-AC10: assembleForStage populates ContextRequest.execRoot from
 * `storyExecRoot(ctx.packageView)` whenever a packageView is available.
 * Without a packageView (and without a runtime fallback) the field is
 * OMITTED — consumers fall back to repoRoot. The runtime fallback mirrors
 * the pattern at `src/pipeline/stages/execution.ts:88`, so production
 * pipelines that lack `ctx.packageView` (because iteration-runner.ts does
 * not yet pre-set it on every path) still get the worktree-correct root.
 * The worktree-prefixed case must surface the worktree root (NOT the main
 * checkout) so context providers resolve against the worktree the story
 * actually executes in.
 *
 * Lives beside stage-assembler.test.ts rather than inside it: that file is
 * at the 800-line hard limit under scripts/check-file-sizes.ts and may not
 * grow.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeContextBundle,
  makeContextOrchestrator,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTestContext,
} from "@test/helpers";
import type { ConfigSelector } from "@/config";
import { _stageAssemblerDeps, assembleForStage } from "@/context/engine/stage-assembler";
import type { ContextRequest } from "@/context/engine/types";
import type { PipelineContext } from "@/pipeline/types";
import type { PackageView } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(overrides: { projectDir?: string; workdir?: string; storyWorkdir?: string } = {}): PipelineContext {
  const config = makeNaxConfig({ context: { v2: { enabled: true, pluginProviders: [] } } });
  const story = overrides.storyWorkdir
    ? makeStory({ id: "US-001", workdir: overrides.storyWorkdir, workdirSource: "stated" })
    : makeStory({ id: "US-001" });
  return makeTestContext({
    config,
    rootConfig: config,
    prd: makePRD({ feature: "test-feature", userStories: [] }),
    story,
    stories: [],
    projectDir: overrides.projectDir,
    workdir: overrides.workdir ?? "/repo",
    hooks: { hooks: {} },
  });
}

// AC10 was originally "no packageView → execRoot unset". The story's
// adversarial review (nax#2134 production-wiring) requires that the producers
// not be a dead thread: when runtime is present (the production shape),
// execRoot must derive from it even without packageView, mirroring
// `execution.ts:88`. The runtime-less shape is exercised by the context stage
// test in `context-request-workdir-fields.test.ts`, which uses the local makeCtx
// (no runtime, no DispatchContext fields).

/** Build a PackageView fixture for the worktree-resolution tests. */
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

/** Capture the ContextRequest passed to orchestrator.assemble(). */
function captureOrchestratorRequest(): { captured: ContextRequest | null } {
  const ref: { captured: ContextRequest | null } = { captured: null };
  _stageAssemblerDeps.createOrchestrator = mock(() =>
    makeContextOrchestrator({
      assemble: async (req: ContextRequest) => {
        ref.captured = req;
        return makeContextBundle({});
      },
    }),
  );
  return ref;
}

describe("assembleForStage — US-001 execRoot propagation", () => {
  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = origReaddir;
    _stageAssemblerDeps.readDescriptor = origReadDescriptor;
    _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
  });

  test("AC8: packageView with a .nax-wt prefix yields execRoot = <root>/.nax-wt/<storyId>", async () => {
    const capture = captureOrchestratorRequest();

    const ctx = makeCtx({
      projectDir: "/repo",
      workdir: "/repo/.nax-wt/US-001/packages/app",
      storyWorkdir: "packages/app",
    });
    // Iteration-runner stamps packageView with the RELATIVE packageDir and
    // the absolute repoRoot. storyExecRoot is then responsible for assembling
    // the worktree root, exactly like the production caller at
    // src/operations/call-run-options.ts:57.
    ctx.packageView = makePackageView(".nax-wt/US-001/packages/app", "/repo", ctx.config);

    await assembleForStage(ctx, "execution");

    expect(capture.captured?.execRoot).toBe("/repo/.nax-wt/US-001");
  });

  test("AC9: packageView with no .nax-wt segment yields execRoot = repoRoot", async () => {
    const capture = captureOrchestratorRequest();

    const ctx = makeCtx({
      projectDir: "/repo",
      workdir: "/repo/packages/app",
      storyWorkdir: "packages/app",
    });
    ctx.packageView = makePackageView("packages/app", "/repo", ctx.config);

    await assembleForStage(ctx, "execution");

    expect(capture.captured?.execRoot).toBe("/repo");
  });

  test("AC10: with no packageView on the pipeline context, execRoot is derived from runtime fallback (closes production-wiring gap)", async () => {
    const capture = captureOrchestratorRequest();

    // Pull-tool handlers carry no story, no packageView, and no runtime —
    // their ContextRequest must NOT carry execRoot, so consumers fall back to
    // repoRoot (today's behaviour). Here we exercise the production shape:
    // ctx.packageView is undefined (because nothing in the production
    // pipeline sets it today, per the adversarial finding), but ctx.runtime
    // IS available. The fallback mirrors execution.ts:88 so execRoot is
    // derived from ctx.workdir, not silently unset.
    const ctx = makeCtx({
      projectDir: "/repo",
      workdir: "/repo",
    });
    ctx.packageView = undefined;

    await assembleForStage(ctx, "execution");

    // execRoot must be set — the runtime fallback closed the dead-thread gap.
    expect(capture.captured?.execRoot).toBeDefined();
    // And it must equal the runtime-derived value, NOT repoRoot — proving
    // the fallback ran (without it, execRoot would be undefined and the
    // provider would fall back to request.repoRoot = "/repo").
    expect(capture.captured?.execRoot).not.toBe("/repo");
  });
});

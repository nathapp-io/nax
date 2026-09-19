/**
 * US-001 / AC8-AC10: assembleForStage populates ContextRequest.execRoot from
 * `storyExecRoot(ctx.packageView)` whenever a packageView is available.
 * Without a packageView the field is OMITTED — consumers fall back to
 * repoRoot, which is today's behaviour. The worktree-prefixed case must
 * surface the worktree root (NOT the main checkout) so context providers
 * resolve against the worktree the story actually executes in.
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

  test("AC10: with no packageView on the pipeline context, execRoot is unset", async () => {
    const capture = captureOrchestratorRequest();

    // Pull-tool handlers carry no story and have no packageView — their
    // ContextRequest must NOT carry execRoot, so consumers fall back to
    // repoRoot (today's behaviour).
    const ctx = makeCtx({
      projectDir: "/repo",
      workdir: "/repo",
    });
    // Defensive: explicitly remove any packageView set by the factory.
    ctx.packageView = undefined;

    await assembleForStage(ctx, "execution");

    expect(capture.captured?.execRoot).toBeUndefined();
  });
});

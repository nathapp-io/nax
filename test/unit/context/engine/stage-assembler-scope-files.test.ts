/**
 * Unit tests for assembleForStage — Story: Resolve and thread complete scope files.
 *
 * AC-10: assembleForStage() builds a ContextRequest whose scopeFiles equals
 *        StageAssembleOptions.scopeFiles.
 * AC-11: assembleForStage() preserves touchedFiles equal to
 *        getContextFiles(story) when scopeFiles is supplied.
 *
 * Mirrors the pattern from test/unit/context/engine/stage-assembler.test.ts:
 * capture the ContextRequest via a mock orchestrator and assert on the
 * captured fields directly. The resolver is NOT invoked here — assembleForStage
 * only consumes what the caller threads through StageAssembleOptions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TEST_ROUTING,
  makeStory as makeBaseStory,
  makeContextBundle,
  makeNaxConfig,
  makePRD,
  makeTestContext,
} from "@test/helpers";
import type { ContextBundle, ContextRequest } from "@/context/engine";
import { _stageAssemblerDeps, assembleForStage } from "@/context/engine";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;
let origReaddir: typeof _stageAssemblerDeps.readdir;
let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;

beforeEach(() => {
  origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
  origReaddir = _stageAssemblerDeps.readdir;
  origReadDescriptor = _stageAssemblerDeps.readDescriptor;
  // Suppress disk discovery — keep tests hermetic.
  _stageAssemblerDeps.readdir = async () => {
    throw new Error("ENOENT");
  };
  _stageAssemblerDeps.readDescriptor = async () => null;
});

afterEach(() => {
  _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
  _stageAssemblerDeps.readdir = origReaddir;
  _stageAssemblerDeps.readDescriptor = origReadDescriptor;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/repo";
const STORY_ID = "US-005";

const makeStory = (overrides: Partial<UserStory> = {}): UserStory => makeBaseStory({ id: STORY_ID, ...overrides });

function makeCtx(story: UserStory): PipelineContext {
  return makeTestContext({
    config: makeNaxConfig({
      context: { v2: { enabled: true, pluginProviders: [] } },
      agent: { default: "claude" },
    }),
    rootConfig: makeNaxConfig({ agent: { default: "claude" } }),
    prd: makePRD({ feature: "test-feature" }),
    story,
    stories: [],
    routing: { ...DEFAULT_TEST_ROUTING, testStrategy: "tdd-simple" },
    projectDir: PROJECT_DIR,
    workdir: PROJECT_DIR,
  });
}

function makeMockOrchestrator() {
  const ref: { captured: ContextRequest | null } = { captured: null };
  const orchestrator = {
    assemble: async (r: ContextRequest): Promise<ContextBundle> => {
      ref.captured = r;
      return makeContextBundle({
        pushMarkdown: "",
        digest: "abc",
        manifest: {
          requestId: "req-1",
          stage: "execution",
          totalBudgetTokens: 0,
          usedTokens: 0,
          includedChunks: [],
          excludedChunks: [],
          floorItems: [],
          digestTokens: 0,
          buildMs: 0,
        },
      });
    },
  };
  return { ref, orchestrator };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 / AC-11
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleForStage — scope files threading (AC-10 / AC-11)", () => {
  test("AC-10: builds ContextRequest whose scopeFiles equals StageAssembleOptions.scopeFiles", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const scope = ["src/one.ts", "src/two.ts", "src/three.ts"];
    const story = makeStory({ contextFiles: ["src/one.ts"] });
    await assembleForStage(makeCtx(story), "execution", { scopeFiles: scope });

    expect(mock.ref.captured?.scopeFiles).toEqual(scope);
  });

  test("AC-10 (boundary): builds ContextRequest whose scopeFiles equals a single-entry scope list", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const scope = ["src/only.ts"];
    const story = makeStory();
    await assembleForStage(makeCtx(story), "execution", { scopeFiles: scope });

    expect(mock.ref.captured?.scopeFiles).toEqual(["src/only.ts"]);
  });

  test("AC-11: preserves touchedFiles equal to getContextFiles(story) when scopeFiles is supplied", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const story = makeStory({
      contextFiles: ["src/declared-a.ts", "src/declared-b.ts"],
    });
    await assembleForStage(makeCtx(story), "execution", {
      scopeFiles: ["src/from-scope-resolver.ts"],
    });

    // AC-11 contract: touchedFiles continues to come from getContextFiles(story),
    // unchanged, even when scopeFiles is also supplied.
    expect(mock.ref.captured?.touchedFiles).toEqual(["src/declared-a.ts", "src/declared-b.ts"]);
  });

  test("AC-11 (boundary): touchedFiles defaults to getContextFiles(story) when caller omits touchedFiles option", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    const story = makeStory({
      contextFiles: ["src/default-touched.ts"],
    });
    // No touchedFiles override, no scopeFiles — touchedFiles should still
    // equal getContextFiles(story).
    await assembleForStage(makeCtx(story), "execution");

    expect(mock.ref.captured?.touchedFiles).toEqual(["src/default-touched.ts"]);
  });
});

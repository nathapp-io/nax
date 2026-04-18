/**
 * Unit tests for src/context/engine/stage-assembler.ts — disk-backed session
 * scratch discovery (Finding 2 from the Context Engine v2 architecture review)
 * and AC-24/AC-51 ContextRequest propagation (#504).
 *
 * Tests call `discoverSessionScratchDirsOnDisk` directly so the return value
 * is observable. The helper is exported from stage-assembler for this purpose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _stageAssemblerDeps,
  assembleForStage,
  discoverSessionScratchDirsOnDisk,
} from "../../../../src/context/engine/stage-assembler";
import type { ContextBundle, ContextRequest } from "../../../../src/context/engine/types";
import type { PipelineContext } from "../../../../src/pipeline/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = Date.parse("2026-04-17T12:00:00.000Z");
const WITHIN_TTL_ISO = "2026-04-17T10:00:00.000Z"; // 2h ago
const OUTSIDE_TTL_ISO = "2026-04-17T00:00:00.000Z"; // 12h ago
const TTL_4H = 4 * 60 * 60 * 1000;

const PROJECT_DIR = "/repo";
const FEATURE = "test-feature";
const STORY = "US-001";
const SESSIONS_ROOT = `${PROJECT_DIR}/.nax/features/${FEATURE}/sessions`;

// ─────────────────────────────────────────────────────────────────────────────

describe("discoverSessionScratchDirsOnDisk — Finding 2", () => {
  let originalReaddir: typeof _stageAssemblerDeps.readdir;
  let originalReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let originalNow: typeof _stageAssemblerDeps.now;

  beforeEach(() => {
    originalReaddir = _stageAssemblerDeps.readdir;
    originalReadDescriptor = _stageAssemblerDeps.readDescriptor;
    originalNow = _stageAssemblerDeps.now;
    _stageAssemblerDeps.now = () => FIXED_NOW;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = originalReaddir;
    _stageAssemblerDeps.readDescriptor = originalReadDescriptor;
    _stageAssemblerDeps.now = originalNow;
  });

  test("returns scratch dirs for all descriptors matching storyId and within TTL", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-a", "sess-b"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-a")) {
        return {
          storyId: STORY,
          scratchDir: `${SESSIONS_ROOT}/sess-a`,
          lastActivityAt: WITHIN_TTL_ISO,
        };
      }
      if (path.includes("sess-b")) {
        return {
          storyId: STORY,
          scratchDir: `${SESSIONS_ROOT}/sess-b`,
          lastActivityAt: WITHIN_TTL_ISO,
        };
      }
      return null;
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toHaveLength(2);
    expect(result).toContain(`${SESSIONS_ROOT}/sess-a`);
    expect(result).toContain(`${SESSIONS_ROOT}/sess-b`);
  });

  test("skips descriptors for a different story", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-mine", "sess-theirs"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-mine")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-mine`, lastActivityAt: WITHIN_TTL_ISO };
      }
      return { storyId: "US-002", scratchDir: `${SESSIONS_ROOT}/sess-theirs`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-mine`]);
  });

  test("skips descriptors older than TTL", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-fresh", "sess-stale"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-fresh")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-fresh`, lastActivityAt: WITHIN_TTL_ISO };
      }
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-stale`, lastActivityAt: OUTSIDE_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-fresh`]);
  });

  test("returns empty when the sessions directory does not exist", async () => {
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT: no such file or directory");
    };
    _stageAssemblerDeps.readDescriptor = async () => {
      throw new Error("should not be called");
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });

  test("skips malformed descriptors without throwing", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-broken", "sess-good"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-broken")) throw new Error("unexpected token in JSON");
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-good`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-good`]);
  });

  test("skips descriptors missing scratchDir", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-partial", "sess-full"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-partial")) return { storyId: STORY, lastActivityAt: WITHIN_TTL_ISO };
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-full`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-full`]);
  });

  test("skips descriptors with unparseable lastActivityAt", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-baddate", "sess-gooddate"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-baddate")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-baddate`, lastActivityAt: "not-a-date" };
      }
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-gooddate`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-gooddate`]);
  });

  test("skips descriptors missing lastActivityAt entirely", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-nodate"];
    _stageAssemblerDeps.readDescriptor = async () => ({
      storyId: STORY,
      scratchDir: `${SESSIONS_ROOT}/sess-nodate`,
    });

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });

  test("reads descriptors under the correct sessions path", async () => {
    const calls: string[] = [];
    _stageAssemblerDeps.readdir = async (path: string) => {
      calls.push(`readdir:${path}`);
      return ["sess-a"];
    };
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      calls.push(`readDescriptor:${path}`);
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-a`, lastActivityAt: WITHIN_TTL_ISO };
    };

    await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(calls[0]).toBe(`readdir:${SESSIONS_ROOT}`);
    expect(calls[1]).toBe(`readDescriptor:${SESSIONS_ROOT}/sess-a/descriptor.json`);
  });

  test("returns empty when no descriptors match the story", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-other"];
    _stageAssemblerDeps.readDescriptor = async () => ({
      storyId: "US-999",
      scratchDir: `${SESSIONS_ROOT}/sess-other`,
      lastActivityAt: WITHIN_TTL_ISO,
    });

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-24 / AC-51 — deterministic + planDigestBoost propagation (#504)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal PipelineContext for assembleForStage tests */
function makeCtx(overrides: {
  deterministic?: boolean;
  testStrategy?: string;
} = {}): PipelineContext {
  return {
    config: {
      context: {
        v2: {
          enabled: true,
          pluginProviders: [],
          deterministic: overrides.deterministic,
        },
      },
      autoMode: { defaultAgent: "claude" },
    },
    rootConfig: { autoMode: { defaultAgent: "claude" } },
    prd: { feature: "test-feature", userStories: [] },
    story: { id: "US-001" },
    stories: [],
    routing: { agent: undefined, testStrategy: overrides.testStrategy },
    projectDir: undefined, // prevents manifest writing in tests
    workdir: "/repo",
    hooks: {},
  } as unknown as PipelineContext;
}

/** Mock orchestrator that captures the last assemble() request via a mutable ref. */
function makeMockOrchestrator() {
  const ref: { captured: ContextRequest | null } = { captured: null };
  const orchestrator = {
    assemble: async (r: ContextRequest): Promise<ContextBundle> => {
      ref.captured = r;
      return {
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
        packedChunks: [],
      } as unknown as ContextBundle;
    },
  };
  return { ref, orchestrator };
}

describe("assembleForStage — AC-24/AC-51 ContextRequest propagation", () => {
  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    // Suppress disk discovery
    _stageAssemblerDeps.readdir = async () => { throw new Error("ENOENT"); };
    _stageAssemblerDeps.readDescriptor = async () => null;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = origReaddir;
    _stageAssemblerDeps.readDescriptor = origReadDescriptor;
    _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
  });

  test("AC-24: passes deterministic:true when config flag is set", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ deterministic: true }), "execution");

    expect(mock.ref.captured?.deterministic).toBe(true);
  });

  test("AC-24: passes deterministic:false when config flag is unset", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ deterministic: false }), "execution");

    expect(mock.ref.captured?.deterministic).toBe(false);
  });

  test("AC-51: passes planDigestBoost from routing testStrategy (tdd-simple → 1.5)", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ testStrategy: "tdd-simple" }), "execution");

    expect(mock.ref.captured?.planDigestBoost).toBe(1.5);
  });

  test("AC-51: planDigestBoost is undefined for three-session-tdd (uses multi-session digest)", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ testStrategy: "three-session-tdd" }), "tdd-implementer");

    expect(mock.ref.captured?.planDigestBoost).toBeUndefined();
  });

  test("AC-51: planDigestBoost 1.5 for no-test strategy", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ testStrategy: "no-test" }), "execution");

    expect(mock.ref.captured?.planDigestBoost).toBe(1.5);
  });

  test("threads availableBudgetTokens from stage assembly call site", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () => mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx({ testStrategy: "tdd-simple" }), "execution");

    expect(mock.ref.captured?.availableBudgetTokens).toBeGreaterThan(0);
  });
});

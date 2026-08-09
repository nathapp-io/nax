/**
 * US-001 — Extract agent-rebuild implementation
 *
 * Acceptance criteria:
 *   AC1  Given a prior bundle and empty options, when the exported rebuild
 *        function from `src/context/engine/rebuild.ts` is called, then its
 *        `pushMarkdown` equals the prior bundle's rendering.
 *   AC2  When `_orchestratorDeps` is imported from
 *        `src/context/engine/orchestrator.ts`, then it exposes the extracted
 *        rebuild function as a replaceable property.
 *   AC3  Given `_orchestratorDeps`' rebuild property is replaced with a stub
 *        that returns a sentinel bundle, when `ContextEngine.rebuildForAgent`
 *        is called, then it returns that sentinel bundle unchanged.
 *   AC4  Given `_orchestratorDeps`' rebuild property is replaced with a stub,
 *        when `ContextEngine.rebuildForAgent` is called, then the stub is
 *        invoked exactly once with the received prior bundle and options object.
 *   AC5  Given `newAgentId: "codex"` and a failure, when
 *        `ContextEngine.rebuildForAgent` is called, then
 *        `manifest.rebuildInfo.newAgentId` equals `"codex"`.
 *   AC6  Given `newAgentId` is absent from `AGENT_PROFILES`, when
 *        `ContextEngine.rebuildForAgent` is called, then the returned bundle's
 *        `agentId` equals that ID and a warn-level log is emitted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ContextOrchestrator,
  _orchestratorDeps,
  rebuild,
  type AdapterFailure,
  type ContextBundle,
  type ContextProviderResult,
  type ContextRequest,
  type IContextProvider,
  type RebuildOptions,
} from "@/context/engine";
import { makeLogger, type MockLogger } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 8_000,
  providerIds: ["p1"],
};

function makeProvider(id: string, result: ContextProviderResult): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async () => result,
  };
}

function makeChunkResult(id = "chunk:abc"): ContextProviderResult {
  return {
    chunks: [
      {
        id,
        kind: "feature",
        scope: "project",
        role: ["all"],
        content: "Feature rule: use async/await.",
        tokens: 20,
        rawScore: 0.8,
      },
    ],
  };
}

const AVAILABILITY_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "daily token quota exhausted",
  retriable: false,
};

async function makePriorBundle(): Promise<ContextBundle> {
  const orch = new ContextOrchestrator([makeProvider("p1", makeChunkResult())]);
  const bundle = await orch.assemble(BASE_REQUEST);
  return { ...bundle, agentId: "claude" };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — rebuild(prior, {}) preserves pushMarkdown for plain re-render
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — rebuild() AC1: pushMarkdown equals prior on plain re-render", () => {
  test("rebuild(prior, {}) produces pushMarkdown equal to prior.pushMarkdown", async () => {
    const prior = await makePriorBundle();

    const result = rebuild(prior, {});

    expect(result.pushMarkdown).toBe(prior.pushMarkdown);
  });

  test("rebuild returns a bundle object with pushMarkdown, pullTools, digest, manifest, chunks, agentId", async () => {
    const prior = await makePriorBundle();

    const result = rebuild(prior, {});

    expect(typeof result.pushMarkdown).toBe("string");
    expect(Array.isArray(result.pullTools)).toBe(true);
    expect(typeof result.digest).toBe("string");
    expect(result.manifest).toBeDefined();
    expect(Array.isArray(result.chunks)).toBe(true);
    expect(typeof result.agentId).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — _orchestratorDeps.rebuild is the extracted function and is replaceable
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — _orchestratorDeps AC2: rebuild property is exposed and replaceable", () => {
  test("_orchestratorDeps.rebuild exists as a function", () => {
    expect(typeof _orchestratorDeps.rebuild).toBe("function");
  });

  test("_orchestratorDeps.rebuild references the same exported rebuild function", () => {
    expect(_orchestratorDeps.rebuild).toBe(rebuild);
  });

  test("_orchestratorDeps.rebuild is a writable property that can be replaced", () => {
    const descriptor = Object.getOwnPropertyDescriptor(_orchestratorDeps, "rebuild");
    expect(descriptor).not.toBeNull();
    expect(descriptor?.writable).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 + AC4 — _orchestratorDeps.rebuild delegation seam
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — _orchestratorDeps.rebuild delegation seam", () => {
  let origRebuild: typeof _orchestratorDeps.rebuild;

  beforeEach(() => {
    origRebuild = _orchestratorDeps.rebuild;
  });

  afterEach(() => {
    _orchestratorDeps.rebuild = origRebuild;
  });

  test("AC3 — wrapper returns the sentinel bundle unchanged when rebuild is stubbed", async () => {
    const prior = await makePriorBundle();
    const sentinel: ContextBundle = {
      pushMarkdown: "SENTINEL_MARKER_pushMarkdown",
      pullTools: [],
      digest: "SENTINEL_MARKER_digest",
      manifest: { ...prior.manifest, requestId: "sentinel-request-id" },
      chunks: [],
      agentId: "sentinel-agent",
    };

    const stub = (() => sentinel) as typeof _orchestratorDeps.rebuild;
    _orchestratorDeps.rebuild = stub;

    const orch = new ContextOrchestrator([]);
    const result = orch.rebuildForAgent(prior, {});

    expect(result).toBe(sentinel);
    expect(result.pushMarkdown).toBe("SENTINEL_MARKER_pushMarkdown");
    expect(result.agentId).toBe("sentinel-agent");
  });

  test("AC4 — stub is invoked exactly once with the received prior and options", async () => {
    const prior = await makePriorBundle();
    const options: RebuildOptions = {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
      priorStageDigest: "Stage digest text",
      storyId: "US-001",
    };

    let callCount = 0;
    let receivedPrior: ContextBundle | undefined;
    let receivedOptions: RebuildOptions | undefined;

    const stub = ((p: ContextBundle, o: RebuildOptions = {}): ContextBundle => {
      callCount++;
      receivedPrior = p;
      receivedOptions = o;
      return { ...p, pushMarkdown: "STUB_OUTPUT" };
    }) as typeof _orchestratorDeps.rebuild;
    _orchestratorDeps.rebuild = stub;

    const orch = new ContextOrchestrator([]);
    orch.rebuildForAgent(prior, options);

    expect(callCount).toBe(1);
    expect(receivedPrior).toBe(prior);
    expect(receivedOptions).toEqual(options);
  });

  test("AC4 — stub is invoked exactly once even when options is omitted", async () => {
    const prior = await makePriorBundle();

    let callCount = 0;
    let receivedPrior: ContextBundle | undefined;
    let receivedOptions: RebuildOptions | undefined;

    const stub = ((p: ContextBundle, o: RebuildOptions = {}): ContextBundle => {
      callCount++;
      receivedPrior = p;
      receivedOptions = o;
      return { ...p, pushMarkdown: "STUB_OUTPUT" };
    }) as typeof _orchestratorDeps.rebuild;
    _orchestratorDeps.rebuild = stub;

    const orch = new ContextOrchestrator([]);
    orch.rebuildForAgent(prior);

    expect(callCount).toBe(1);
    expect(receivedPrior).toBe(prior);
    expect(receivedOptions).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — manifest.rebuildInfo.newAgentId === "codex" on agent-swap rebuild
//       (also covered by orchestrator-rebuild.test.ts; mirrored here for the
//        extracted function so the AC is anchored to rebuild.ts too.)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — rebuild() AC5: rebuildInfo.newAgentId is the target agent on swap", () => {
  test("rebuild(prior, { newAgentId: 'codex', failure }) sets manifest.rebuildInfo.newAgentId to 'codex'", async () => {
    const prior = await makePriorBundle();

    const result = rebuild(prior, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(result.manifest.rebuildInfo?.newAgentId).toBe("codex");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — unknown agent id produces agentId on bundle AND warn-level log
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — rebuild() AC6: unknown agent id sets bundle.agentId AND emits warn", () => {
  let origGetLogger: typeof _orchestratorDeps.getLogger;
  let mockLogger: MockLogger;

  beforeEach(() => {
    origGetLogger = _orchestratorDeps.getLogger;
    mockLogger = makeLogger();
    _orchestratorDeps.getLogger = () =>
      mockLogger as unknown as ReturnType<typeof _orchestratorDeps.getLogger>;
  });

  afterEach(() => {
    _orchestratorDeps.getLogger = origGetLogger;
  });

  test("unknown agent id returns a bundle whose agentId equals that id", async () => {
    const prior = await makePriorBundle();

    const result = rebuild(prior, {
      newAgentId: "totally-fictional-agent",
      failure: AVAILABILITY_FAILURE,
    });

    expect(result.agentId).toBe("totally-fictional-agent");
  });

  test("unknown agent id emits a warn-level log when called via the orchestrator wrapper", async () => {
    const prior = await makePriorBundle();

    const orch = new ContextOrchestrator([]);
    orch.rebuildForAgent(prior, {
      newAgentId: "totally-fictional-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const warnCalls = mockLogger.calls.filter((c) => c.level === "warn");
    const unknownAgentWarn = warnCalls.find((c) => /unknown agent/i.test(c.message));
    expect(unknownAgentWarn).toBeDefined();
    expect(unknownAgentWarn!.stage).toBe("context-v2");
  });
});

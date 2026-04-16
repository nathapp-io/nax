/**
 * Context Stage — Phase 2 digest threading tests
 *
 * Verifies that runV2Path() reads prior digest before assemble() and writes
 * the new digest after. Tests use _contextStageDeps injection — no mock.module().
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { contextStage, _contextStageDeps } from "../../../../src/pipeline/stages/context";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ContextBundle, ContextRequest } from "../../../../src/context/engine";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals (restored per test)
// ─────────────────────────────────────────────────────────────────────────────

let origCreateOrchestrator: typeof _contextStageDeps.createOrchestrator;
let origReadDigest: typeof _contextStageDeps.readDigest;
let origWriteDigest: typeof _contextStageDeps.writeDigest;
let origUuid: typeof _contextStageDeps.uuid;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nax-ctx-digest-test-"));
  origCreateOrchestrator = _contextStageDeps.createOrchestrator;
  origReadDigest = _contextStageDeps.readDigest;
  origWriteDigest = _contextStageDeps.writeDigest;
  origUuid = _contextStageDeps.uuid;
});

afterEach(() => {
  _contextStageDeps.createOrchestrator = origCreateOrchestrator;
  _contextStageDeps.readDigest = origReadDigest;
  _contextStageDeps.writeDigest = origWriteDigest;
  _contextStageDeps.uuid = origUuid;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeBundle(digest = "bundle digest"): ContextBundle {
  return {
    pushMarkdown: "## Context\n\nsome context",
    pullTools: [],
    digest,
    manifest: {
      requestId: "req-001",
      stage: "context",
      totalBudgetTokens: 8_000,
      usedTokens: 100,
      includedChunks: ["chunk-1"],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 10,
      buildMs: 5,
    },
    chunks: [],
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: {
      context: {
        v2: { enabled: true },
        featureEngine: { budgetTokens: 8_000 },
      },
    } as unknown as PipelineContext["config"],
    rootConfig: {} as PipelineContext["rootConfig"],
    prd: {} as PipelineContext["prd"],
    story: { id: "US-001" } as PipelineContext["story"],
    stories: [],
    routing: {} as PipelineContext["routing"],
    projectDir: tmpDir,
    workdir: tmpDir,
    hooks: {} as PipelineContext["hooks"],
    sessionScratchDir: join(tmpDir, "sessions", "sess-001"),
    sessionId: "sess-001",
    ...overrides,
  } as PipelineContext;
}

function mockOrchestrator(bundle: ContextBundle, captureRequest?: (req: ContextRequest) => void) {
  _contextStageDeps.createOrchestrator = () =>
    ({
      async assemble(req: ContextRequest) {
        captureRequest?.(req);
        return bundle;
      },
      rebuildForAgent: () => bundle,
    }) as unknown as ReturnType<typeof _contextStageDeps.createOrchestrator>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("context stage — Phase 2 digest threading", () => {
  test("reads prior digest from scratch dir before assemble", async () => {
    let readCalled = false;
    _contextStageDeps.readDigest = async (dir, key) => {
      readCalled = true;
      expect(dir).toContain("sessions");
      expect(key).toBe("context");
      return "";
    };
    _contextStageDeps.writeDigest = async () => {};
    mockOrchestrator(makeBundle());

    const ctx = makeCtx();
    await contextStage.execute(ctx);
    expect(readCalled).toBe(true);
  });

  test("passes prior digest into ContextRequest when present", async () => {
    _contextStageDeps.readDigest = async () => "prior summary text";
    _contextStageDeps.writeDigest = async () => {};

    let capturedRequest: ContextRequest | undefined;
    mockOrchestrator(makeBundle(), (req) => {
      capturedRequest = req;
    });

    await contextStage.execute(makeCtx());
    expect(capturedRequest?.priorStageDigest ?? "").toBe("prior summary text");
  });

  test("passes undefined when prior digest is empty string", async () => {
    _contextStageDeps.readDigest = async () => "";
    _contextStageDeps.writeDigest = async () => {};

    let capturedRequest: ContextRequest | undefined;
    mockOrchestrator(makeBundle(), (req) => {
      capturedRequest = req;
    });

    await contextStage.execute(makeCtx());
    expect(capturedRequest?.priorStageDigest).toBeUndefined();
  });

  test("writes bundle digest to scratch dir after assemble", async () => {
    _contextStageDeps.readDigest = async () => "";
    let writtenDir = "";
    let writtenKey = "";
    let writtenDigest = "";
    _contextStageDeps.writeDigest = async (dir, key, digest) => {
      writtenDir = dir;
      writtenKey = key;
      writtenDigest = digest;
    };

    const bundle = makeBundle("the new digest");
    mockOrchestrator(bundle);

    const ctx = makeCtx();
    await contextStage.execute(ctx);

    expect(writtenDir).toBe(ctx.sessionScratchDir ?? "");
    expect(writtenKey).toBe("context");
    expect(writtenDigest).toBe("the new digest");
  });

  test("continues without prior digest when readDigest throws", async () => {
    _contextStageDeps.readDigest = async () => {
      throw new Error("disk error");
    };
    _contextStageDeps.writeDigest = async () => {};

    let capturedRequest: ContextRequest | undefined;
    mockOrchestrator(makeBundle(), (req) => {
      capturedRequest = req;
    });

    const ctx = makeCtx();
    const result = await contextStage.execute(ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.contextBundle).toBeDefined();
    expect(capturedRequest?.priorStageDigest).toBeUndefined();
  });

  test("continues when writeDigest throws", async () => {
    _contextStageDeps.readDigest = async () => "";
    _contextStageDeps.writeDigest = async () => {
      throw new Error("write error");
    };
    mockOrchestrator(makeBundle());

    const ctx = makeCtx();
    const result = await contextStage.execute(ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.contextBundle).toBeDefined();
  });

  test("derives sessionScratchDir when unset and uses it for digest I/O", async () => {
    let readDir = "";
    let writeDir = "";
    _contextStageDeps.readDigest = async (dir) => {
      readDir = dir;
      return "";
    };
    _contextStageDeps.writeDigest = async (dir) => {
      writeDir = dir;
    };
    _contextStageDeps.uuid = () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as `${string}-${string}-${string}-${string}-${string}`;
    mockOrchestrator(makeBundle("some digest"));

    const ctx = makeCtx({ sessionScratchDir: undefined, sessionId: undefined });
    await contextStage.execute(ctx);

    // scratchDir should be derived from projectDir + featureId + sessionId
    expect(ctx.sessionScratchDir).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(readDir).toBe(ctx.sessionScratchDir ?? "");
    expect(writeDir).toBe(ctx.sessionScratchDir ?? "");
  });

  test("skips writeDigest when bundle digest is empty", async () => {
    _contextStageDeps.readDigest = async () => "";
    let writeCalled = false;
    _contextStageDeps.writeDigest = async () => {
      writeCalled = true;
    };
    mockOrchestrator(makeBundle(""));

    await contextStage.execute(makeCtx());
    expect(writeCalled).toBe(false);
  });

  test("sets ctx.contextBundle from assembled bundle", async () => {
    _contextStageDeps.readDigest = async () => "";
    _contextStageDeps.writeDigest = async () => {};
    const bundle = makeBundle("digest-abc");
    mockOrchestrator(bundle);

    const ctx = makeCtx();
    await contextStage.execute(ctx);

    expect(ctx.contextBundle).toBe(bundle);
    expect(ctx.featureContextMarkdown).toBe(bundle.pushMarkdown);
  });
});

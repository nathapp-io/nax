/**
 * allocateStorySession — shared story-session allocation (US-004)
 *
 * The v2 context stage and the new workflow context stage both need the same
 * per-story session scratch dir, session id and pull-tool run counter. US-004
 * moved that block out of `runV2Path` into `allocateStorySession` so the
 * workflow pipeline can allocate a session without booting the v2 orchestrator
 * (whose pull tools were called 0 times in 6,394 audited sessions).
 *
 * AC-13: [unit] allocateStorySession(ctx) on a context that already has
 *        sessionScratchDir leaves ctx.sessionScratchDir and ctx.sessionId
 *        unchanged.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeNaxConfig,
  makePRD,
  makeSessionManager,
  makeStory,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { featureDir } from "@/config";
import { _contextSessionDeps, allocateStorySession } from "@/pipeline/stages/context-session";
import type { PipelineContext } from "@/pipeline/types";
import type { SessionDescriptor } from "@/session/types";

const STUB_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let origUuid: typeof _contextSessionDeps.uuid;
let tmpDir: string;

beforeEach(() => {
  origUuid = _contextSessionDeps.uuid;
  tmpDir = makeTempDir("nax-context-session-test-");
});

afterEach(() => {
  _contextSessionDeps.uuid = origUuid;
  cleanupTempDir(tmpDir);
});

function makeDescriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess-allocated",
    role: "implementer",
    state: "CREATED",
    agent: "claude",
    workdir: tmpDir,
    protocolIds: { recordId: null, sessionId: null },
    completedStages: [],
    createdAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return makeTestContext({
    config: makeNaxConfig({ context: { v2: { enabled: true } } }),
    story: makeStory({ id: "US-004" }),
    projectDir: tmpDir,
    workdir: tmpDir,
    ...overrides,
  });
}

describe("allocateStorySession — already-allocated context (AC-13)", () => {
  test("AC-13: leaves ctx.sessionScratchDir and ctx.sessionId unchanged", () => {
    const create = mock(() => makeDescriptor());
    const scratch = join(tmpDir, "sessions", "sess-keep");
    const ctx = makeCtx({
      sessionManager: makeSessionManager({ create }),
      sessionScratchDir: scratch,
      sessionId: "sess-keep",
    });

    allocateStorySession(ctx);

    expect(ctx.sessionScratchDir).toBe(scratch);
    expect(ctx.sessionId).toBe("sess-keep");
    // The whole allocation block is skipped: no second session is created.
    expect(create).toHaveBeenCalledTimes(0);
  });

  test("AC-13 (boundary): leaves ctx.sessionId undefined when only the scratch dir was prior-allocated", () => {
    const ctx = makeCtx({ sessionScratchDir: join(tmpDir, "sessions", "sess-keep"), sessionId: undefined });

    allocateStorySession(ctx);

    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.sessionScratchDir).toBe(join(tmpDir, "sessions", "sess-keep"));
  });
});

describe("allocateStorySession — allocation", () => {
  test("allocates through sessionManager.create when the context has no scratch dir", () => {
    const create = mock(() => makeDescriptor({ id: "sess-new", scratchDir: join(tmpDir, "sessions", "sess-new") }));
    const ctx = makeCtx({ sessionManager: makeSessionManager({ create }), sessionScratchDir: undefined });

    allocateStorySession(ctx);

    expect(create).toHaveBeenCalledTimes(1);
    expect(ctx.sessionId).toBe("sess-new");
    expect(ctx.sessionScratchDir).toBe(join(tmpDir, "sessions", "sess-new"));
  });

  test("falls back to the injected uuid under the feature's sessions dir when there is no feature", () => {
    _contextSessionDeps.uuid = () => STUB_UUID;
    const ctx = makeCtx({
      prd: makePRD({ feature: undefined }),
      featureDir: undefined,
      sessionScratchDir: undefined,
      sessionId: undefined,
    });

    allocateStorySession(ctx);

    expect(ctx.sessionId).toBe(STUB_UUID);
    expect(ctx.sessionScratchDir).toBe(join(featureDir(tmpDir, "_unattached"), "sessions", STUB_UUID));
  });

  test("honours a pre-set ctx.sessionId in the uuid fallback path", () => {
    _contextSessionDeps.uuid = () => STUB_UUID;
    const ctx = makeCtx({
      prd: makePRD({ feature: undefined }),
      featureDir: undefined,
      sessionScratchDir: undefined,
      sessionId: "sess-prior",
    });

    allocateStorySession(ctx);

    expect(ctx.sessionId).toBe("sess-prior");
    expect(ctx.sessionScratchDir).toBe(join(featureDir(tmpDir, "_unattached"), "sessions", "sess-prior"));
  });

  test("the default uuid factory returns a uuid, so a run without a SessionManager still gets one", () => {
    expect(origUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("creates the run call counter when absent, and leaves an existing one in place", () => {
    const ctx = makeCtx({ sessionScratchDir: join(tmpDir, "sessions", "sess-keep"), sessionId: "sess-keep" });
    expect(ctx.contextToolRunCounter).toBeUndefined();

    allocateStorySession(ctx);
    const counter = ctx.contextToolRunCounter;
    expect(counter).toBeDefined();
    expect(counter?.calls).toEqual([]);

    allocateStorySession(ctx);
    expect(ctx.contextToolRunCounter).toBe(counter);
  });
});

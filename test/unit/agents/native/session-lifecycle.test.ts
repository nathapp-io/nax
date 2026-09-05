// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentAdapter, makeNaxConfig } from "@test/helpers";
import {
  closeNativeSession,
  nativeSessionCompaction,
  nativeSessionLastUsage,
  nativeSessionTranscriptOwners,
  openNativeSession,
} from "@/agents/native/session/session";
import { loadTranscript, saveTranscript } from "@/agents/native/session/transcript-store";
import { nativeSessionId } from "@/agents/native/session-affinity";
import type { OpenSessionOpts, SendTurnOpts, SessionHandle } from "@/agents/session-types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-session-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const opts = (over: Partial<OpenSessionOpts> = {}): OpenSessionOpts => ({
  agentName: "native",
  workdir: "/tmp",
  resolvedPermissions: { mode: "approve-all" },
  modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
  timeoutSeconds: 60,
  transcriptDir: dir,
  ...over,
});

describe("native session lifecycle", () => {
  test("opening returns a handle naming the session and the native agent", async () => {
    const handle = await openNativeSession("sess-a", opts());
    expect(handle.id).toBe("sess-a");
    expect(handle.agentName).toBe("native");
  });

  test("a missing transcriptDir fails loudly rather than choosing a default", async () => {
    await expect(openNativeSession("sess-a", opts({ transcriptDir: undefined }))).rejects.toThrow(/transcriptDir/i);
  });

  test("a clean close deletes the transcript", async () => {
    const handle = await openNativeSession("sess-a", opts());
    await saveTranscript(dir, "sess-a", [{ role: "user", content: "hi" }]);
    await closeNativeSession(handle, false);
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
  });

  test("a failed close keeps the transcript for debugging, but not for resuming", async () => {
    // nax#1877: the keep branch used to leave the file at the exact path the
    // next same-named session reads, so "kept for post-mortem" and "kept to be
    // resumed" were indistinguishable. It is now retained under a name
    // loadTranscript cannot reach.
    const handle = await openNativeSession("sess-a", opts());
    await saveTranscript(dir, "sess-a", [{ role: "user", content: "hi" }]);
    await closeNativeSession(handle, true);

    const kept = (await readdir(dir)).filter((n) => n.startsWith("sess-a.transcript.failed-"));
    expect(kept).toHaveLength(1);
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
  });

  test("opening without resume clears a transcript an earlier session left behind", async () => {
    await saveTranscript(dir, "sess-a", [{ role: "user", content: "stale" }], "call-1");
    await openNativeSession("sess-a", opts({ resume: false }));
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
  });

  test("opening with resume keeps the transcript the retry needs", async () => {
    await saveTranscript(dir, "sess-a", [{ role: "user", content: "keep me" }], "call-1");
    await openNativeSession("sess-a", opts({ resume: true }));
    expect(await loadTranscript(dir, "sess-a", "call-1")).toHaveLength(1);
  });

  test("the transcript owner declared at open is what the turn loop reads back", async () => {
    const handle = await openNativeSession("sess-a", opts({ transcriptOwner: "call-1" }));
    expect(nativeSessionTranscriptOwners.get(handle.id)).toBe("call-1");
    await closeNativeSession(handle, false);
    expect(nativeSessionTranscriptOwners.has("sess-a")).toBe(false);
  });

  test("opening publishes the session identity it will send to the provider", async () => {
    const handle = await openNativeSession("sess-ids", opts());
    // Same value the adapter derives per call, so the audit trail records what
    // actually went on the wire rather than a parallel id.
    expect(handle.protocolIds?.recordId).toBe(nativeSessionId("sess-ids"));
    expect(handle.protocolIds?.sessionId).toBe(nativeSessionId("sess-ids"));
    await closeNativeSession(handle, false);
  });

  test("two different session names get different identities", async () => {
    const a = await openNativeSession("sess-one", opts());
    const b = await openNativeSession("sess-two", opts());
    expect(a.protocolIds?.recordId).not.toBe(b.protocolIds?.recordId);
    await closeNativeSession(a, false);
    await closeNativeSession(b, false);
  });
});

// ─── SessionManager forwarding ──────────────────────────────────────────────
//
// The manager.ts:484-ish forwarding of OpenSessionRequest.transcriptDir into
// adapter.openSession's OpenSessionOpts is untested elsewhere: the existing
// session-opts-threading.test.ts only pins the *type* accepting the field, and
// deleting the actual forwarding line leaves both typecheck and that test
// green. This test exercises SessionManager.openSession end-to-end through a
// fake adapter injected via the SessionManager({ getAdapter }) constructor
// seam — the established pattern in test/unit/session/manager-phase-b-session.test.ts
// — so it fails if the forwarding line in src/session/manager.ts is removed.
describe("SessionManager forwards transcriptDir to the adapter", () => {
  test("adapter.openSession receives the exact transcriptDir passed to SessionManager.openSession", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "native-fake" } satisfies SessionHandle;
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    const request: OpenSessionRequest = {
      agentName: "native-fake",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash", env: {} },
      timeoutSeconds: 60,
      transcriptDir: dir,
    };

    await sm.openSession("nax-transcript-wiring", request);

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].transcriptDir).toBe(dir);
  });

  // Same reasoning as transcriptDir above: deleting the transcriptOwner
  // forwarding line in src/session/manager.ts leaves typecheck green and the
  // ownership check in loadTranscript inert, because every session would then
  // open with an undefined owner and read whatever is on disk (nax#1877).
  test("adapter.openSession receives the transcriptOwner passed to SessionManager.openSession", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "native-fake" } satisfies SessionHandle;
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    await sm.openSession("nax-owner-wiring", {
      agentName: "native-fake",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash", env: {} },
      timeoutSeconds: 60,
      transcriptDir: dir,
      transcriptOwner: "call-1",
    } satisfies OpenSessionRequest);

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].transcriptOwner).toBe("call-1");
  });
});

// ─── SessionManager derives transcriptDir when the caller omits it ─────────
//
// Finding 1 (whole-branch review, 2026-09-02): nothing in the real call sites
// (session-run-hop.ts, build-hop-callback.ts) ever supplied transcriptDir, so
// every native session threw NATIVE_TRANSCRIPT_DIR_MISSING before a single
// turn ran. ADR-028 §3 documented deriving it inside SessionManager. Phase B's
// transcript relocation moved the root off the project tree entirely: the
// root is injected once via `configureRuntime({ transcriptRoot })` (mirroring
// the prompt-audit `outputDir` wiring in runtime/index.ts), not threaded
// per-request as `projectDir`. This test proves the derivation happens and
// lands under the injected root, not `<projectDir>/.nax/...`; it was verified
// to fail (by temporarily deleting the
// `?? deriveNativeTranscriptDir({ featureName: opts.featureName, transcriptRoot: this._transcriptRoot })`
// half of the forwarding line in src/session/manager.ts and restoring it) —
// see the fix report for the exact before/after.
describe("SessionManager derives transcriptDir when the caller omits it", () => {
  test("adapter.openSession receives a transcriptDir under the injected transcript root, not the project tree", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "native-fake" } satisfies SessionHandle;
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ transcriptRoot: "/tmp/nax-output-root" });
    const request: OpenSessionRequest = {
      agentName: "native-fake",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash", env: {} },
      timeoutSeconds: 60,
      featureName: "native-sessions-phase-b",
      // transcriptDir deliberately omitted — this is the derive-from-nothing case.
    };

    await sm.openSession("nax-derived-transcript", request);

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].transcriptDir).toBe(
      join("/tmp/nax-output-root", "features", "native-sessions-phase-b", "sessions"),
    );
    // Never derived under the project tree (the pre-relocation shape).
    expect(capturedOpts[0].transcriptDir).not.toContain(".nax");
  });

  test("an explicit caller-supplied transcriptDir still wins over derivation", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "native-fake" } satisfies SessionHandle;
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ transcriptRoot: "/tmp/nax-output-root" });
    const request: OpenSessionRequest = {
      agentName: "native-fake",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash", env: {} },
      timeoutSeconds: 60,
      featureName: "native-sessions-phase-b",
      transcriptDir: dir,
    };

    await sm.openSession("nax-explicit-transcript", request);

    expect(capturedOpts[0].transcriptDir).toBe(dir);
  });

  test("derivation leaves transcriptDir undefined when the transcript root was never configured", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "native-fake" } satisfies SessionHandle;
      }),
    });

    // No configureRuntime call — _transcriptRoot stays undefined.
    const sm = new SessionManager({ getAdapter: () => adapter });
    const request: OpenSessionRequest = {
      agentName: "native-fake",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash", env: {} },
      timeoutSeconds: 60,
      featureName: "native-sessions-phase-b",
    };

    await sm.openSession("nax-no-root-configured", request);

    expect(capturedOpts[0].transcriptDir).toBeUndefined();
  });

  test("derivation leaves transcriptDir undefined when featureName is missing", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "native-fake" } satisfies SessionHandle;
      }),
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ transcriptRoot: "/tmp/nax-output-root" });
    const request: OpenSessionRequest = {
      agentName: "native-fake",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash", env: {} },
      timeoutSeconds: 60,
      // featureName omitted.
    };

    await sm.openSession("nax-no-feature-name", request);

    expect(capturedOpts[0].transcriptDir).toBeUndefined();
  });
});

// ─── SessionManager forwards contextPullTools to sendTurn ──────────────────
//
// Finding 2 (whole-branch review, 2026-09-02): sendPrompt forwards
// `contextPullTools: opts?.contextPullTools` at manager.ts:~608, but only a
// type-level pin exists (session-opts-threading.test.ts) — deleting that
// forwarding line leaves typecheck and the whole suite green while making
// every native turn silently toolless. This test exercises the forwarding
// end-to-end through a fake adapter, mirroring the transcriptDir wiring test
// above. Verified to fail (by temporarily deleting the
// `contextPullTools: opts?.contextPullTools,` line in src/session/manager.ts
// and restoring it) — see the fix report for the exact before/after.
describe("SessionManager forwards contextPullTools to the adapter", () => {
  test("adapter.sendTurn receives the exact contextPullTools passed to SessionManager.sendPrompt", async () => {
    const capturedSendTurnOpts: SendTurnOpts[] = [];
    const handle: SessionHandle = { id: "nax-pull-tools", agentName: "native-fake" };
    const adapter = makeAgentAdapter({
      openSession: mock(async () => handle),
      sendTurn: mock(async (_handle: SessionHandle, _prompt: string, opts: SendTurnOpts) => {
        capturedSendTurnOpts.push(opts);
        return {
          output: "ok",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
        };
      }),
    });

    const pullTools = [
      {
        name: "query_neighbor",
        description: "d",
        inputSchema: { type: "object" },
        maxCallsPerSession: 5,
        maxTokensPerCall: 100,
      },
    ];

    const sm = new SessionManager({ getAdapter: () => adapter });
    await sm.sendPrompt(handle, "hi", { contextPullTools: pullTools });

    expect(capturedSendTurnOpts).toHaveLength(1);
    expect(capturedSendTurnOpts[0].contextPullTools).toBe(pullTools);
  });
});

// ─── SessionManager resolves execution.compaction into the adapter call ────
//
// Finding 1 (whole-branch review, 2026-09-04): nativeSessionCompaction can
// only ever be populated if adapter.openSession is called with a `compaction`
// field, but the real production path (SessionManager.openSessionImpl) never
// set it — despite `opts.config ?? this._config` already being in scope one
// line above for resolvedPermissions. This test exercises the forwarding
// end-to-end through a fake adapter, mirroring the transcriptDir/
// contextPullTools wiring tests above: a SessionManager constructed with a
// config carrying a non-default execution.compaction must produce an
// adapter.openSession call whose opts.compaction equals that value.
describe("SessionManager resolves execution.compaction into the adapter call", () => {
  test("adapter.openSession receives the config's execution.compaction value", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "native-fake" } satisfies SessionHandle;
      }),
    });

    const compaction = { enabled: true, compactAtPercent: 77, keepRecentPercent: 15 };
    const config = makeNaxConfig({ execution: { compaction } });

    const sm = new SessionManager({ getAdapter: () => adapter, config });
    const request: OpenSessionRequest = {
      agentName: "native-fake",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash", env: {} },
      timeoutSeconds: 60,
      transcriptDir: dir,
    };

    const handle = await sm.openSession("nax-compaction-wiring", request);

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].compaction).toEqual(compaction);
    expect(handle.id).toBe("nax-compaction-wiring");
  });
});

describe("native session compaction settings", () => {
  const settings = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

  test("openSession records the resolved settings for the turn to read", async () => {
    const handle = await openNativeSession("sess-cfg", opts({ compaction: settings }));
    expect(nativeSessionCompaction.get("sess-cfg")).toEqual(settings);
    await closeNativeSession(handle, false);
  });

  test("closing clears the settings and the usage anchor, like every other session map", async () => {
    const handle = await openNativeSession("sess-cfg2", opts({ compaction: settings }));
    nativeSessionLastUsage.set("sess-cfg2", { promptTokens: 10, anchorIndex: 0 });
    await closeNativeSession(handle, false);
    expect(nativeSessionCompaction.has("sess-cfg2")).toBe(false);
    expect(nativeSessionLastUsage.has("sess-cfg2")).toBe(false);
  });
});

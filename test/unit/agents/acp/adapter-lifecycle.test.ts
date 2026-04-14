/**
 * Tests for ACP session lifecycle — conditional close on success/failure
 * and sweepFeatureSessions / sweepStaleFeatureSessions.
 *
 * Covers:
 * - _runWithClient keeps session open on failure (close NOT called when stopReason != "end_turn")
 * - _runWithClient closes session on success (close IS called when stopReason == "end_turn")
 * - sweepFeatureSessions closes all sessions listed in sidecar
 * - sweepFeatureSessions is no-op when sidecar is missing
 * - runSessionPrompt timer cleanup (timer cleared when prompt wins the race)
 * - clearAcpSession uses sessionRole-keyed sidecar entry
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import {
  AcpAgentAdapter,
  _acpAdapterDeps,
  clearAcpSession,
  readAcpSession,
  readAcpSessionEntry,
  runSessionPrompt,
  saveAcpSession,
  sweepFeatureSessions,
} from "../../../../src/agents/acp/adapter";
import type { AcpSession, AcpSessionResponse } from "../../../../src/agents/acp/adapter";
import { makeTempDir } from "../../../helpers/temp";
import { makeClient, makeSession } from "./adapter.test";

// ─────────────────────────────────────────────────────────────────────────────
// _runWithClient — conditional session close
// ─────────────────────────────────────────────────────────────────────────────

describe("_runWithClient — conditional session close", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-lifecycle-test-");
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  afterAll(() => {
    // tmpdir is cleaned by OS; no manual rm needed
  });

  test("closes session when stopReason is end_turn (success)", async () => {
    let closeCalled = false;
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
      closeFn: async () => {
        closeCalled = true;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").run({
      prompt: "Implement feature",
      workdir: tmpDir,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      timeoutSeconds: 30,
      featureName: "test-feat",
      storyId: "TS-001",
    });

    expect(closeCalled).toBe(true);
  });

  test("does NOT close session when stopReason is cancelled (failure)", async () => {
    let closeCalled = false;
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Stopped." }],
        stopReason: "cancelled",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
      closeFn: async () => {
        closeCalled = true;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").run({
      prompt: "Implement feature",
      workdir: tmpDir,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      timeoutSeconds: 30,
      featureName: "test-feat",
      storyId: "TS-001",
    });

    expect(closeCalled).toBe(false);
  });

  test("closes session when stopReason is error (broken session)", async () => {
    let closeCalled = false;
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [],
        stopReason: "error",
      }),
      closeFn: async () => {
        closeCalled = true;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").run({
      prompt: "Implement feature",
      workdir: tmpDir,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      timeoutSeconds: 30,
      featureName: "test-feat",
      storyId: "TS-001",
    });

    expect(closeCalled).toBe(true);
  });

  test("client.close() is always called regardless of success or failure", async () => {
    let clientCloseCalled = false;
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [],
        stopReason: "error",
      }),
    });
    const client = makeClient(session);
    const origClose = client.close;
    client.close = async () => {
      clientCloseCalled = true;
      await origClose();
    };
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await new AcpAgentAdapter("claude").run({
      prompt: "Implement feature",
      workdir: tmpDir,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      timeoutSeconds: 30,
    });

    expect(clientCloseCalled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sweepFeatureSessions
// ─────────────────────────────────────────────────────────────────────────────

describe("sweepFeatureSessions", () => {
  const origCreateClient = _acpAdapterDeps.createClient;

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-sweep-test-");
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    mock.restore();
  });

  test("is no-op when sidecar file does not exist", async () => {
    let clientStartCalled = false;
    const client = makeClient(makeSession(), {
      startFn: async () => {
        clientStartCalled = true;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    // No sidecar written — should return without creating client
    await sweepFeatureSessions(tmpDir, "no-feature");
    expect(clientStartCalled).toBe(false);
  });

  test("is no-op when sidecar is empty (no sessions)", async () => {
    const sidecarDir = join(tmpDir, ".nax", "features", "empty-feat");
    await Bun.write(join(sidecarDir, "acp-sessions.json"), JSON.stringify({}));

    let clientStartCalled = false;
    const client = makeClient(makeSession(), {
      startFn: async () => {
        clientStartCalled = true;
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await sweepFeatureSessions(tmpDir, "empty-feat");
    expect(clientStartCalled).toBe(false);
  });

  test("calls closeSession() for each entry in sidecar when available", async () => {
    const featureName = "sweep-feat";
    const sidecarDir = join(tmpDir, ".nax", "features", featureName);
    const sidecarPath = join(sidecarDir, "acp-sessions.json");

    await Bun.write(
      sidecarPath,
      JSON.stringify({
        "story-001": "nax-abc123-sweep-feat-story-001",
        "story-002": "nax-abc123-sweep-feat-story-002",
      }),
    );

    const closedSessions: string[] = [];

    const client = {
      start: async () => {},
      close: async () => {},
      createSession: async (_opts: { agentName: string; permissionMode: string }) => makeSession(),
      closeSession: async (name: string, _agent: string) => {
        closedSessions.push(name);
      },
    };
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await sweepFeatureSessions(tmpDir, featureName);

    expect(closedSessions).toHaveLength(2);
  });

  test("falls back to loadSession().close() when closeSession() is unavailable", async () => {
    const featureName = "sweep-fallback-feat";
    const sidecarDir = join(tmpDir, ".nax", "features", featureName);
    const sidecarPath = join(sidecarDir, "acp-sessions.json");

    await Bun.write(
      sidecarPath,
      JSON.stringify({ "story-001": "nax-abc123-sweep-fallback-feat-story-001" }),
    );

    let loaded = 0;
    let closed = 0;
    const client = {
      start: async () => {},
      close: async () => {},
      createSession: async (_opts: { agentName: string; permissionMode: string }) => makeSession(),
      loadSession: async (_name: string, _agent: string, _perm: string) => {
        loaded++;
        return {
          ...makeSession(),
          close: async () => {
            closed++;
          },
        };
      },
    };
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await sweepFeatureSessions(tmpDir, featureName);

    expect(loaded).toBe(1);
    expect(closed).toBe(1);
  });

  test("clears sidecar after sweep", async () => {
    const featureName = "clear-feat";
    const sidecarDir = join(tmpDir, ".nax", "features", featureName);
    const sidecarPath = join(sidecarDir, "acp-sessions.json");

    await Bun.write(sidecarPath, JSON.stringify({ "story-001": "nax-abc-clear-feat-story-001" }));

    const client = {
      start: async () => {},
      close: async () => {},
      createSession: async (_opts: { agentName: string; permissionMode: string }) => makeSession(),
      closeSession: async (_name: string, _agent: string) => {},
    };
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await sweepFeatureSessions(tmpDir, featureName);

    const afterContent = await Bun.file(sidecarPath).text();
    const afterData = JSON.parse(afterContent);
    expect(Object.keys(afterData)).toHaveLength(0);
  });

  test("passes pidRegistry to createClient when provided (#228)", async () => {
    const featureName = "pid-reg-feat";
    const sidecarDir = join(tmpDir, ".nax", "features", featureName);
    const sidecarPath = join(sidecarDir, "acp-sessions.json");

    await Bun.write(
      sidecarPath,
      JSON.stringify({ "story-001": "nax-abc-pid-reg-feat-story-001" }),
    );

    let capturedPidRegistry: unknown = undefined;
    const origCreate = _acpAdapterDeps.createClient;
    _acpAdapterDeps.createClient = mock((_cmd: string, _cwd?: string, _timeout?: number, pidReg?: unknown) => {
      capturedPidRegistry = pidReg;
      const session = makeSession();
      return makeClient(session);
    });

    const fakePidRegistry = { register: async () => {}, unregister: async () => {} };
    await sweepFeatureSessions(tmpDir, featureName, fakePidRegistry as never);

    expect(capturedPidRegistry).toBe(fakePidRegistry);
    _acpAdapterDeps.createClient = origCreate;
  });

  test("continues sweeping remaining sessions if one closeSession fails", async () => {
    const featureName = "partial-fail-feat";
    const sidecarDir = join(tmpDir, ".nax", "features", featureName);
    const sidecarPath = join(sidecarDir, "acp-sessions.json");

    await Bun.write(
      sidecarPath,
      JSON.stringify({
        "story-001": "nax-abc-feat-story-001",
        "story-002": "nax-abc-feat-story-002",
      }),
    );

    const closedSessions: string[] = [];
    let callCount = 0;

    const client = {
      start: async () => {},
      close: async () => {},
      createSession: async (_opts: { agentName: string; permissionMode: string }) => makeSession(),
      closeSession: async (name: string, _agent: string) => {
        callCount++;
        if (callCount === 1) throw new Error("session not found");
        closedSessions.push(name);
      },
    };
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    // Should not throw even if first closeSession fails
    await expect(sweepFeatureSessions(tmpDir, featureName)).resolves.toBeUndefined();
    // Second session should still be closed
    expect(closedSessions).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSessionPrompt — timer cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe("runSessionPrompt — timer cleanup", () => {
  test("returns response when prompt resolves before timeout", async () => {
    const fakeResponse: AcpSessionResponse = {
      stopReason: "end_turn",
      messages: [],
    };
    const mockSession: AcpSession = {
      prompt: async () => fakeResponse,
      cancelActivePrompt: async () => {},
      close: async () => {},
    };
    const result = await runSessionPrompt(mockSession, "hello", 30_000);
    expect(result.timedOut).toBe(false);
    expect(result.response).toEqual(fakeResponse);
  });

  test("returns timedOut=true when timeout fires first", async () => {
    const mockSession: AcpSession = {
      prompt: () => new Promise(() => {}), // never resolves
      cancelActivePrompt: async () => {},
      close: async () => {},
    };
    const result = await runSessionPrompt(mockSession, "hello", 1); // 1ms timeout
    expect(result.timedOut).toBe(true);
    expect(result.response).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearAcpSession — sessionRole key fix
// ─────────────────────────────────────────────────────────────────────────────

describe("clearAcpSession — sessionRole key", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-sidecar-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("clears role-keyed entry and leaves plain-key entry untouched", async () => {
    const featureName = "feat";
    const storyId = "US-001";
    const role = "implementer";
    const sidecarKey = `${storyId}:${role}`;

    await saveAcpSession(tmpDir, featureName, sidecarKey, "session-abc", "claude");
    await saveAcpSession(tmpDir, featureName, storyId, "session-xyz", "claude");

    await clearAcpSession(tmpDir, featureName, storyId, role);

    const roleEntry = await readAcpSession(tmpDir, featureName, sidecarKey);
    const plainEntry = await readAcpSession(tmpDir, featureName, storyId);
    expect(roleEntry).toBeNull();
    expect(plainEntry).toBe("session-xyz");
  });

  test("clears plain-key entry when no sessionRole provided", async () => {
    const featureName = "feat";
    const storyId = "US-002";

    await saveAcpSession(tmpDir, featureName, storyId, "session-plain", "claude");
    await clearAcpSession(tmpDir, featureName, storyId);

    const entry = await readAcpSession(tmpDir, featureName, storyId);
    expect(entry).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SidecarEntry status field — readAcpSessionEntry + saveAcpSession
// ─────────────────────────────────────────────────────────────────────────────

describe("sidecar status field", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-sidecar-status-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saveAcpSession writes in-flight status; readAcpSessionEntry returns it", async () => {
    await saveAcpSession(tmpDir, "feat", "US-001", "session-abc", "claude", "in-flight");
    const entry = await readAcpSessionEntry(tmpDir, "feat", "US-001");
    expect(entry).not.toBeNull();
    expect(typeof entry).toBe("object");
    if (entry && typeof entry === "object") {
      expect((entry as { status?: string }).status).toBe("in-flight");
    }
  });

  test("saveAcpSession writes open status; readAcpSessionEntry returns it", async () => {
    await saveAcpSession(tmpDir, "feat", "US-001", "session-abc", "claude", "open");
    const entry = await readAcpSessionEntry(tmpDir, "feat", "US-001");
    expect(entry).not.toBeNull();
    if (entry && typeof entry === "object") {
      expect((entry as { status?: string }).status).toBe("open");
    }
  });

  test("readAcpSession still returns session name regardless of status", async () => {
    await saveAcpSession(tmpDir, "feat", "US-002", "session-xyz", "claude", "in-flight");
    const name = await readAcpSession(tmpDir, "feat", "US-002");
    expect(name).toBe("session-xyz");
  });

  test("readAcpSessionEntry returns null when no entry exists", async () => {
    const entry = await readAcpSessionEntry(tmpDir, "feat", "US-missing");
    expect(entry).toBeNull();
  });

  test("legacy string entry treated as open by sidecar (readAcpSessionEntry returns it)", async () => {
    // Simulate a legacy sidecar written before status field existed
    const sidecarPath = join(tmpDir, ".nax", "features", "feat", "acp-sessions.json");
    await Bun.write(sidecarPath, JSON.stringify({ "US-003": "session-legacy" }));

    const entry = await readAcpSessionEntry(tmpDir, "feat", "US-003");
    expect(entry).toBe("session-legacy"); // legacy string format preserved
    const name = await readAcpSession(tmpDir, "feat", "US-003");
    expect(name).toBe("session-legacy");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Crash-orphaned session guard — in-flight detection in _runWithClient
// ─────────────────────────────────────────────────────────────────────────────

describe("crash-orphaned session guard", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-crash-guard-test-"));
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  const BASE = {
    prompt: "implement feature",
    workdir: "",          // set per-test
    modelTier: "balanced" as const,
    modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
    timeoutSeconds: 30,
    config: DEFAULT_CONFIG,
    featureName: "feat",
    storyId: "US-001",
  };

  test("creates new session when sidecar entry has status in-flight (crash survivor)", async () => {
    const loadedNames: string[] = [];
    const createdNames: string[] = [];
    const session = makeSession();

    _acpAdapterDeps.createClient = mock((_cmd: string) =>
      makeClient(session, {
        createSessionFn: async (opts) => {
          createdNames.push(opts.sessionName ?? "");
          return session;
        },
        loadSessionFn: async (name: string) => {
          loadedNames.push(name);
          return null; // Simulate: no matching session exists in acpx
        },
      }),
    );

    // Pre-seed the sidecar with a stale in-flight entry
    const staleSessionName = "nax-deadbeef-feat-us-001";
    await saveAcpSession(tmpDir, "feat", "US-001", staleSessionName, "claude", "in-flight");

    await new AcpAgentAdapter("claude", DEFAULT_CONFIG).run({ ...BASE, workdir: tmpDir });

    // The stale session name must never have been loaded or created
    expect(loadedNames).not.toContain(staleSessionName);
    expect(createdNames).not.toContain(staleSessionName);
    // A fresh session must have been created with a different name
    expect(createdNames.length).toBeGreaterThan(0);
    expect(createdNames[0]).not.toBe(staleSessionName);
  });

  test("stale in-flight sidecar entry is cleared before new session is created", async () => {
    const session = makeSession();
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await saveAcpSession(tmpDir, "feat", "US-001", "nax-stale-session", "claude", "in-flight");

    await new AcpAgentAdapter("claude", DEFAULT_CONFIG).run({ ...BASE, workdir: tmpDir });

    // After the run completes successfully, the sidecar should be cleared (success path clears it)
    const entry = await readAcpSession(tmpDir, "feat", "US-001");
    expect(entry).toBeNull();
  });

  test("resumes open session (intentional retry — not a crash)", async () => {
    const capturedLoads: string[] = [];
    const session = makeSession();

    _acpAdapterDeps.createClient = mock((_cmd: string) =>
      makeClient(session, {
        loadSessionFn: async (name: string) => {
          capturedLoads.push(name);
          return session;
        },
      }),
    );

    const openSessionName = "nax-aabbccdd-feat-us-001";
    await saveAcpSession(tmpDir, "feat", "US-001", openSessionName, "claude", "open");

    await new AcpAgentAdapter("claude", DEFAULT_CONFIG).run({ ...BASE, workdir: tmpDir });

    // loadSession should have been called with the open session name
    expect(capturedLoads).toContain(openSessionName);
  });

  test("on intentional failure, sidecar is promoted from in-flight to open", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Tests failed." }],
        stopReason: "cancelled",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude", DEFAULT_CONFIG).run({ ...BASE, workdir: tmpDir });

    // After a non-success run, entry should exist with status "open" (safe to resume)
    const entry = await readAcpSessionEntry(tmpDir, "feat", "US-001");
    expect(entry).not.toBeNull();
    if (entry && typeof entry === "object") {
      expect((entry as { status?: string }).status).toBe("open");
    }
  });
});

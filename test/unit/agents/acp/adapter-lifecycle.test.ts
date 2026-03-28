/**
 * Tests for ACP session lifecycle — conditional close on success/failure
 * and sweepFeatureSessions / sweepStaleFeatureSessions.
 *
 * Covers:
 * - _runWithClient keeps session open on failure (close NOT called when stopReason != "end_turn")
 * - _runWithClient closes session on success (close IS called when stopReason == "end_turn")
 * - sweepFeatureSessions closes all sessions listed in sidecar
 * - sweepFeatureSessions is no-op when sidecar is missing
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgentAdapter, _acpAdapterDeps, sweepFeatureSessions } from "../../../../src/agents/acp/adapter";
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

  test("does NOT close session when stopReason is error (failure)", async () => {
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

    expect(closeCalled).toBe(false);
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

  test("calls loadSession and session.close() for each entry in sidecar", async () => {
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

    const loadedSessions: string[] = [];
    const closedSessions: string[] = [];

    const makeLoadableSession = (name: string) => ({
      prompt: async (_: string) => ({ messages: [], stopReason: "end_turn" }),
      close: async () => {
        closedSessions.push(name);
      },
      cancelActivePrompt: async () => {},
    });

    const client = {
      start: async () => {},
      close: async () => {},
      createSession: async (_opts: { agentName: string; permissionMode: string }) => makeLoadableSession("new"),
      loadSession: async (name: string, _agent: string, _perm: string) => {
        loadedSessions.push(name);
        return makeLoadableSession(name);
      },
    };
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await sweepFeatureSessions(tmpDir, featureName);

    expect(loadedSessions).toHaveLength(2);
    expect(closedSessions).toHaveLength(2);
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
      loadSession: async (_name: string, _agent: string, _perm: string) => makeSession(),
    };
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    await sweepFeatureSessions(tmpDir, featureName);

    const afterContent = await Bun.file(sidecarPath).text();
    const afterData = JSON.parse(afterContent);
    expect(Object.keys(afterData)).toHaveLength(0);
  });

  test("continues sweeping remaining sessions if one loadSession fails", async () => {
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
      loadSession: async (name: string, _agent: string, _perm: string) => {
        callCount++;
        if (callCount === 1) throw new Error("session not found");
        return {
          prompt: async (_: string) => ({ messages: [], stopReason: "end_turn" }),
          close: async () => {
            closedSessions.push(name);
          },
          cancelActivePrompt: async () => {},
        };
      },
    };
    _acpAdapterDeps.createClient = mock((_cmd: string) => client);

    // Should not throw even if first loadSession fails
    await expect(sweepFeatureSessions(tmpDir, featureName)).resolves.toBeUndefined();
    // Second session should still be closed
    expect(closedSessions).toHaveLength(1);
  });
});

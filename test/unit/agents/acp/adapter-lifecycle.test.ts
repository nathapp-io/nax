/**
 * Tests for ACP session lifecycle — conditional close on success/failure.
 *
 * Covers:
 * - run() keeps session open on failure (close NOT called when stopReason != "end_turn")
 * - run() closes session on success (close IS called when stopReason == "end_turn")
 * - run() closes broken session (stopReason == "error")
 * - runSessionPrompt timer cleanup (timer cleared when prompt wins the race)
 *
 * Note: sidecar tests (saveAcpSession, sweepFeatureSessions, clearAcpSession, readAcpSession,
 * readAcpSessionEntry, crash-orphaned guard) were removed in Phase 3 (#477) when the sidecar
 * persistence layer was deleted from adapter.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import {
  AcpAgentAdapter,
  _acpAdapterDeps,
  runSessionPrompt,
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

    await new AcpAgentAdapter("claude", DEFAULT_CONFIG).run({
      prompt: "Implement feature",
      workdir: tmpDir,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      timeoutSeconds: 30,
      featureName: "test-feat",
      storyId: "TS-001",
      config: DEFAULT_CONFIG,
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

    await new AcpAgentAdapter("claude", DEFAULT_CONFIG).run({
      prompt: "Implement feature",
      workdir: tmpDir,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      timeoutSeconds: 30,
      featureName: "test-feat",
      storyId: "TS-001",
      config: DEFAULT_CONFIG,
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

    await new AcpAgentAdapter("claude", DEFAULT_CONFIG).run({
      prompt: "Implement feature",
      workdir: tmpDir,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      timeoutSeconds: 30,
      featureName: "test-feat",
      storyId: "TS-001",
      config: DEFAULT_CONFIG,
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

    await new AcpAgentAdapter("claude", DEFAULT_CONFIG).run({
      prompt: "Implement feature",
      workdir: tmpDir,
      modelTier: "balanced",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      timeoutSeconds: 30,
      config: DEFAULT_CONFIG,
    });

    expect(clientCloseCalled).toBe(true);
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

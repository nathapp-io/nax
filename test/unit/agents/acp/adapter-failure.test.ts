/**
 * Tests for AcpAgentAdapter — adapterFailure taxonomy (Issue #476)
 *
 * Verifies that AgentResult.adapterFailure is populated correctly for all
 * failure paths in run() and _runWithClient():
 *   - success → adapterFailure undefined
 *   - timeout (exitCode 124) → fail-timeout
 *   - session error non-retryable → fail-adapter-error, retriable: false
 *   - session error retryable → fail-adapter-error, retriable: true
 *   - rate-limit exhausted (no fallback) → fail-rate-limit
 *   - generic unknown error → fail-unknown
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { withDepsRestore } from "../../../helpers/deps";
import { makeClient, makeRunOptions, makeSession } from "./adapter.test";

// ─────────────────────────────────────────────────────────────────────────────
// adapterFailure taxonomy
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter — adapterFailure taxonomy", () => {
  let adapter: AcpAgentAdapter;

  withDepsRestore(_acpAdapterDeps, ["createClient", "sleep", "shouldRetrySessionError"]);

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude");
    _acpAdapterDeps.sleep = async () => {};
    _acpAdapterDeps.shouldRetrySessionError = false;
  });

  afterEach(() => {
    mock.restore();
  });

  test("success path — adapterFailure is undefined", async () => {
    const session = makeSession();
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await adapter.run(makeRunOptions());
    expect(result.success).toBe(true);
    expect(result.adapterFailure).toBeUndefined();
  });

  test("timeout (exitCode 124) — fail-timeout, retriable: true", async () => {
    // Simulate a session that never resolves (prompt hangs)
    let cancel: (() => void) | undefined;
    const session = makeSession({
      promptFn: async () => {
        await new Promise<void>((_, reject) => {
          cancel = () => reject(new Error("cancelled"));
        });
        return { messages: [], stopReason: "cancelled" };
      },
      cancelFn: async () => { cancel?.(); },
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await adapter.run(makeRunOptions({ timeoutSeconds: 0.001 }));

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.adapterFailure).toBeDefined();
    expect(result.adapterFailure?.outcome).toBe("fail-timeout");
    expect(result.adapterFailure?.category).toBe("quality");
    expect(result.adapterFailure?.retriable).toBe(true);
  });

  test("session error (stopReason=error, non-retryable) — fail-adapter-error, retriable: false", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [],
        stopReason: "error",
        retryable: false,
      }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await adapter.run(makeRunOptions());

    expect(result.success).toBe(false);
    expect(result.sessionError).toBe(true);
    expect(result.adapterFailure).toBeDefined();
    expect(result.adapterFailure?.outcome).toBe("fail-adapter-error");
    expect(result.adapterFailure?.category).toBe("quality");
    expect(result.adapterFailure?.retriable).toBe(false);
  });

  test("session error (stopReason=error, retryable=true) — fail-adapter-error, retriable: true", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [],
        stopReason: "error",
        retryable: true,
      }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await adapter.run(makeRunOptions());

    expect(result.success).toBe(false);
    expect(result.sessionError).toBe(true);
    expect(result.sessionErrorRetryable).toBe(true);
    expect(result.adapterFailure).toBeDefined();
    expect(result.adapterFailure?.outcome).toBe("fail-adapter-error");
    expect(result.adapterFailure?.retriable).toBe(true);
  });

  test("cancelled (stopReason=cancelled) — fail-unknown, retriable: false", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [],
        stopReason: "cancelled",
      }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await adapter.run(makeRunOptions());

    expect(result.success).toBe(false);
    expect(result.adapterFailure).toBeDefined();
    expect(result.adapterFailure?.outcome).toBe("fail-unknown");
    expect(result.adapterFailure?.category).toBe("quality");
    expect(result.adapterFailure?.retriable).toBe(false);
  });

  test("rate-limit exhausted (no fallback, legacy path) — fail-rate-limit, retriable: true", async () => {
    // Rate-limit must come from a failed run (stopReason !== end_turn) whose output
    // contains a 429 pattern. The legacy backoff path exhausts after 3 attempts.
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "429 Rate limit exceeded. retry after 30" }],
        stopReason: "cancelled", // non-success so the output is parsed for rate-limit
      }),
    });
    _acpAdapterDeps.createClient = mock(() => makeClient(session));

    const result = await adapter.run(makeRunOptions());

    expect(result.success).toBe(false);
    expect(result.rateLimited).toBe(true);
    expect(result.adapterFailure).toBeDefined();
    expect(result.adapterFailure?.outcome).toBe("fail-rate-limit");
    expect(result.adapterFailure?.category).toBe("availability");
    expect(result.adapterFailure?.retriable).toBe(true);
    expect(result.adapterFailure?.retryAfterSeconds).toBe(30);
  });

  test("unknown error from client — fail-unknown, retriable: false", async () => {
    // Simulate createClient throwing an unknown error (not rate-limit, not auth)
    _acpAdapterDeps.createClient = mock(() => {
      return {
        start: async () => { throw new Error("ECONNREFUSED: connection refused"); },
        close: async () => {},
        createSession: async () => makeSession(),
        cancelActivePrompt: async () => {},
      };
    });

    const result = await adapter.run(makeRunOptions());

    expect(result.success).toBe(false);
    expect(result.adapterFailure).toBeDefined();
    expect(result.adapterFailure?.outcome).toBe("fail-unknown");
    expect(result.adapterFailure?.category).toBe("quality");
    expect(result.adapterFailure?.retriable).toBe(false);
  });
});

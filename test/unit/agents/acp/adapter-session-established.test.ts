/**
 * AcpAgentAdapter.run() — onSessionEstablished callback (#591).
 *
 * Contract: the adapter must fire `options.onSessionEstablished(protocolIds,
 * sessionName)` once, after `ensureAcpSession` succeeds and BEFORE the first
 * prompt is sent. This gives SessionManager.runInSession a chance to bind
 * protocolIds eagerly so an interrupted run still leaves a resumable
 * descriptor on disk.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { makeClient, makeRunOptions, makeSession } from "./adapter.test";

describe("AcpAgentAdapter.run() — onSessionEstablished (#591)", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  beforeEach(() => {
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  test("fires callback before the prompt is sent", async () => {
    const observed: Array<{ stage: string; protocolIds?: unknown; sessionName?: string }> = [];

    const session = makeSession({
      promptFn: async (_text: string) => {
        observed.push({ stage: "prompt" });
        return {
          messages: [{ role: "assistant", content: "done" }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    });
    // Assign ACP protocol ids on the mock session so the adapter reports them.
    (session as unknown as { recordId: string; id: string }).recordId = "rec-123";
    (session as unknown as { recordId: string; id: string }).id = "acp-456";

    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").run(
      makeRunOptions({
        onSessionEstablished: (protocolIds, sessionName) => {
          observed.push({ stage: "established", protocolIds, sessionName });
        },
      }),
    );

    // Must fire exactly once, and must be ordered BEFORE the prompt.
    const establishedIdx = observed.findIndex((o) => o.stage === "established");
    const promptIdx = observed.findIndex((o) => o.stage === "prompt");
    expect(establishedIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(establishedIdx).toBeLessThan(promptIdx);

    // Protocol ids reported match the mock session.
    expect(observed[establishedIdx]?.protocolIds).toEqual({ recordId: "rec-123", sessionId: "acp-456" });
    // Session name is well-formed (nax-<hash>-...).
    expect(observed[establishedIdx]?.sessionName).toMatch(/^nax-/);
  });

  test("callback throw is swallowed — run completes normally", async () => {
    const session = makeSession();
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(
      makeRunOptions({
        onSessionEstablished: () => {
          throw new Error("callback boom");
        },
      }),
    );

    expect(result.success).toBe(true);
  });

  test("callback is optional — run works without it", async () => {
    const session = makeSession();
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(result.success).toBe(true);
  });
});

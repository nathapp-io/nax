/**
 * AcpAgentAdapter.run() — abortSignal behaviour (Issue 5 fix).
 *
 * When options.abortSignal is already aborted, run() must NOT spawn a client
 * at all — return early with fail-aborted. This prevents the adapter's retry
 * loop from registering new processes during shutdown.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { makeClient, makeRunOptions, makeSession } from "./adapter.test";

describe("AcpAgentAdapter.run() — abortSignal", () => {
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

  test("pre-aborted signal short-circuits before createClient is called", async () => {
    let createClientCalls = 0;
    const session = makeSession();
    _acpAdapterDeps.createClient = mock((_cmd: string) => {
      createClientCalls += 1;
      return makeClient(session);
    });

    const controller = new AbortController();
    controller.abort();

    const result = await new AcpAgentAdapter("claude").run(
      makeRunOptions({ abortSignal: controller.signal }),
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(130);
    expect(result.adapterFailure?.outcome).toBe("fail-aborted");
    expect(result.adapterFailure?.category).toBe("availability");
    expect(result.adapterFailure?.retriable).toBe(false);
    // Crucial: no client was ever spawned.
    expect(createClientCalls).toBe(0);
  });

  test("un-aborted signal is transparent — run proceeds normally", async () => {
    const session = makeSession();
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const controller = new AbortController();
    const result = await new AcpAgentAdapter("claude").run(
      makeRunOptions({ abortSignal: controller.signal }),
    );

    expect(result.success).toBe(true);
    expect(result.adapterFailure).toBeUndefined();
  });

  test("mid-turn abort returns fail-aborted", async () => {
    const session = makeSession({
      promptFn: () => new Promise(() => {}),
      cancelFn: async () => {},
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const result = await new AcpAgentAdapter("claude").run(
      makeRunOptions({ abortSignal: controller.signal, timeoutSeconds: 30 }),
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(130);
    expect(result.adapterFailure?.outcome).toBe("fail-aborted");
    expect(result.adapterFailure?.retriable).toBe(false);
  });
});

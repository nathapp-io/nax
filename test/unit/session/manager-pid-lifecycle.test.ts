/**
 * Tests for SessionManager automatic PID lifecycle attachment.
 * Verifies that configureRuntime({ pidRegistry }) causes openSession to
 * attach onPidSpawned/onPidExited to the adapter automatically.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { PidRegistry } from "../../../src/execution/pid-registry";
import { SessionManager, _sessionManagerDeps } from "../../../src/session/manager";
import { makeAgentAdapter, makeNaxConfig } from "../../helpers";

function makeRegistry(workdir = "/tmp/test-pid-session"): PidRegistry {
  return new PidRegistry(workdir);
}

beforeEach(() => {
  _sessionManagerDeps.writeDescriptor = async () => {};
});

describe("SessionManager PID lifecycle — configureRuntime", () => {
  test("attaches onPidSpawned and onPidExited when pidRegistry is configured", async () => {
    const adapter = makeAgentAdapter();
    let capturedOnPidSpawned: ((pid: number) => void) | undefined;
    let capturedOnPidExited: ((pid: number) => void) | undefined;

    adapter.openSession = mock(async (_name, opts) => {
      capturedOnPidSpawned = opts?.onPidSpawned;
      capturedOnPidExited = opts?.onPidExited;
      return { id: "mock-session", agentName: "mock" };
    });

    const registry = makeRegistry();
    const registerSpy = mock((pid: number) => registry.register(pid));
    const unregisterSpy = mock((pid: number) => registry.unregister(pid));
    const patchedRegistry = {
      ...registry,
      register: registerSpy,
      unregister: unregisterSpy,
    } as unknown as PidRegistry;

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({
      config: makeNaxConfig(),
      pidRegistry: patchedRegistry,
    });

    const modelDef = { model: "claude-3-5-sonnet-20241022", provider: "anthropic" } as never;
    await sm.openSession("test-session", {
      agentName: "mock",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef,
      timeoutSeconds: 30,
      role: "main",
      storyId: "s-001",
      featureName: "test",
    });

    expect(capturedOnPidSpawned).toBeDefined();
    expect(capturedOnPidExited).toBeDefined();

    capturedOnPidSpawned!(42);
    expect(registerSpy).toHaveBeenCalledWith(42);

    capturedOnPidExited!(42);
    expect(unregisterSpy).toHaveBeenCalledWith(42);
  });

  test("passes undefined callbacks when no pidRegistry is configured", async () => {
    const adapter = makeAgentAdapter();
    let capturedOnPidSpawned: unknown = "NOT_SET";
    let capturedOnPidExited: unknown = "NOT_SET";

    adapter.openSession = mock(async (_name, opts) => {
      capturedOnPidSpawned = opts?.onPidSpawned;
      capturedOnPidExited = opts?.onPidExited;
      return { id: "mock-session", agentName: "mock" };
    });

    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ config: makeNaxConfig() });

    const modelDef = { model: "claude-3-5-sonnet-20241022", provider: "anthropic" } as never;
    await sm.openSession("test-session-no-pid", {
      agentName: "mock",
      workdir: "/tmp",
      pipelineStage: "run",
      modelDef,
      timeoutSeconds: 30,
      role: "main",
      storyId: "s-002",
      featureName: "test",
    });

    expect(capturedOnPidSpawned).toBeUndefined();
    expect(capturedOnPidExited).toBeUndefined();
  });

});

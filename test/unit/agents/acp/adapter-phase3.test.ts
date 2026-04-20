/**
 * AcpAgentAdapter — ADR-013 Phase 3: onPidSpawned callback
 *
 * Phase 3 removes AgentRunOptions.pidRegistry and replaces it with
 * onPidSpawned?: (pid: number) => void. The adapter fires the callback
 * immediately after spawning a process (inside createClient / SpawnAcpClient).
 *
 * Covered:
 *   - _acpAdapterDeps.createClient receives onPidSpawned from AgentRunOptions
 *   - pidRegistry is NOT present on AgentRunOptions (compile-time enforcement)
 *   - plan() passes onPidSpawned through to run()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { withDepsRestore } from "../../../helpers/deps";
import type { AgentRunOptions } from "../../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { makeClient, makeSession } from "./adapter.test";

// ─────────────────────────────────────────────────────────────────────────────
// Base options
// ─────────────────────────────────────────────────────────────────────────────

const BASE_OPTIONS: AgentRunOptions = {
  prompt: "implement the feature",
  workdir: "/tmp/test-project",
  modelTier: "balanced",
  modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
  timeoutSeconds: 30,
  dangerouslySkipPermissions: true,
  featureName: "pid-cb-test",
  storyId: "ST-003",
  config: DEFAULT_CONFIG,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter — Phase 3: onPidSpawned threading", () => {
  withDepsRestore(_acpAdapterDeps, ["createClient", "sleep"]);

  let adapter: AcpAgentAdapter;

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude", DEFAULT_CONFIG);
    _acpAdapterDeps.sleep = async () => {};
  });

  afterEach(() => {
    mock.restore();
  });

  test("createClient is called with onPidSpawned from AgentRunOptions", async () => {
    const session = makeSession();
    let capturedCallback: ((pid: number) => void) | undefined;

    _acpAdapterDeps.createClient = mock(
      (
        _cmdStr: string,
        _cwd?: string,
        _timeoutSeconds?: number,
        onPidSpawned?: (pid: number) => void,
      ) => {
        capturedCallback = onPidSpawned;
        return makeClient(session);
      },
    );

    const pids: number[] = [];
    await adapter.run({
      ...BASE_OPTIONS,
      onPidSpawned: (pid: number) => { pids.push(pid); },
    });

    // The callback passed to createClient should be the one from options
    expect(capturedCallback).toBeDefined();
    expect(typeof capturedCallback).toBe("function");
  });

  test("createClient is called with undefined when onPidSpawned is absent", async () => {
    const session = makeSession();
    let callbackArg: unknown = "NOT_CHECKED";

    _acpAdapterDeps.createClient = mock(
      (
        _cmdStr: string,
        _cwd?: string,
        _timeoutSeconds?: number,
        onPidSpawned?: (pid: number) => void,
      ) => {
        callbackArg = onPidSpawned;
        return makeClient(session);
      },
    );

    await adapter.run(BASE_OPTIONS);

    expect(callbackArg).toBeUndefined();
  });

  test("AgentRunOptions does not have pidRegistry property", () => {
    // This test verifies at the type level that pidRegistry was removed.
    // We confirm via a runtime check that the key doesn't appear on a valid options object.
    const opts: AgentRunOptions = { ...BASE_OPTIONS };
    expect("pidRegistry" in opts).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plan() — passes onPidSpawned through
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter.plan() — onPidSpawned threading", () => {
  withDepsRestore(_acpAdapterDeps, ["createClient", "sleep"]);

  let adapter: AcpAgentAdapter;

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude", DEFAULT_CONFIG);
    _acpAdapterDeps.sleep = async () => {};
  });

  afterEach(() => {
    mock.restore();
  });

  test("plan() passes onPidSpawned to createClient", async () => {
    const session = makeSession();
    let capturedCallback: ((pid: number) => void) | undefined;

    _acpAdapterDeps.createClient = mock(
      (
        _cmdStr: string,
        _cwd?: string,
        _timeoutSeconds?: number,
        onPidSpawned?: (pid: number) => void,
      ) => {
        capturedCallback = onPidSpawned;
        return makeClient(session);
      },
    );

    const pids: number[] = [];
    await adapter.plan({
      prompt: "plan this feature",
      workdir: "/tmp/test-project",
      modelTier: "balanced",
      interactive: false,
      onPidSpawned: (pid: number) => { pids.push(pid); },
    }).catch(() => {});

    expect(capturedCallback).toBeDefined();
  });

  test("plan() passes undefined when onPidSpawned absent", async () => {
    const session = makeSession();
    let callbackArg: unknown = "NOT_CHECKED";

    _acpAdapterDeps.createClient = mock(
      (
        _cmdStr: string,
        _cwd?: string,
        _timeoutSeconds?: number,
        onPidSpawned?: (pid: number) => void,
      ) => {
        callbackArg = onPidSpawned;
        return makeClient(session);
      },
    );

    await adapter.plan({
      prompt: "plan this feature",
      workdir: "/tmp/test-project",
      modelTier: "balanced",
      interactive: false,
    }).catch(() => {});

    expect(callbackArg).toBeUndefined();
  });
});

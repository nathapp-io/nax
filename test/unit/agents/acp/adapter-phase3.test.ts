/**
 * AcpAgentAdapter — ADR-013 Phase 3: onPidSpawned callback
 *
 * Phase 3 removes AgentRunOptions.pidRegistry and replaces it with
 * onPidSpawned?: (pid: number) => void. The adapter fires the callback
 * immediately after spawning a process (inside createClient / SpawnAcpClient).
 *
 * Covered:
 *   - plan() passes onPidSpawned through to createClient
 *
 * Note: run() onPidSpawned tests removed in ADR-019 Phase D —
 * AgentAdapter.run() was deleted from the interface.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { withDepsRestore } from "../../../helpers/deps";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { makeClient, makeSession } from "./adapter.test";

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

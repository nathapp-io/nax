/**
 * AcpAgentAdapter — ADR-013 Phase 3: onPidSpawned callback
 *
 * Phase 3 removes AgentRunOptions.pidRegistry and replaces it with
 * onPidSpawned?: (pid: number) => void. The adapter fires the callback
 * immediately after spawning a process (inside createClient / SpawnAcpClient).
 *
 * Note: run() onPidSpawned tests removed in ADR-019 Phase D —
 * AgentAdapter.run() was deleted from the interface.
 *
 * Note: plan() onPidSpawned tests removed in ADR-018 Wave 3 —
 * AgentAdapter.plan() was deprecated in favour of callOp(ctx, planOp, input).
 */

import { describe, expect, test } from "bun:test";
import { AcpAgentAdapter } from "../../../../src/agents/acp/adapter";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";

describe("AcpAgentAdapter.plan() — onPidSpawned threading", () => {
  test("plan() throws ADAPTER_METHOD_DEPRECATED (onPidSpawned threading removed with deprecation)", async () => {
    const adapter = new AcpAgentAdapter("claude", DEFAULT_CONFIG);
    await expect(
      adapter.plan({
        prompt: "plan this feature",
        workdir: "/tmp/test-project",
        modelTier: "balanced",
        interactive: false,
        onPidSpawned: (pid: number) => { void pid; },
      }),
    ).rejects.toMatchObject({ code: "ADAPTER_METHOD_DEPRECATED" });
  });
});

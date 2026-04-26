/**
 * Tests for AcpAgentAdapter — Phase 1 plumbing
 *
 * Covers:
 * - deriveSessionName() produces correct ACP session handle from SessionDescriptor
 *
 * Note: protocolIds tests (adapter.run() calls) removed in ADR-019 Phase D —
 * AgentAdapter.run() was deleted from the interface.
 */

import { describe, expect, test } from "bun:test";
import { AcpAgentAdapter, computeAcpHandle } from "../../../../src/agents/acp/adapter";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { SessionDescriptor } from "../../../../src/session/types";

// ─────────────────────────────────────────────────────────────────────────────
// deriveSessionName — handle matches physical ACP session name
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter.deriveSessionName", () => {
  const adapter = new AcpAgentAdapter("claude", DEFAULT_CONFIG);
  const workdir = "/tmp/test-project";

  function makeDescriptor(overrides: Partial<SessionDescriptor>): SessionDescriptor {
    return {
      id: "sess-abc",
      role: "implementer",
      state: "RUNNING",
      agent: "claude",
      workdir,
      featureName: "my-feat",
      storyId: "US-001",
      protocolIds: { recordId: null, sessionId: null },
      completedStages: [],
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test("produces same name as computeAcpHandle for implementer role", () => {
    const descriptor = makeDescriptor({ role: "implementer" });
    const derived = adapter.deriveSessionName(descriptor);
    const expected = computeAcpHandle(workdir, "my-feat", "US-001", "implementer");
    expect(derived).toBe(expected);
  });

  test("produces same name as computeAcpHandle for reviewer-semantic role", () => {
    const descriptor = makeDescriptor({ role: "reviewer-semantic" });
    const derived = adapter.deriveSessionName(descriptor);
    const expected = computeAcpHandle(workdir, "my-feat", "US-001", "reviewer-semantic");
    expect(derived).toBe(expected);
  });

  test("handle matches execution stage sessionRole implementer", () => {
    // Execution stage (context.ts) creates descriptor with role: "implementer"
    // and execution.ts calls agent.run() with sessionRole: "implementer".
    // deriveSessionName(descriptor) must produce the same name.
    const descriptor = makeDescriptor({ role: "implementer" });
    const fromDescriptor = adapter.deriveSessionName(descriptor);
    const fromRunOptions = computeAcpHandle(workdir, "my-feat", "US-001", "implementer");
    expect(fromDescriptor).toBe(fromRunOptions);
  });
});

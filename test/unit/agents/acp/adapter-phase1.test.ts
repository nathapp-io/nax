/**
 * Tests for AcpAgentAdapter — Phase 1 plumbing
 *
 * Covers:
 * - computeAcpHandle() produces stable ACP session names
 *
 * Note: protocolIds tests (adapter.run() calls) removed in ADR-019 Phase D —
 * AgentAdapter.run() was deleted from the interface.
 */

import { describe, expect, test } from "bun:test";
import { computeAcpHandle } from "../../../../src/agents/acp/adapter";

describe("computeAcpHandle", () => {
  const workdir = "/tmp/test-project";

  test("produces stable handle for implementer role", () => {
    const actual = computeAcpHandle(workdir, "my-feat", "US-001", "implementer");
    const again = computeAcpHandle(workdir, "my-feat", "US-001", "implementer");
    expect(actual).toBe(again);
  });

  test("includes role suffix for reviewer session", () => {
    const actual = computeAcpHandle(workdir, "my-feat", "US-001", "reviewer-semantic");
    expect(actual.endsWith("-reviewer-semantic")).toBe(true);
  });
});

/**
 * Tests for AcpAgentAdapter — Phase 1 plumbing
 *
 * Covers:
 * - protocolIds (recordId + sessionId) surfaced on AgentResult
 * - sessionRetries counter on AgentResult
 * - deriveSessionName() produces correct ACP session handle from SessionDescriptor
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps, computeAcpHandle } from "../../../../src/agents/acp/adapter";
import { withDepsRestore } from "../../../helpers/deps";
import type { AgentRunOptions } from "../../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { SessionDescriptor } from "../../../../src/session/types";
import { makeClient, makeSession } from "./adapter.test";

const BASE_OPTIONS: AgentRunOptions = {
  prompt: "implement the feature",
  workdir: "/tmp/test-project",
  modelTier: "balanced",
  modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
  timeoutSeconds: 30,
  dangerouslySkipPermissions: true,
  featureName: "string-toolkit",
  storyId: "ST-001",
  config: DEFAULT_CONFIG,
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 plumbing — protocolIds + sessionRetries on AgentResult
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter — Phase 1: protocolIds surfaced on AgentResult", () => {
  let adapter: AcpAgentAdapter;

  withDepsRestore(_acpAdapterDeps, ["createClient", "sleep"]);

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude", DEFAULT_CONFIG);
    _acpAdapterDeps.sleep = async () => {};
  });

  afterEach(() => {
    mock.restore();
  });

  test("protocolIds.recordId and protocolIds.sessionId are populated from the ACP session", async () => {
    const session = makeSession();
    (session as unknown as { recordId: string; id: string }).recordId = "rec-stable-001";
    (session as unknown as { recordId: string; id: string }).id = "sid-volatile-002";

    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await adapter.run(BASE_OPTIONS);
    expect(result.protocolIds).toBeDefined();
    expect(result.protocolIds?.recordId).toBe("rec-stable-001");
    expect(result.protocolIds?.sessionId).toBe("sid-volatile-002");
  });

  test("protocolIds.recordId is null when session has no recordId", async () => {
    const session = makeSession();
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await adapter.run(BASE_OPTIONS);
    expect(result.protocolIds).toBeDefined();
    expect(result.protocolIds?.recordId).toBeNull();
  });

  test("sessionRetries is 0 on a successful run with no retries", async () => {
    const session = makeSession();
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await adapter.run(BASE_OPTIONS);
    expect(result.sessionRetries).toBe(0);
  });
});

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

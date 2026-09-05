/**
 * `buildCompleteEvent` pure builder tests.
 *
 * US-002: the complete dispatch event must carry the adapter-supplied
 * `sessionId` so the audit subscriber can stamp it on the prompt-audit entry.
 * One-shot completes have no record id or turn id, so it travels as a plain
 * field on the event rather than inside the sibling `protocolIds` object.
 */

import { describe, expect, test } from "bun:test";
import { buildCompleteEvent } from "@/agents/manager-dispatch";
import type { CompleteOptions, ResolvedCompleteOptions } from "@/agents/types";
import { DEFAULT_CONFIG } from "@/config";
import { resolvePermissions } from "@/config/permissions";

const PERMS = resolvePermissions(DEFAULT_CONFIG, "complete");

function makeOptions(): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    workdir: "/tmp",
    resolvedPermissions: PERMS,
  };
}

describe("buildCompleteEvent — sessionId plumbing", () => {
  test("US-002 AC4: sessionId supplied on options reaches the returned event", () => {
    // AC 4 calls buildCompleteEvent's `input.sessionId` — the story describes
    // it as a plain field on the dispatcher event, so we exercise the build
    // path that would surface an adapter-supplied id.
    const startedAt = 1_000;
    const event = buildCompleteEvent({
      sessionName: "nax-abc-feat-s1-plan",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options: { ...makeOptions(), sessionName: "nax-abc-feat-s1-plan" } as CompleteOptions,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      startedAt,
      sessionId: "nax-abc12345",
    });

    expect(event.kind).toBe("complete");
    expect(event.sessionId).toBe("nax-abc12345");
  });

  test("US-002 AC5: no sessionId on input means the returned event has no sessionId property", () => {
    const event = buildCompleteEvent({
      sessionName: "nax-abc-feat-s1-plan",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options: { ...makeOptions(), sessionName: "nax-abc-feat-s1-plan" } as CompleteOptions,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      startedAt: 1_000,
    });

    expect(event.kind).toBe("complete");
    // The exact invariant the AC names: no sessionId property at all.
    expect("sessionId" in event).toBe(false);
  });
});

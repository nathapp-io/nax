/**
 * US-004 (nax#2930): an abandoned tool result names WHY the turn ended.
 *
 * The turn controller (`session/agent-session-turn.ts`) aborts its signal with a
 * `NaxError` for a cancel, the turn deadline, a stalled consumer and an iterator
 * close. This is the end-to-end case: a real `createAgentSession` turn is inside
 * an embedder tool that never settles when `session.cancel()` runs, and the
 * abandoned result the tool batch records carries the turn-end reason.
 *
 * Observed through the session's own `tool_result` event, which the turn loop
 * emits for the result it just appended — not through an invented return value
 * from `onInteraction` or `turn_end.output`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type AgentSession, createAgentSession, type EmbedderTool } from "@nathapp/nax-agent";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import {
  collect,
  eventsOf,
  installScriptedProvider,
  resetScriptedProvider,
  sessionOptions,
  toolRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import { withDepsRestore } from "#test/helpers/index";

const TOOL_NAME = "acme__run";
const ABANDONED_CANCELLED = `Tool "${TOOL_NAME}" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).`;
/** Every case here cancels through the session, which aborts with its own reason instead of the allowed 60s deadline. */
const TURN_TIMEOUT_SECONDS = 600;

const sessions: AgentSession[] = [];

afterEach(async () => {
  try {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  } finally {
    resetScriptedProvider();
  }
});

/** A tool that never answers, reporting when its run has started. */
function neverSettlingTool(): { readonly tool: EmbedderTool; readonly started: Promise<void> } {
  let reportStart: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    reportStart = resolve;
  });
  const tool: EmbedderTool = {
    name: TOOL_NAME,
    description: "a long investigation that never answers",
    inputSchema: { type: "object" },
    approval: "never",
    run() {
      reportStart();
      return new Promise(() => {});
    },
  };
  return { tool, started };
}

describe("abandoned embedder tool result names the turn-end reason (US-004)", () => {
  withDepsRestore(_agentSessionDeps);

  test("AC-7: session.cancel() during a never-settling embedder tool ends the turn with the cancelled reason", async () => {
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "call-1", name: TOOL_NAME, input: { task: "review" } }]));
    const { tool, started } = neverSettlingTool();
    const session = await createAgentSession(
      sessionOptions({ sessionId: "abandoned-reason", tools: [tool], turnTimeoutSeconds: TURN_TIMEOUT_SECONDS }),
    );
    sessions.push(session);

    const pending = collect(session.send("review the branch"));
    // Coordinate on the tool's own start: the cancellation must land while it runs.
    await started;
    session.cancel();

    const events = await pending;
    const results = eventsOf(events, "tool_result");
    expect(
      results.map((result) => ({ callId: result.callId, isError: result.isError, preview: result.preview })),
    ).toEqual([{ callId: "call-1", isError: true, preview: ABANDONED_CANCELLED }]);
    expect(turnEndOf(events).status).toBe("cancelled");
  });
});

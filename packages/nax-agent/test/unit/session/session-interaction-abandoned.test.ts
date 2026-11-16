/**
 * US-004 (nax#2930): both abandoned-tool paths report an available structured
 * turn-end reason.
 *
 * `invoke` (an embedder tool) and `runCodingTool` (a built-in / provider tool)
 * race the turn's signal. When that signal aborted with a `NaxError` — which is
 * what the session turn controller does for a cancel, the turn deadline, a
 * stalled consumer and an iterator close — the abandoned result must say which
 * one. A bare `abort()` carries no reason and keeps today's text.
 *
 * Each case holds a tool that never settles and aborts the signal the call
 * raced, so the abandonment path itself is what is being measured.
 */
import { describe, expect, test } from "bun:test";
import type { EmbedderTool, EmbedderToolResult } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";
import type { AdapterInteraction, InteractionHandler } from "#src/session/interaction-handler";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import {
  abandonedToolMessage,
  createSessionInteractionHandler,
  type SessionInteractionDeps,
} from "#src/session/session-interaction";
import { TurnEndAbort } from "#src/session/turn-end-abort";
import type { CodingToolOutcome, CodingToolRuntime } from "#src/tools/runtime";

const IDLE = new AbortController().signal;

/** A runtime whose only tool never settles: the abandonment, not the tool, ends the call. */
const NEVER_RETURNS: CodingToolRuntime = {
  advertised: () => [],
  callTool: () => new Promise<CodingToolOutcome>(() => {}),
};

/** An embedder tool that never settles. */
function neverSettlingTool(name: string): EmbedderTool {
  return {
    name,
    description: "a long run that never answers",
    inputSchema: { type: "object" },
    approval: "never",
    run: () => new Promise<EmbedderToolResult>(() => {}),
  };
}

function deps(runtime: CodingToolRuntime, tools: readonly EmbedderTool[] = []): SessionInteractionDeps {
  return {
    sessionId: "s1",
    runtime,
    embedderTools: new Map(tools.map((tool) => [tool.name, tool])),
    asks: createSessionAskPort({ table: createPendingAskTable(30_000), emit: () => {}, turn: () => undefined }),
    turnSignal: () => IDLE,
    setCurrentCallId: () => {},
  };
}

/** A coding-tool request racing `controller.signal`. */
function request(name: string, controller: AbortController): AdapterInteraction {
  return { kind: "coding-tool", name, input: {}, toolCallId: "call-1", signal: controller.signal };
}

async function thrown(promise: Promise<unknown>): Promise<NaxError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error("expected a NaxError");
}

describe("abandonedToolMessage", () => {
  function abortedWith(reason?: unknown): AbortSignal {
    const controller = new AbortController();
    if (reason === undefined) controller.abort();
    else controller.abort(reason);
    return controller.signal;
  }

  test("AC-1: a turn-deadline reason appends its code and message", () => {
    expect(
      abandonedToolMessage("acme__put", abortedWith(new NaxError("turn deadline", "AGENT_SESSION_TURN_TIMEOUT"))),
    ).toBe('Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_TURN_TIMEOUT: turn deadline).');
  });

  test("AC-2: a cancel reason appends its code and message", () => {
    expect(abandonedToolMessage("acme__put", abortedWith(new NaxError("cancelled", "AGENT_SESSION_CANCELLED")))).toBe(
      'Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).',
    );
  });

  test("AC-3: a signal aborted with no reason keeps today's text", () => {
    expect(abandonedToolMessage("acme__put", abortedWith())).toBe('Tool "acme__put" was abandoned: the turn ended.');
  });

  test("AC-4: a plain Error reason is not a turn-end reason and keeps today's text", () => {
    expect(abandonedToolMessage("acme__put", abortedWith(new Error("koda went away")))).toBe(
      'Tool "acme__put" was abandoned: the turn ended.',
    );
  });

  test("US-003 AC-2: a TurnEndAbort reason appends its message, not a code", () => {
    expect(
      abandonedToolMessage("acme__put", abortedWith(new TurnEndAbort("native turn deadline of 600s reached"))),
    ).toBe('Tool "acme__put" was abandoned: the turn ended (native turn deadline of 600s reached).');
  });

  test("US-003 AC-3: a signal aborted with no argument keeps today's text", () => {
    const controller = new AbortController();
    controller.abort();
    expect(abandonedToolMessage("acme__put", controller.signal)).toBe(
      'Tool "acme__put" was abandoned: the turn ended.',
    );
  });

  test("US-003 AC-4: a runtime DOMException named AbortError is not nax's own reason and keeps today's text", () => {
    expect(abandonedToolMessage("acme__put", abortedWith(new DOMException("some text", "AbortError")))).toBe(
      'Tool "acme__put" was abandoned: the turn ended.',
    );
  });

  test("US-003 AC-5: a NaxError reason still appends its code and message", () => {
    expect(abandonedToolMessage("acme__put", abortedWith(new NaxError("cancelled", "AGENT_SESSION_CANCELLED")))).toBe(
      'Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).',
    );
  });
});

describe("abandoned tool results name the turn-end reason (US-004)", () => {
  test("AC-5: an embedder tool abandoned by a turn-deadline abort reports the deadline", async () => {
    const handler: InteractionHandler = createSessionInteractionHandler(
      deps(NEVER_RETURNS, [neverSettlingTool("acme__put")]),
    );
    const controller = new AbortController();
    const pending = handler.onInteraction(request("acme__put", controller));
    controller.abort(new NaxError("turn deadline", "AGENT_SESSION_TURN_TIMEOUT", { stage: "agent-session" }));

    const err = await thrown(pending);
    expect(err).toBeInstanceOf(NaxError);
    expect(err.message).toBe(
      'Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_TURN_TIMEOUT: turn deadline).',
    );
  });

  test("AC-6: a coding tool abandoned by a cancel reports the cancel reason", async () => {
    const handler: InteractionHandler = createSessionInteractionHandler(deps(NEVER_RETURNS));
    const controller = new AbortController();
    const pending = handler.onInteraction(request("acme__put", controller));
    controller.abort(new NaxError("cancelled", "AGENT_SESSION_CANCELLED", { stage: "agent-session" }));

    const err = await thrown(pending);
    expect(err).toBeInstanceOf(NaxError);
    expect(err.message).toBe('Tool "acme__put" was abandoned: the turn ended (AGENT_SESSION_CANCELLED: cancelled).');
  });
});

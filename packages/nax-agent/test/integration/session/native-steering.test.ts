/**
 * US-001: steering reaches the native turn loop (spec "Steering (native)").
 *
 * The facade's pending steers travel to the loop as `SendTurnOpts.steers`. The
 * loop drains that channel at two points and nowhere else:
 *
 *  1. a round boundary — before the next request, after the previous round's
 *     tool results — which is why a steer typed while a tool ran reaches round
 *     2, and a steer typed into a turn that then ran out of budget reaches
 *     nothing;
 *  2. turn end, where a steer continues the turn exactly as a `before_turn_end`
 *     followUp does, without spending the followUp budget.
 *
 * Everything is observed through the scripted provider's recorded requests, so
 * "the steer was injected" means the message the PROVIDER was sent carried it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  createAgentSession,
  type EmbedderTool,
  resumeAgentSession,
  type SessionEvent,
  type SteerResult,
} from "@nathapp/nax-agent";
import type { ClientRequest, ProtocolEvent } from "@nathapp/nax-ai";
import { _adapterDeps } from "#src/native/adapter-deps";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { MAX_FOLLOW_UPS_PER_TURN } from "#src/native/session/turn-loop-round-trip";
import {
  collect,
  installScriptedProvider,
  type ScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import { assertDefined, makeFakeClock, withDepsRestore } from "#test/helpers/index";

const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

/** Opens a session over the installed scripted provider (see `installScriptedProvider`). */
async function openSession(extra: Parameters<typeof sessionOptions>[0] = {}) {
  const session = await createAgentSession(sessionOptions(extra));
  sessions.push(session);
  return session;
}

/** The messages the provider was sent for request `index` (0-based; negative counts from the end). */
function requestMessages(provider: ScriptedProvider, index: number): ClientRequest["messages"] {
  const request = provider.requests.at(index);
  assertDefined(request, `request ${index}`);
  return request.messages;
}

/** Every `content` the provider was sent as a user message in the last request. */
function userTexts(provider: ScriptedProvider): string[] {
  return requestMessages(provider, -1)
    .filter((message) => message.role === "user")
    .map((message) => message.content);
}

/** An embedder tool the model can call; `onProbe` is what the model's call triggers. */
function probeTool(onProbe: () => void | Promise<void>): EmbedderTool {
  return {
    name: "probe",
    description: "a probe the test steers from",
    inputSchema: { type: "object", properties: { step: { type: "number" } } },
    approval: "never",
    async run() {
      await onProbe();
      return { content: "probe ok" };
    },
  };
}

function steer(session: AgentSession): (text: string) => SteerResult {
  assertDefined(session.steer, "steer");
  return session.steer.bind(session);
}

function accepted(result: SteerResult): { readonly steerId: string; readonly applied: Promise<boolean> } {
  if (result.status !== "accepted") throw new Error(`expected an accepted steer, got "${result.status}"`);
  return result;
}

/** A round that steers and then answers: the only way to type into round 1. */
function steerThen(
  onSteer: () => void,
  events: readonly ProtocolEvent[],
): (req: ClientRequest) => AsyncIterable<ProtocolEvent> {
  return async function* steeringRound() {
    onSteer();
    yield* events;
  };
}

function turnEnd(events: readonly SessionEvent[]) {
  return turnEndOf(events);
}

describe("native steering: a steer during a tool round reaches the next request", () => {
  test("AC-12: round 2 ends with the steer, right after the tool result", async () => {
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "t1", name: "probe", input: { step: 1 } }]), textRound("done"));
    let onProbe: () => void = () => {};
    const session = await openSession({ tools: [probeTool(() => onProbe())] });
    onProbe = () => void steer(session)("also check b.ts");

    const events = await collect(session.send("hi"));

    const messages = requestMessages(provider, 1);
    expect(messages.at(-1)).toEqual({ role: "user", content: "also check b.ts" });
    expect(messages.at(-2)).toMatchObject({ role: "tool-result", toolCallId: "t1" });
    expect(turnEnd(events).status).toBe("completed");
  });

  test("AC-13: two steers during one tool batch arrive as two user messages, in arrival order", async () => {
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "t1", name: "probe", input: { step: 1 } }]), textRound("done"));
    let onProbe: () => void = () => {};
    const session = await openSession({ tools: [probeTool(() => onProbe())] });
    onProbe = () => {
      const steerNow = steer(session);
      steerNow("first");
      steerNow("second");
    };

    await collect(session.send("hi"));

    expect(requestMessages(provider, 1).slice(-2)).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
  });
});

describe("native steering: a steer at turn end continues the turn", () => {
  test("AC-14, AC-15: a steer typed into a text-only round 1 sends a second request, and the turn completes", async () => {
    const provider = installScriptedProvider();
    let onSteer: () => void = () => {};
    const session = await openSession();
    onSteer = () => void steer(session)("go on");
    provider.push(
      steerThen(() => onSteer(), textRound("round one")),
      textRound("round two"),
    );

    const events = await collect(session.send("hi"));

    expect(provider.requests).toHaveLength(2);
    expect(requestMessages(provider, 1).at(-1)).toEqual({ role: "user", content: "go on" });
    expect(turnEnd(events).status).toBe("completed");
  });

  test("AC-16: a followUp at the same turn end lands after the steer it continues with", async () => {
    const provider = installScriptedProvider();
    let onSteer: () => void = () => {};
    const session = await openSession({
      loopHandlers: [
        {
          plugin: "test",
          event: "before_turn_end",
          handler: (payload) =>
            "followUpsSoFar" in payload && payload.followUpsSoFar === 0 ? { followUp: "and then this" } : {},
        },
      ],
    });
    onSteer = () => void steer(session)("steer first");
    provider.push(
      steerThen(() => onSteer(), textRound("round one")),
      textRound("round two"),
    );

    await collect(session.send("hi"));

    expect(requestMessages(provider, 1).slice(-2)).toEqual([
      { role: "user", content: "steer first" },
      { role: "user", content: "and then this" },
    ]);
  });

  test("AC-17: a turn continued by a steer still honours the followUp cap in full", async () => {
    const provider = installScriptedProvider();
    let onSteer: () => void = () => {};
    const session = await openSession({
      loopHandlers: [{ plugin: "test", event: "before_turn_end", handler: () => ({ followUp: "again" }) }],
    });
    onSteer = () => void steer(session)("steer once");
    // One steered continuation plus MAX_FOLLOW_UPS_PER_TURN honoured followUps,
    // then one round that ends the turn. A spare round is queued so an
    // over-running turn reports as a count mismatch, not a provider throw.
    const rounds = Array.from({ length: MAX_FOLLOW_UPS_PER_TURN + 2 }, (_, index) => textRound(`round ${index + 2}`));
    provider.push(
      steerThen(() => onSteer(), textRound("round one")),
      ...rounds,
    );

    const events = await collect(session.send("hi"));

    // Steering is the person's input, not a handler injection: it spends no
    // followUp slot, so the cap is honoured in full after it. One request per
    // honoured continuation, plus the turn's first one.
    expect(provider.requests).toHaveLength(1 + MAX_FOLLOW_UPS_PER_TURN);
    expect(userTexts(provider).filter((text) => text === "again")).toHaveLength(MAX_FOLLOW_UPS_PER_TURN);
    expect(userTexts(provider).filter((text) => text === "steer once")).toHaveLength(1);
    expect(turnEnd(events).status).toBe("completed");
  });
});

describe("native steering: a turn that ends without taking the steer discards it", () => {
  withDepsRestore(_adapterDeps);

  test("AC-18, AC-19: an expired deadline keeps the steer out of the transcript and resolves applied false", async () => {
    // The deadline measures against `_adapterDeps.now`, so a virtual clock can
    // spend the whole budget mid-turn without waiting the schema's 1s minimum.
    const clock = makeFakeClock();
    _adapterDeps.now = clock.now;

    const provider = installScriptedProvider();
    const store = createMemoryTranscriptStore();
    provider.push(toolRound([{ id: "t1", name: "probe", input: { step: 1 } }]), textRound("never sent"));
    const steered = Promise.withResolvers<SteerResult>();
    let onProbe: () => void = () => {};
    const session = await openSession({
      turnTimeoutSeconds: 1,
      transcriptStore: store,
      tools: [probeTool(() => onProbe())],
    });
    onProbe = () => {
      steered.resolve(steer(session)("too late"));
      // The budget is spent BEFORE the round boundary that would inject it.
      void clock.advance(2_000);
    };

    const events = await collect(session.send("hi"));
    const result = accepted(await steered.promise);

    expect(turnEnd(events).status).toBe("timed_out");
    expect(provider.requests).toHaveLength(1);
    await expect(result.applied).resolves.toBe(false);
    const doc = await store.load(session.id);
    const texts = (doc?.messages ?? []).map((message) => message.content);
    expect(texts).not.toContain("too late");
  });

  test("AC-20, AC-21: a cancelled turn never sends the steer and resolves applied false", async () => {
    const provider = installScriptedProvider();
    // Two calls: the first is cancelled mid-flight, so the batch's own abort
    // check answers the second one and ends the turn as cancelled.
    provider.push(
      toolRound([
        { id: "t1", name: "probe", input: { step: 1 } },
        { id: "t2", name: "probe", input: { step: 2 } },
      ]),
      textRound("never sent"),
    );
    const steered = Promise.withResolvers<SteerResult>();
    let onProbe: () => void = () => {};
    const session = await openSession({ tools: [probeTool(() => onProbe())] });
    onProbe = () => {
      steered.resolve(steer(session)("dropped by cancel"));
      session.cancel();
    };

    const events = await collect(session.send("hi"));
    const result = accepted(await steered.promise);

    expect(turnEnd(events).status).toBe("cancelled");
    expect(provider.requests).toHaveLength(1);
    await expect(result.applied).resolves.toBe(false);
  });

  test("AC-22, AC-23: a spin-stopped turn discards the steer and sends no further round", async () => {
    const provider = installScriptedProvider();
    // The model repeats one call with an unchanged result until the breaker
    // ends the turn; comfortably more rounds are queued than it needs.
    provider.push(
      ...Array.from({ length: 60 }, (_, index) =>
        toolRound([{ id: `spin-${index}`, name: "probe", input: { step: 1 } }]),
      ),
    );
    const steers: Promise<boolean>[] = [];
    let stoppedEnding = 0;
    let onStop: () => void = () => {};
    const session = await openSession({
      tools: [probeTool(() => {})],
      loopHandlers: [
        {
          plugin: "test",
          event: "before_turn_end",
          handler: (payload) => {
            // Only a STOPPED ending: this is the spin breaker's turn end.
            if (!("stopped" in payload) || !payload.stopped) return {};
            stoppedEnding += 1;
            onStop();
            return {};
          },
        },
      ],
    });
    onStop = () => steers.push(accepted(steer(session)("after the stop")).applied);

    const events = await collect(session.send("hi"));
    const atSettle = provider.requests.length;

    expect(turnEnd(events)).toMatchObject({ status: "errored", error: { code: "AGENT_SESSION_SPIN_STOPPED" } });
    expect(stoppedEnding).toBe(1);
    expect(atSettle).toBeLessThan(60);
    assertDefined(steers[0], "the stopped turn's applied promise");
    await expect(steers[0]).resolves.toBe(false);
    // Nothing was sent after the stop: the turn is over.
    expect(provider.requests.length).toBe(atSettle);
  });

  test("AC-28: a steer pending when the turn errors resolves false", async () => {
    const provider = installScriptedProvider();
    provider.push([{ type: "error", error: { kind: "auth", message: "bad key" } }]);
    const session = await openSession();
    const iterable = session.send("hi");
    // Accepted against the live claim, before the failing request ever runs.
    const result = accepted(steer(session)("dropped by error"));

    const events = await collect(iterable);

    expect(turnEnd(events).status).toBe("errored");
    await expect(result.applied).resolves.toBe(false);
  });
});

describe("native steering: persistence and replay", () => {
  test("AC-24: a discarded steer is absent from the next send()'s request", async () => {
    const provider = installScriptedProvider();
    provider.push(
      toolRound([
        { id: "t1", name: "probe", input: { step: 1 } },
        { id: "t2", name: "probe", input: { step: 2 } },
      ]),
      textRound("second turn"),
    );
    let onProbe: () => void = () => {};
    const session = await openSession({ tools: [probeTool(() => onProbe())] });
    onProbe = () => {
      void steer(session)("discarded");
      session.cancel();
    };
    await collect(session.send("hi"));

    await collect(session.send("again"));

    const texts = userTexts(provider);
    expect(texts).toContain("again");
    expect(texts).not.toContain("discarded");
  });

  test("AC-25: the stored transcript holds the steer between the tool result and the next assistant message", async () => {
    const provider = installScriptedProvider();
    const store = createMemoryTranscriptStore();
    provider.push(toolRound([{ id: "t1", name: "probe", input: { step: 1 } }]), textRound("done"));
    let onProbe: () => void = () => {};
    const session = await openSession({
      transcriptStore: store,
      tools: [probeTool(() => onProbe())],
    });
    onProbe = () => void steer(session)("remember me");

    await collect(session.send("hi"));

    const doc = await store.load(session.id);
    const messages = doc?.messages ?? [];
    const index = messages.findIndex((message) => message.role === "user" && message.content === "remember me");
    expect(index).toBeGreaterThan(0);
    expect(messages[index - 1]?.role).toBe("tool-result");
    expect(messages[index + 1]?.role).toBe("assistant");
  });

  test("AC-26: a resumed session's next request carries the steer the previous session persisted", async () => {
    const provider = installScriptedProvider();
    const store = createMemoryTranscriptStore();
    provider.push(toolRound([{ id: "t1", name: "probe", input: { step: 1 } }]), textRound("done"));
    let onProbe: () => void = () => {};
    const session = await openSession({
      transcriptStore: store,
      sessionId: "steer-replay",
      tools: [probeTool(() => onProbe())],
    });
    onProbe = () => void steer(session)("persisted steer");
    await collect(session.send("hi"));
    const sessionId = session.id;
    await session.close();

    provider.push(textRound("resumed"));
    const resumed = await resumeAgentSession(sessionId, sessionOptions({ transcriptStore: store }));
    sessions.push(resumed);
    await collect(resumed.send("continue"));

    expect(userTexts(provider)).toContain("persisted steer");
  });
});

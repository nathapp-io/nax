import { afterEach, describe, expect, test } from "bun:test";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { type AgentLogger, setAgentLogger, type TurnEvent } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";
import {
  createInboundRouter,
  type ElicitationHandler,
  MAX_PENDING_DECISIONS,
  type PermissionDecider,
} from "#src/client/inbound";
import { createOwnToolLedger } from "#src/client/own-tool-calls";

const IDLE = new AbortController().signal;

function request(sessionId: string, kinds: readonly PermissionOptionKind[] = ["allow_once", "reject_once"]) {
  const req: RequestPermissionRequest = {
    sessionId,
    toolCall: { toolCallId: "t" },
    options: kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })),
  };
  return req;
}

const text = (t: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text" as const, text: t },
});

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "opt-allow_once" } };
const REJECT: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "opt-reject_once" } };
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

function recordingDecider(answer: (signal: AbortSignal) => Promise<RequestPermissionResponse> = async () => ALLOW) {
  const seen: AbortSignal[] = [];
  const decide: PermissionDecider = (_request, signal) => {
    seen.push(signal);
    return answer(signal);
  };
  return { decide, seen };
}

/** A decider that answers `cancelled` once its signal aborts, and never before. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<RequestPermissionResponse>((resolve) => {
    signal.addEventListener("abort", () => resolve(CANCELLED));
  });

function recordingLogger(): { logger: AgentLogger; warnings: { message: string; data: unknown }[] } {
  const warnings: { message: string; data: unknown }[] = [];
  const ignore = () => {};
  return {
    warnings,
    logger: {
      error: ignore,
      info: ignore,
      debug: ignore,
      warn: (_stage, message, data) => {
        warnings.push({ message, data });
      },
    },
  };
}

afterEach(() => {
  setAgentLogger(null);
});

describe("createInboundRouter: updates", () => {
  test("routes updates for the attached session only, and only while attached", async () => {
    const router = createInboundRouter(recordingDecider().decide);
    const collector = createTurnCollector(undefined);
    router.handlers.onUpdate({ sessionId: "a", update: text("before") });
    const release = router.attach("a", collector, IDLE);
    router.handlers.onUpdate({ sessionId: "a", update: text("mine") });
    router.handlers.onUpdate({ sessionId: "b", update: text("theirs") });
    await release();
    router.handlers.onUpdate({ sessionId: "a", update: text("after") });
    expect(collector.output()).toBe("mine");
  });

  test("releasing a stale binding does not detach a newer one", async () => {
    const router = createInboundRouter(recordingDecider().decide);
    const first = createTurnCollector(undefined);
    const second = createTurnCollector(undefined);
    const releaseFirst = router.attach("a", first, IDLE);
    router.attach("a", second, IDLE);
    await releaseFirst();
    router.handlers.onUpdate({ sessionId: "a", update: text("x") });
    expect(second.output()).toBe("x");
  });
});

describe("createInboundRouter: permission requests (spec §6.3, §6.4, D3-c, D3-d)", () => {
  test("during a turn, for the attached session: the decider answers", async () => {
    const { decide, seen } = recordingDecider();
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onPermission(request("a"))).toEqual(ALLOW);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(false);
    await release();
  });

  test("no turn: rejected locally, logged once per reason; the decider is not called", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { decide, seen } = recordingDecider();
    const router = createInboundRouter(decide);
    expect(await router.handlers.onPermission(request("a"))).toEqual(REJECT);
    expect(await router.handlers.onPermission(request("a", ["allow_once"]))).toEqual(CANCELLED);
    expect(seen).toHaveLength(0);
    expect(warnings.map((w) => w.data)).toEqual([{ reason: "no-turn" }]);
  });

  test("another agent session during a turn: rejected locally and logged", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { decide, seen } = recordingDecider();
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onPermission(request("b"))).toEqual(REJECT);
    expect(seen).toHaveLength(0);
    expect(warnings.map((w) => w.data)).toEqual([{ reason: "foreign-session" }]);
    await release();
  });

  test("a throwing host logger does not change the answer", async () => {
    const { logger } = recordingLogger();
    setAgentLogger({
      ...logger,
      warn: () => {
        throw new Error("logger down");
      },
    });
    const router = createInboundRouter(recordingDecider().decide);
    expect(await router.handlers.onPermission(request("a"))).toEqual(REJECT);
  });

  test("the turn signal reaches the decision: an aborted turn hands the decider an aborted signal", async () => {
    const { decide, seen } = recordingDecider();
    const router = createInboundRouter(decide);
    const turn = new AbortController();
    const release = router.attach("a", createTurnCollector(undefined), turn.signal);
    turn.abort();
    await router.handlers.onPermission(request("a"));
    expect(seen[0]?.aborted).toBe(true);
    await release();
  });

  test("release aborts pending decisions and resolves only after they are answered", async () => {
    const state = { answered: false };
    const { decide, seen } = recordingDecider(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              state.answered = true;
              resolve(CANCELLED);
            }, 20),
          );
        }),
    );
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    const response = router.handlers.onPermission(request("a"));
    await Promise.resolve();
    expect(seen[0]?.aborted).toBe(false);
    await release();
    expect(seen[0]?.aborted).toBe(true);
    expect(state.answered).toBe(true);
    expect(await response).toEqual(CANCELLED);
  });

  test("beyond MAX_PENDING_DECISIONS concurrent requests, the extra ones are rejected locally", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { decide, seen } = recordingDecider(untilAborted);
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    const pending = Array.from({ length: MAX_PENDING_DECISIONS }, () => router.handlers.onPermission(request("a")));
    expect(await router.handlers.onPermission(request("a"))).toEqual(REJECT);
    expect(seen).toHaveLength(MAX_PENDING_DECISIONS);
    expect(warnings.map((w) => w.data)).toEqual([{ reason: "too-many" }]);
    await release();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: MAX_PENDING_DECISIONS }, () => CANCELLED));
  });

  test("an aborted turn answers local rejections cancelled, with no event and no log (D3-d)", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { decide, seen } = recordingDecider(untilAborted);
    const router = createInboundRouter(decide);
    const turn = new AbortController();
    const release = router.attach("a", createTurnCollector(undefined), turn.signal);
    const pending = Array.from({ length: MAX_PENDING_DECISIONS }, () => router.handlers.onPermission(request("a")));
    turn.abort();
    expect(await router.handlers.onPermission(request("a"))).toEqual(CANCELLED);
    expect(await router.handlers.onPermission(request("b"))).toEqual(CANCELLED);
    expect(seen).toHaveLength(MAX_PENDING_DECISIONS);
    expect(warnings).toEqual([]);
    await release();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: MAX_PENDING_DECISIONS }, () => CANCELLED));
  });

  test("a throwing decider answers cancelled", async () => {
    const router = createInboundRouter(async () => {
      throw new Error("boom");
    });
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onPermission(request("a"))).toEqual(CANCELLED);
    await release();
  });
});

describe("activeSignal (S4-4: what an embedder tool call runs under)", () => {
  test("undefined between turns; the binding's signal during one; aborted by release", async () => {
    const router = createInboundRouter(recordingDecider().decide);
    expect(router.activeSignal()).toBeUndefined();
    const release = router.attach("agent-1", createTurnCollector(undefined), IDLE);
    const signal = router.activeSignal();
    expect(signal?.aborted).toBe(false);
    await release();
    expect(signal?.aborted).toBe(true);
    expect(router.activeSignal()).toBeUndefined();
  });

  test("the turn signal aborting aborts it", () => {
    const router = createInboundRouter(recordingDecider().decide);
    const turn = new AbortController();
    void router.attach("agent-1", createTurnCollector(undefined), turn.signal);
    turn.abort();
    expect(router.activeSignal()?.aborted).toBe(true);
  });
});

function elicitation(scope: { readonly sessionId: string } | { readonly requestId: string }): CreateElicitationRequest {
  return { ...scope, mode: "form", message: "Pick", requestedSchema: { type: "object", properties: {} } };
}

const ACCEPT: CreateElicitationResponse = { action: "accept", content: {} };
const CANCEL: CreateElicitationResponse = { action: "cancel" };

function recordingElicit(answer: (signal: AbortSignal) => Promise<CreateElicitationResponse> = async () => ACCEPT) {
  const seen: AbortSignal[] = [];
  const elicit: ElicitationHandler = (_request, signal) => {
    seen.push(signal);
    return answer(signal);
  };
  return { elicit, seen };
}

describe("createInboundRouter: elicitation (S4-5 D5-k)", () => {
  test("the bound session's elicitation reaches the handler with the binding signal", async () => {
    const { elicit, seen } = recordingElicit();
    const router = createInboundRouter(recordingDecider().decide, elicit);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(ACCEPT);
    expect(router.activeSignal()).toBe(seen[0]);
    await release();
  });

  test("no turn, another session or request-scoped: cancel, the handler never runs, each reason logged once", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { elicit, seen } = recordingElicit();
    const router = createInboundRouter(recordingDecider().decide, elicit);
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "b" }))).toEqual(CANCEL);
    expect(await router.handlers.onElicitation(elicitation({ requestId: "r-1" }))).toEqual(CANCEL);
    expect(seen).toEqual([]);
    expect(warnings).toEqual([
      { message: "Cancelled an elicitation locally", data: { reason: "no-turn" } },
      { message: "Cancelled an elicitation locally", data: { reason: "foreign-session" } },
    ]);
    await release();
  });

  test("permissions and elicitations share the pending cap", async () => {
    const { decide } = recordingDecider(untilAborted);
    const { elicit, seen } = recordingElicit();
    const router = createInboundRouter(decide, elicit);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    const pending = Array.from({ length: MAX_PENDING_DECISIONS }, () => router.handlers.onPermission(request("a")));
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    expect(seen).toEqual([]);
    await release();
    await Promise.all(pending);
  });

  test("release aborts a pending elicitation and waits for its answer", async () => {
    const state = { answered: false };
    const { elicit } = recordingElicit(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              state.answered = true;
              resolve(CANCEL);
            }, 20),
          );
        }),
    );
    const router = createInboundRouter(recordingDecider().decide, elicit);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    const answer = router.handlers.onElicitation(elicitation({ sessionId: "a" }));
    await release();
    expect(state.answered).toBe(true);
    expect(await answer).toEqual(CANCEL);
  });

  test("a throwing handler, or no handler at all, answers cancel", async () => {
    const throwing = createInboundRouter(recordingDecider().decide, async () => {
      throw new Error("boom");
    });
    const releaseThrowing = throwing.attach("a", createTurnCollector(undefined), IDLE);
    expect(await throwing.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    await releaseThrowing();
    const bare = createInboundRouter(recordingDecider().decide);
    const releaseBare = bare.attach("a", createTurnCollector(undefined), IDLE);
    expect(await bare.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    await releaseBare();
  });
});

describe("createInboundRouter: a permission request announces its tool call (S4-5 D5-c)", () => {
  test("tool_call goes out before the decision; not for another session or after the abort", async () => {
    const events: TurnEvent[] = [];
    const router = createInboundRouter(recordingDecider().decide);
    const turn = new AbortController();
    const release = router.attach(
      "a",
      createTurnCollector((e) => events.push(e)),
      turn.signal,
    );
    await router.handlers.onPermission({ ...request("a"), toolCall: { toolCallId: "t1", title: "Run tests" } });
    await router.handlers.onPermission({ ...request("b"), toolCall: { toolCallId: "t2", title: "Other" } });
    turn.abort();
    await router.handlers.onPermission({ ...request("a"), toolCall: { toolCallId: "t3", title: "Late" } });
    expect(events).toEqual([{ type: "tool_call", callId: "t1", name: "Run tests", input: {} }]);
    await release();
  });
});

describe("denials are counted on the turn's collector (nax#2582)", () => {
  test.each([
    ["a reject", REJECT, 1],
    ["cancelled", CANCELLED, 1],
    ["an allow", ALLOW, 0],
  ] as const)("%s answer: %d denial(s)", async (_name, answer, count) => {
    const { decide } = recordingDecider(async () => answer);
    const router = createInboundRouter(decide);
    const collector = createTurnCollector(undefined);
    const release = router.attach("s1", collector, IDLE);
    expect(await router.handlers.onPermission(request("s1"))).toEqual(answer);
    expect(collector.denials()).toBe(count);
    await release();
  });

  test("a decider fault answered cancelled is not counted", async () => {
    const router = createInboundRouter(async () => {
      throw new Error("decider bug");
    });
    const collector = createTurnCollector(undefined);
    router.attach("s1", collector, IDLE);
    expect(await router.handlers.onPermission(request("s1"))).toEqual(CANCELLED);
    expect(collector.denials()).toBe(0);
  });

  test("a deny answered after the turn aborted is not counted", async () => {
    const router = createInboundRouter(recordingDecider(untilAborted).decide);
    const collector = createTurnCollector(undefined);
    const turn = new AbortController();
    router.attach("s1", collector, turn.signal);
    const pending = router.handlers.onPermission(request("s1"));
    turn.abort();
    expect(await pending).toEqual(CANCELLED);
    expect(collector.denials()).toBe(0);
  });
});

describe("createInboundRouter: own tool ledger (acp-tools-codex-cursor US-004)", () => {
  const ownUpdate = (id: string) => ({
    sessionUpdate: "tool_call_update" as const,
    toolCallId: id,
    rawInput: { providerIdentifier: "nax-0badc0de", toolName: "lookup", args: {} },
  });
  const newLedger = () => createOwnToolLedger({ kind: "cursor", serverName: "nax-0badc0de", toolNames: ["lookup"] });

  function capturing() {
    const predicates: ((id: string) => boolean)[] = [];
    const decide: PermissionDecider = async (_request, _signal, isOwn) => {
      if (isOwn !== undefined) predicates.push(isOwn);
      return ALLOW;
    };
    return { decide, predicates };
  }

  test("AC-7: the decider's predicate is true for an id the attached turn's update proved own", async () => {
    const { decide, predicates } = capturing();
    const router = createInboundRouter(decide, undefined, newLedger);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    router.handlers.onUpdate({ sessionId: "a", update: ownUpdate("t1") });
    await router.handlers.onPermission(request("a"));
    expect(predicates).toHaveLength(1);
    expect(predicates[0]?.("t1")).toBe(true);
    expect(predicates[0]?.("t2")).toBe(false);
    await release();
  });

  test("an update for another session or sent before the turn is not observed", async () => {
    const { decide, predicates } = capturing();
    const router = createInboundRouter(decide, undefined, newLedger);
    router.handlers.onUpdate({ sessionId: "a", update: ownUpdate("t1") });
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    router.handlers.onUpdate({ sessionId: "b", update: ownUpdate("t1") });
    await router.handlers.onPermission(request("a"));
    expect(predicates[0]?.("t1")).toBe(false);
    await release();
  });

  test("each attach starts a fresh ledger: evidence from an earlier turn is gone", async () => {
    const { decide, predicates } = capturing();
    const router = createInboundRouter(decide, undefined, newLedger);
    const first = router.attach("a", createTurnCollector(undefined), IDLE);
    router.handlers.onUpdate({ sessionId: "a", update: ownUpdate("t1") });
    await first();
    const second = router.attach("a", createTurnCollector(undefined), IDLE);
    await router.handlers.onPermission(request("a"));
    expect(predicates[0]?.("t1")).toBe(false);
    await second();
  });

  test("without a ledger factory the predicate is always false", async () => {
    const { decide, predicates } = capturing();
    const router = createInboundRouter(decide);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    router.handlers.onUpdate({ sessionId: "a", update: ownUpdate("t1") });
    await router.handlers.onPermission(request("a"));
    expect(predicates[0]?.("t1")).toBe(false);
    await release();
  });
});

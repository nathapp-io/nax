import { afterEach, describe, expect, test } from "bun:test";
import type {
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { type AgentLogger, setAgentLogger } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, MAX_PENDING_DECISIONS, type PermissionDecider } from "#src/client/inbound";

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

  test("a throwing decider answers cancelled", async () => {
    const router = createInboundRouter(async () => {
      throw new Error("boom");
    });
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onPermission(request("a"))).toEqual(CANCELLED);
    await release();
  });
});

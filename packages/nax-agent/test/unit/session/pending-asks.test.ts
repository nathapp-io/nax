/**
 * S3-4: the pending-ask table (spec 4.2 answer, 6.1). A request settles once:
 * by answer(), by its deadline or by its turn signal. Late or repeated
 * answers get a status; never-issued ids and kind mismatches throw; after
 * close every answer is "unknown".
 */
import { describe, expect, test } from "bun:test";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { createPendingAskTable } from "#src/session/pending-asks";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

interface ManualTimers {
  fire(): void;
  readonly count: () => number;
}

function manualTimers(): ManualTimers {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  _agentSessionDeps.setTimeout = (fn: () => void): unknown => {
    const id = nextId++;
    pending.set(id, fn);
    return id;
  };
  _agentSessionDeps.clearTimeout = (handle: unknown): void => {
    pending.delete(Number(handle));
  };
  return {
    fire() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    count: () => pending.size,
  };
}

function expectInvalid(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe("AGENT_SESSION_INVALID_ANSWER");
}

describe("createPendingAskTable", () => {
  withDepsRestore(_agentSessionDeps);

  test("issue returns an id and the deadline in ISO form", () => {
    manualTimers();
    _agentSessionDeps.now = () => 0;
    _agentSessionDeps.randomUUID = () => "req-1";
    const issued = createPendingAskTable(600_000).issue("approval", undefined);
    expect(issued.requestId).toBe("req-1");
    expect(issued.expiresAt).toBe("1970-01-01T00:10:00.000Z");
  });

  test("an answer settles the request; a repeat answer is expired", async () => {
    const timers = manualTimers();
    const table = createPendingAskTable(30_000);
    const ask = table.issue("approval", undefined);
    expect(table.answer(ask.requestId, { decision: "allow" })).toBe("accepted");
    expect(await ask.settled).toEqual({ by: "human", reply: { decision: "allow" } });
    expect(timers.count()).toBe(0);
    expect(table.answer(ask.requestId, { decision: "deny" })).toBe("expired");
  });

  test("the deadline settles as timeout; a late answer is expired", async () => {
    const timers = manualTimers();
    const table = createPendingAskTable(30_000);
    const ask = table.issue("question", undefined);
    timers.fire();
    expect(await ask.settled).toEqual({ by: "timeout" });
    expect(table.answer(ask.requestId, { text: "late" })).toBe("expired");
  });

  test("the turn signal settles as cancelled; an answer then is cancelled", async () => {
    const timers = manualTimers();
    const table = createPendingAskTable(30_000);
    const controller = new AbortController();
    const ask = table.issue("approval", controller.signal);
    controller.abort();
    expect(await ask.settled).toEqual({ by: "cancelled" });
    expect(timers.count()).toBe(0);
    expect(table.answer(ask.requestId, { decision: "allow" })).toBe("cancelled");
  });

  test("an already-aborted signal settles at once", async () => {
    manualTimers();
    const controller = new AbortController();
    controller.abort();
    const ask = createPendingAskTable(30_000).issue("approval", controller.signal);
    expect(await ask.settled).toEqual({ by: "cancelled" });
  });

  test("a never-issued id, a kind mismatch and a malformed reply throw", () => {
    manualTimers();
    const table = createPendingAskTable(30_000);
    const approval = table.issue("approval", undefined);
    const question = table.issue("question", undefined);
    expectInvalid(() => table.answer("nope", { decision: "allow" }));
    expectInvalid(() => table.answer(approval.requestId, { text: "yes" }));
    expectInvalid(() => table.answer(question.requestId, { decision: "allow" }));
    const malformed: unknown = { decision: "maybe" };
    expectInvalid(() => table.answer(approval.requestId, malformed as { decision: "allow" }));
  });

  test("cancelAll settles every pending request as cancelled", async () => {
    manualTimers();
    const table = createPendingAskTable(30_000);
    const a = table.issue("approval", undefined);
    const b = table.issue("question", undefined);
    table.cancelAll();
    expect(await a.settled).toEqual({ by: "cancelled" });
    expect(await b.settled).toEqual({ by: "cancelled" });
  });

  test("after close: pending requests are cancelled and every answer is unknown", async () => {
    manualTimers();
    const table = createPendingAskTable(30_000);
    const ask = table.issue("approval", undefined);
    table.close();
    expect(await ask.settled).toEqual({ by: "cancelled" });
    expect(table.answer(ask.requestId, { decision: "allow" })).toBe("unknown");
    expect(table.answer("never-issued", { decision: "allow" })).toBe("unknown");
    expect(await table.issue("question", undefined).settled).toEqual({ by: "cancelled" });
  });
});

/**
 * S3-4: approvals raised to the person (spec 6.1). askPerson emits
 * approval_requested, waits on the table, emits approval_resolved. The coding
 * tools' AskLink denies unshowable requests without prompting and takes the
 * call id from the session's current-call slot.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEventBody } from "@nathapp/nax-agent";
import type { AskRequest } from "#src/permissions/index";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { createPendingAskTable } from "#src/session/pending-asks";
import {
  askPerson,
  createSessionAskLink,
  createSessionAskResolver,
  type SessionAskDeps,
} from "#src/session/session-ask-link";
import { createSessionAskPort } from "#src/session/session-ask-port";
import { withDepsRestore } from "#test/helpers/index";

interface Harness {
  readonly deps: SessionAskDeps;
  readonly link: ReturnType<typeof createSessionAskLink>;
  readonly events: SessionEventBody[];
  readonly fire: () => void;
}

function harness(callId?: string): Harness {
  const timers: Array<() => void> = [];
  _agentSessionDeps.setTimeout = (fn: () => void): unknown => timers.push(fn);
  _agentSessionDeps.clearTimeout = () => {};
  _agentSessionDeps.now = () => 0;
  let n = 0;
  _agentSessionDeps.randomUUID = () => `req-${++n}`;
  const events: SessionEventBody[] = [];
  const emit = (body: SessionEventBody): void => {
    events.push(body);
  };
  const table = createPendingAskTable(30_000);
  const turn = new AbortController();
  const deps: SessionAskDeps = {
    table,
    emit,
  };
  const port = createSessionAskPort({ table, emit, turn: () => ({ turnId: "t", signal: turn.signal }) });
  const link = createSessionAskLink({ port, currentCallId: () => callId });
  const fire = (): void => {
    for (const fn of timers.splice(0)) fn();
  };
  return { deps, link, events, fire };
}

const request: AskRequest = {
  tool: "Bash",
  stage: "session",
  rule: "Bash(*)",
  summary: "rm -rf build",
  command: "rm -rf build",
  reason: "matches an ask rule",
};

describe("askPerson", () => {
  withDepsRestore(_agentSessionDeps);

  test("emits approval_requested, then approval_resolved with the person's decision", async () => {
    const { deps, events } = harness();
    const outcome = askPerson(
      deps,
      { tool: "deploy", summary: "deploy v2", reason: "always", callId: "c9" },
      undefined,
    );
    expect(events).toEqual([
      {
        type: "approval_requested",
        requestId: "req-1",
        callId: "c9",
        tool: "deploy",
        summary: "deploy v2",
        reason: "always",
        expiresAt: "1970-01-01T00:00:30.000Z",
      },
    ]);
    expect(deps.table.answer("req-1", { decision: "allow" })).toBe("accepted");
    expect(await outcome).toEqual({ decision: "allow", decidedBy: "human" });
    expect(events[1]).toEqual({ type: "approval_resolved", requestId: "req-1", decision: "allow", decidedBy: "human" });
  });

  test("the deadline denies with decidedBy timeout", async () => {
    const { deps, events, fire } = harness();
    const outcome = askPerson(deps, { tool: "deploy", summary: "s", reason: "r" }, undefined);
    fire();
    expect(await outcome).toEqual({ decision: "deny", decidedBy: "timeout" });
    expect(events[1]).toMatchObject({ type: "approval_resolved", decision: "deny", decidedBy: "timeout" });
  });

  test("the turn signal denies with decidedBy cancelled", async () => {
    const { deps } = harness();
    const controller = new AbortController();
    const outcome = askPerson(deps, { tool: "deploy", summary: "s", reason: "r" }, controller.signal);
    controller.abort();
    expect(await outcome).toEqual({ decision: "deny", decidedBy: "cancelled" });
  });
});

describe("createSessionAskLink", () => {
  withDepsRestore(_agentSessionDeps);

  test("raises the request with the full command and the current call id", async () => {
    const { deps, link, events } = harness("call-7");
    const pending = link.resolve(request);
    expect(events[0]).toMatchObject({
      type: "approval_requested",
      callId: "call-7",
      tool: "Bash",
      command: "rm -rf build",
      reason: "matches an ask rule",
    });
    deps.table.answer("req-1", { decision: "deny" });
    expect(await pending).toEqual({ decision: "deny", decidedBy: "human" });
  });

  test("the command is masked before it is shown", () => {
    const { link, events } = harness();
    const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    void link.resolve({ ...request, command: `git push https://${token}@github.com/o/r` });
    const shown = events[0];
    expect(shown?.type).toBe("approval_requested");
    expect(JSON.stringify(shown)).not.toContain(token);
    expect(JSON.stringify(shown)).toContain("[REDACTED");
  });

  test("an unshowable request is denied without prompting", async () => {
    const { link, events } = harness();
    const outcome = await link.resolve({ ...request, unshowable: true });
    expect(outcome).toEqual({ decision: "deny", decidedBy: "unshowable" });
    expect(events).toEqual([]);
  });

  test("without a reason, the matched rule is named", () => {
    const { link, events } = harness();
    const { reason: _dropped, ...noReason } = request;
    void link.resolve(noReason);
    expect(events[0]).toMatchObject({ reason: "matched Bash(*)" });
  });
});

describe("createSessionAskResolver", () => {
  withDepsRestore(_agentSessionDeps);

  test("marks a person reachable and resolves through the link", async () => {
    const { deps, link } = harness();
    const resolver = createSessionAskResolver(link);
    expect(resolver.humanReachable).toBe(true);
    const verdict = resolver.resolve(request);
    deps.table.answer("req-1", { decision: "allow" });
    expect(await verdict).toMatchObject({ decision: "allow", decidedBy: "human" });
  });
});

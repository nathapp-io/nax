/**
 * US-004: the chat host's `steer`, a plain delegation to the session facade.
 *
 * The screen asks the host on every ctrl+s, so the host has two jobs and only two: hand the
 * text to the open session, and answer `no_turn` — not an error — when there is no session to
 * hand it to. Everything else (whether the backend can steer, whether a turn is running) is
 * the facade's answer and travels back unchanged.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession, SessionMeta, SteerResult } from "@nathapp/nax-agent";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import { createChatHost, createChatStorage } from "@/chat";

const hosts: ReturnType<typeof createChatHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

interface FixtureOptions {
  /** The session's own `steer`; absent leaves a session that does not implement it. */
  readonly steer?: AgentSession["steer"];
}

/** A host whose opened session is a stub, so nothing but the delegation is under test. */
function fixture(options: FixtureOptions = {}) {
  const send = mock(() => (async function* () {})());
  const session: AgentSession = {
    id: "steer-session",
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    send,
    answer: () => "accepted",
    cancel() {},
    close: async () => {},
    ...(options.steer === undefined ? {} : { steer: options.steer }),
  };
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: session.id,
    cwd: "/r",
    mode: "ask",
    model: "model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
  };
  const host = createChatHost({
    config: makeNaxConfig(),
    cwd: "/r",
    repoRoot: "/r",
    chain: null,
    storage: createChatStorage({ pid: process.pid, now: () => new Date(), logger: makeLogger() }),
    now: () => new Date(),
    logger: makeLogger(),
    open: async () => ({ session, meta, release: async () => {} }),
  });
  hosts.push(host);
  return { host, session, send };
}

describe("ChatHost.steer", () => {
  test("AC-1 returns the open session's steer result unchanged", async () => {
    const accepted: SteerResult = { status: "accepted", steerId: "steer-1", applied: Promise.resolve(true) };
    const steer = mock((_text: string) => accepted);
    const f = fixture({ steer });
    await f.host.start({ mode: "guarded", model: "model" });
    expect(f.host.steer?.("x")).toBe(accepted);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith("x");
  });

  test("AC-2 returns no_turn when no session is open", () => {
    const steer = mock((_text: string) => ({ status: "unsupported" }) as SteerResult);
    const f = fixture({ steer });
    expect(f.host.steer?.("x")).toEqual({ status: "no_turn" });
    expect(steer).not.toHaveBeenCalled();
  });

  test("returns unsupported for an open session whose facade has no steer", async () => {
    const f = fixture();
    await f.host.start({ mode: "guarded", model: "model" });
    expect(f.host.steer?.("x")).toEqual({ status: "unsupported" });
    expect(f.send).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------------------------------
 * The claim a turn takes. ctrl+s and escape act on the session's own single-flight slot —
 * `steer` answers `no_turn` and `cancel` does nothing when there is none — and both can
 * arrive in the same batch as the return that started the turn, before the screen redraws
 * and before the host has had an `await` to return from. So `send` claims synchronously: the
 * accounting queue serializes only the metadata write that follows the turn.
 * ------------------------------------------------------------------------------------- */

/** The slot a stub session keeps, as the host's keys can observe it. */
interface Claim {
  claimed: boolean;
  cancelled: boolean;
  /** Whether the slot was taken when `cancel` ran: a cancel with no claim cancels nothing. */
  claimedOnCancel: boolean;
}

/**
 * A host over a session with the facade's shape: `send` takes the slot synchronously and
 * hands back the iterable, and the turn's own work runs when the consumer first pulls. The
 * turn parks inside its stream until `release()`, so a key can be pressed while it is live.
 */
function claimFixture() {
  const claim: Claim = { claimed: false, cancelled: false, claimedOnCancel: false };
  /** The statuses of the `turn_end`s the session emitted. */
  const endings: string[] = [];
  const gate = Promise.withResolvers<void>();
  const cancel = mock(() => {
    claim.claimedOnCancel = claim.claimed;
    claim.cancelled = true;
    gate.resolve();
  });
  const steer = mock(
    (text: string): SteerResult =>
      claim.claimed && !claim.cancelled
        ? { status: "accepted", steerId: `steer-${text}`, applied: Promise.resolve(false) }
        : { status: "no_turn" },
  );
  const session: AgentSession = {
    id: "claim-session",
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    send() {
      claim.claimed = true;
      return {
        async *[Symbol.asyncIterator]() {
          const base = { sessionId: "claim-session", turnId: "turn-1", at: "now", metadata: {} };
          yield { ...base, type: "turn_start" as const };
          await gate.promise;
          const status = claim.cancelled ? ("cancelled" as const) : ("completed" as const);
          yield {
            ...base,
            type: "turn_end" as const,
            status,
            output: "",
            usage: { inputTokens: 0, outputTokens: 0 },
            costUsd: 0,
          };
          endings.push(status);
        },
      };
    },
    answer: () => "accepted",
    steer,
    cancel,
    close: async () => {},
  };
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: session.id,
    cwd: "/r",
    mode: "ask",
    model: "model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
  };
  const host = createChatHost({
    config: makeNaxConfig(),
    cwd: "/r",
    repoRoot: "/r",
    chain: null,
    storage: createChatStorage({ pid: process.pid, now: () => new Date(), logger: makeLogger() }),
    now: () => new Date(),
    logger: makeLogger(),
    open: async () => ({ session, meta, release: async () => {} }),
  });
  hosts.push(host);
  return { host, claim, endings, steer, cancel, release: () => gate.resolve() };
}

describe("the claim a turn takes", () => {
  test("B2 ctrl+s in the batch that started the turn steers that turn", async () => {
    const f = claimFixture();
    await f.host.start({ mode: "guarded", model: "model" });
    const sending = f.host.send("hello", () => {});
    // No await: this is the ctrl+s of the same batch as the return above, so nothing the
    // accounting queue defers has run yet.
    expect(f.host.steer?.("x")).toMatchObject({ status: "accepted" });
    expect(f.steer).toHaveBeenCalledWith("x");
    f.release();
    await sending;
  });

  test("B2 escape in the batch that started the turn cancels a claim, not nothing", async () => {
    const f = claimFixture();
    await f.host.start({ mode: "guarded", model: "model" });
    const sending = f.host.send("hello", () => {});
    f.host.cancel();
    expect(f.claim.claimedOnCancel).toBe(true);
    f.release();
    await sending;
    expect(f.endings).toEqual(["cancelled"]);
  });
});

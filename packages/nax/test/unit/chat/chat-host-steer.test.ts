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

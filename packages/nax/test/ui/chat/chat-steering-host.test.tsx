/**
 * US-004: ctrl+s and escape over the *real* host — `createChatHost` over a session stub.
 *
 * The key is only worth binding if it reaches a session that is actually there, and the
 * session's single-flight slot is what it reaches: `steer` answers `no_turn` and `cancel`
 * does nothing when no turn has claimed it. Both keys can arrive in the same batch as the
 * return which starts the turn, before the screen redraws and before the host has had an
 * `await` to return from, so the claim is synchronous with `ChatHost.send` — the accounting
 * queue serializes the metadata write that follows the turn, never the claim.
 *
 * Split out of `chat-steering.test.tsx` (the screen-level cases) at the 650-line target for
 * test files; every case here mounts the real host rather than the fake one.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession, SessionMeta, SteerResult } from "@nathapp/nax-agent";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { createChatHost, createChatStorage } from "@/chat";
import { ChatApp } from "@/tui/chat/ChatApp";
import { resolveChatTheme } from "@/tui/chat/theme";

const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const RETURN = "\r";
/** ink reports ctrl+s as the letter `s` with the ctrl modifier. */
const CTRL_S = "\x13";
/** ink reports escape as the bare ESC byte. */
const ESCAPE = "\x1b";

const MODEL = "test-model";
const REPO_ROOT = "/repo";

afterEach(() => {
  cleanup();
  mock.restore();
});

function metaOf(): SessionMeta {
  return {
    schemaVersion: 1,
    sessionId: "steer-session",
    cwd: REPO_ROOT,
    mode: "ask",
    model: MODEL,
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
    costUsd: 0,
  };
}

/** The keys of one batch, each its own write so ink parses them as separate keypresses. */
async function batch(ui: ReturnType<typeof render>, sequences: readonly string[]): Promise<void> {
  await Promise.resolve(
    act(async () => {
      for (const sequence of sequences) ui.stdin.write(sequence);
    }),
  );
  for (let flush = 0; flush < 5; flush++) {
    await Promise.resolve(
      act(async () => {
        await Promise.resolve();
      }),
    );
  }
}

/* ---------------------------------------------------------------------------------------
 * AC-3: the screen asks a host, and the host asks the session.
 * ------------------------------------------------------------------------------------- */

/** A real `createChatHost` over a stub session, with a turn left running after `hi`. */
async function realHostWithStubSession() {
  const applied = Promise.withResolvers<boolean>();
  const steer = mock(
    (_text: string): SteerResult => ({ status: "accepted", steerId: "steer-1", applied: applied.promise }),
  );
  const gate = Promise.withResolvers<void>();
  const session: AgentSession = {
    id: "steer-session",
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {
      yield { sessionId: "steer-session", turnId: "t1", at: "now", metadata: {}, type: "turn_start" };
      await gate.promise;
    },
    answer: () => "accepted",
    cancel() {},
    close: async () => {},
    steer,
  };
  const host = createChatHost({
    config: makeNaxConfig(),
    cwd: REPO_ROOT,
    repoRoot: REPO_ROOT,
    chain: null,
    storage: createChatStorage({ pid: process.pid, now: () => new Date(), logger: makeLogger() }),
    now: () => new Date(),
    logger: makeLogger(),
    open: async () => ({ session, meta: metaOf(), release: async () => {} }),
  });
  await host.start({ mode: "guarded", model: MODEL });
  return { host, steer, release: () => gate.resolve() };
}

describe("ctrl+s over the real host", () => {
  test("AC-3 steers the open session once with the typed text", async () => {
    const real = await realHostWithStubSession();
    const ui = render(<ChatApp host={real.host} theme={THEME} />);
    try {
      act(() => {
        ui.stdin.write("hi");
      });
      await Promise.resolve(
        act(async () => {
          ui.stdin.write(RETURN);
        }),
      );
      act(() => {
        ui.stdin.write("x");
      });
      await Promise.resolve(
        act(async () => {
          ui.stdin.write(CTRL_S);
        }),
      );
      expect(real.steer).toHaveBeenCalledTimes(1);
      expect(real.steer).toHaveBeenCalledWith("x");
    } finally {
      real.release();
      await real.host.close();
    }
  });
});

/* ---------------------------------------------------------------------------------------
 * The same batch, over the real host: the keys carry a turn that was started a keystroke
 * earlier, so its claim must exist by the time they run — not a microtask later.
 * ------------------------------------------------------------------------------------- */

/** The slot the stub session keeps, as the host's keys can observe it. */
interface Claim {
  claimed: boolean;
  cancelled: boolean;
  /** Whether the slot was taken when `cancel` ran: a cancel with no claim cancels nothing. */
  claimedOnCancel: boolean;
}

/**
 * A real `createChatHost` over a session with the facade's shape: `send` takes the slot
 * synchronously and the turn runs on the consumer's first pull, where it parks until the case
 * releases it. `steer` answers from that slot, exactly as the facade does, so a key that
 * arrives before the claim gets `no_turn`.
 */
async function realHostWithClaim() {
  const claim: Claim = { claimed: false, cancelled: false, claimedOnCancel: false };
  const gate = Promise.withResolvers<void>();
  const steer = mock(
    (text: string): SteerResult =>
      claim.claimed && !claim.cancelled
        ? { status: "accepted", steerId: `steer-${text}`, applied: Promise.resolve(false) }
        : { status: "no_turn" },
  );
  const session: AgentSession = {
    id: "steer-session",
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    send() {
      claim.claimed = true;
      return {
        async *[Symbol.asyncIterator]() {
          const base = { sessionId: "steer-session", turnId: "t1", at: "now", metadata: {} };
          yield { ...base, type: "turn_start" as const };
          await gate.promise;
          yield {
            ...base,
            type: "turn_end" as const,
            status: claim.cancelled ? ("cancelled" as const) : ("completed" as const),
            output: "",
            usage: { inputTokens: 0, outputTokens: 0 },
            costUsd: 0,
          };
        },
      };
    },
    answer: () => "accepted",
    cancel: mock(() => {
      claim.claimedOnCancel = claim.claimed;
      claim.cancelled = true;
      gate.resolve();
    }),
    close: async () => {},
    steer,
  };
  const host = createChatHost({
    config: makeNaxConfig(),
    cwd: REPO_ROOT,
    repoRoot: REPO_ROOT,
    chain: null,
    storage: createChatStorage({ pid: process.pid, now: () => new Date(), logger: makeLogger() }),
    now: () => new Date(),
    logger: makeLogger(),
    open: async () => ({ session, meta: metaOf(), release: async () => {} }),
  });
  await host.start({ mode: "guarded", model: MODEL });
  return { host, claim, steer, session, release: () => gate.resolve() };
}

describe("ctrl+s batched behind the return that started the turn, over the real host", () => {
  test("B2 steers the turn the batch itself started", async () => {
    const real = await realHostWithClaim();
    const ui = render(<ChatApp host={real.host} theme={THEME} />);
    try {
      await batch(ui, ["hi", RETURN, "x", CTRL_S]);
      expect(real.steer).toHaveBeenCalledTimes(1);
      expect(real.steer).toHaveBeenCalledWith("x");
      // Accepted, not interrupted: the key found the turn the batch itself started, so the
      // screen had no reason to cancel it and hold the line for a later send.
      expect(real.session.cancel).not.toHaveBeenCalled();
    } finally {
      real.release();
      await real.host.close();
    }
  });

  test("B2 escape in that batch cancels the claim it started", async () => {
    const real = await realHostWithClaim();
    const ui = render(<ChatApp host={real.host} theme={THEME} />);
    try {
      await batch(ui, ["hi", RETURN, ESCAPE]);
      // The claim existed when the key ran: the turn's own `cancel` reached a live slot.
      expect(real.claim.claimedOnCancel).toBe(true);
    } finally {
      real.release();
      await real.host.close();
    }
  });
});

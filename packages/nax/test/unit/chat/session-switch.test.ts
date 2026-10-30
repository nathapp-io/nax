/**
 * US-005 AC-1..AC-11, AC-16: the chat switch state machine — in place, close and reopen,
 * rollback and the new-session recovery — driven through injected open/reopen seams.
 */
import { describe, expect, mock, test } from "bun:test";
import { type AgentSession, AgentSessionError, type SessionMeta } from "@nathapp/nax-agent";
import type { ChatSessionHandle } from "@/chat/open-chat-session";
import {
  ROLLBACK_NEW_SESSION_NOTICE,
  type SwitchInput,
  type SwitchTarget,
  switchChatSession,
} from "@/chat/session-switch";
import { NaxError } from "@/errors";

const NOW = "2026-10-01T00:00:00.000Z";
const ACP_FROM: SwitchTarget = { mode: "guarded", model: "acp:codex/gpt-5.5" };
const ACP_TO: SwitchTarget = { mode: "guarded", model: "acp:codex/gpt-5.5[high]" };

function metaOf(sessionId: string, model: string): SessionMeta {
  return {
    schemaVersion: 1,
    sessionId,
    cwd: "/tmp/x",
    mode: "ask",
    model,
    bashApproval: "gated",
    title: null,
    createdAt: NOW,
    updatedAt: null,
  };
}

interface Fake {
  readonly handle: ChatSessionHandle;
  readonly close: ReturnType<typeof mock<() => Promise<void>>>;
  readonly release: ReturnType<typeof mock<ChatSessionHandle["release"]>>;
  readonly configure: ReturnType<typeof mock<NonNullable<AgentSession["configure"]>>> | undefined;
}

function fakeHandle(options: {
  readonly id: string;
  readonly model: string;
  readonly log?: string[];
  readonly configure?: NonNullable<AgentSession["configure"]> | null;
}): Fake {
  const { id, model, log, configure } = options;
  const close = mock(async () => {
    log?.push(`close ${id}`);
  });
  const release = mock<ChatSessionHandle["release"]>(async (opts) => {
    log?.push(`release ${id}${opts?.retainLock ? " retain" : ""}`);
  });
  const configureMock = configure === null ? undefined : mock(configure ?? (async () => {}));
  const session: AgentSession = {
    id,
    backend: { kind: "acp:test", capabilities: {} },
    lastTurn: undefined,
    async *send() {},
    answer: () => "unknown",
    cancel() {},
    close,
    ...(configureMock ? { configure: configureMock } : {}),
  };
  return { handle: { session, meta: metaOf(id, model), release }, close, release, configure: configureMock };
}

interface Rig {
  readonly previous: Fake;
  readonly input: SwitchInput;
  readonly reopen: ReturnType<typeof mock<SwitchInput["reopen"]>>;
  readonly openFresh: ReturnType<typeof mock<SwitchInput["openFresh"]>>;
  readonly writeMeta: ReturnType<typeof mock<SwitchInput["writeMeta"]>>;
  readonly log: string[];
}

function rig(options: {
  readonly from?: SwitchTarget;
  readonly target?: SwitchTarget;
  readonly configure?: NonNullable<AgentSession["configure"]> | null;
  readonly reopen?: SwitchInput["reopen"];
  readonly openFresh?: SwitchInput["openFresh"];
  readonly writeMeta?: SwitchInput["writeMeta"];
}): Rig {
  const from = options.from ?? ACP_FROM;
  const log: string[] = [];
  const previous = fakeHandle({ id: "old", model: from.model, log, configure: options.configure });
  const reopen = mock(
    options.reopen ??
      (async (to: SwitchTarget) => {
        log.push(`reopen ${to.model}`);
        return fakeHandle({ id: "old", model: to.model, log }).handle;
      }),
  );
  const openFresh = mock(
    options.openFresh ?? (async (to: SwitchTarget) => fakeHandle({ id: "fresh", model: to.model, log }).handle),
  );
  const writeMeta = mock(options.writeMeta ?? (async () => {}));
  return {
    previous,
    reopen,
    openFresh,
    writeMeta,
    log,
    input: {
      previous: previous.handle,
      from,
      target: options.target ?? ACP_TO,
      reopen,
      openFresh,
      writeMeta,
    },
  };
}

function unsupported(): AgentSessionError {
  return new AgentSessionError("configure unsupported", "AGENT_SESSION_CAPABILITY_UNSUPPORTED");
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
}

describe("switchChatSession in place", () => {
  test("AC-1 a resolving configure writes the meta once, never closes or reopens and keeps the session", async () => {
    const r = rig({});
    const outcome = await switchChatSession(r.input);
    expect(r.previous.configure).toHaveBeenCalledTimes(1);
    expect(r.previous.configure).toHaveBeenCalledWith({ effort: "high" });
    expect(r.writeMeta).toHaveBeenCalledTimes(1);
    expect(r.writeMeta).toHaveBeenCalledWith({ ...r.previous.handle.meta, model: ACP_TO.model });
    expect(r.previous.close).not.toHaveBeenCalled();
    expect(r.reopen).not.toHaveBeenCalled();
    expect(outcome.handle.session).toBe(r.previous.handle.session);
    expect(outcome.handle.meta.model).toBe(ACP_TO.model);
    expect(outcome.error).toBeUndefined();
    expect(outcome.notice).toBeUndefined();
  });

  test("AC-2 a configure rejecting with CAPABILITY_UNSUPPORTED closes the previous session and reopens the target", async () => {
    const r = rig({ configure: async () => Promise.reject(unsupported()) });
    const outcome = await switchChatSession(r.input);
    expect(r.previous.close).toHaveBeenCalledTimes(1);
    expect(r.reopen).toHaveBeenCalledTimes(1);
    expect(r.reopen).toHaveBeenCalledWith(ACP_TO);
    expect(outcome.handle.meta.model).toBe(ACP_TO.model);
    expect(outcome.handle.session).not.toBe(r.previous.handle.session);
    expect("error" in outcome).toBe(false);
  });

  test("AC-3 a configure that resolves but whose first writeMeta rejects falls back to close and reopen", async () => {
    let calls = 0;
    const r = rig({
      writeMeta: async () => {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
      },
    });
    const outcome = await switchChatSession(r.input);
    expect(r.previous.configure).toHaveBeenCalledTimes(1);
    expect(r.previous.close).toHaveBeenCalledTimes(1);
    expect(r.reopen).toHaveBeenCalledWith(ACP_TO);
    expect(r.writeMeta).toHaveBeenCalledTimes(2);
    expect(outcome.handle.meta.model).toBe(ACP_TO.model);
    expect(outcome.handle.session).not.toBe(r.previous.handle.session);
    expect(outcome.error).toBeUndefined();
  });

  test("AC-4 a mode change never calls configure and takes the close-and-reopen path", async () => {
    const r = rig({ target: { mode: "full", model: ACP_TO.model } });
    const outcome = await switchChatSession(r.input);
    expect(r.previous.configure).not.toHaveBeenCalled();
    expect(r.previous.close).toHaveBeenCalledTimes(1);
    expect(r.reopen).toHaveBeenCalledWith({ mode: "full", model: ACP_TO.model });
    expect(outcome.handle.session).not.toBe(r.previous.handle.session);
  });

  test("AC-5 a previous session without configure takes the close-and-reopen path", async () => {
    const r = rig({ configure: null });
    const outcome = await switchChatSession(r.input);
    expect(r.previous.close).toHaveBeenCalledTimes(1);
    expect(r.reopen).toHaveBeenCalledWith(ACP_TO);
    expect(outcome.handle.session).not.toBe(r.previous.handle.session);
  });

  test("AC-5 a change that is not an in-place change (native model) reopens without configure", async () => {
    const r = rig({
      from: { mode: "guarded", model: "openai/gpt-6" },
      target: { mode: "guarded", model: "openai/gpt-7" },
    });
    await switchChatSession(r.input);
    expect(r.previous.configure).not.toHaveBeenCalled();
    expect(r.reopen).toHaveBeenCalledTimes(1);
  });

  test("AC-16 a configure failing with any other error falls back to close and reopen", async () => {
    const r = rig({ configure: async () => Promise.reject(new Error("socket reset")) });
    const outcome = await switchChatSession(r.input);
    expect(r.previous.close).toHaveBeenCalledTimes(1);
    expect(r.reopen).toHaveBeenCalledWith(ACP_TO);
    expect(outcome.handle.meta.model).toBe(ACP_TO.model);
    expect(outcome.error).toBeUndefined();
  });
});

describe("switchChatSession close and reopen", () => {
  test("AC-11 releases the previous handle with retainLock after closing it and before reopening the target", async () => {
    const r = rig({ configure: null });
    await switchChatSession(r.input);
    expect(r.previous.release).toHaveBeenCalledWith({ retainLock: true });
    expect(r.log.slice(0, 3)).toEqual(["close old", "release old retain", "reopen acp:codex/gpt-5.5[high]"]);
  });

  test("writes the reopened handle's meta", async () => {
    const r = rig({ configure: null });
    const outcome = await switchChatSession(r.input);
    expect(r.writeMeta).toHaveBeenCalledTimes(1);
    expect(r.writeMeta).toHaveBeenCalledWith(outcome.handle.meta);
  });
});

describe("switchChatSession rollback", () => {
  test("AC-6 a failed reopen(target) with a working reopen(from) returns the rolled-back handle and the error, no notice", async () => {
    const failure = new Error("agent gone");
    const log: string[] = [];
    const r = rig({
      configure: null,
      reopen: async (to) => {
        log.push(`reopen ${to.model}`);
        if (to.model === ACP_TO.model) throw failure;
        return fakeHandle({ id: "old", model: to.model }).handle;
      },
    });
    const outcome = await switchChatSession(r.input);
    expect(outcome.error).toBe(failure);
    expect(outcome.notice).toBeUndefined();
    expect(outcome.handle.meta.model).toBe(ACP_FROM.model);
    expect(outcome.handle.meta.sessionId).toBe("old");
    expect(r.reopen).toHaveBeenLastCalledWith(ACP_FROM);
    expect(r.openFresh).not.toHaveBeenCalled();
  });

  test("a half-opened next whose meta write fails is closed and released before the rollback reopen", async () => {
    const failure = new Error("write failed");
    const half = fakeHandle({ id: "old", model: ACP_TO.model });
    let opened = 0;
    const r = rig({
      configure: null,
      reopen: async (to) => {
        opened += 1;
        return opened === 1 ? half.handle : fakeHandle({ id: "old", model: to.model }).handle;
      },
      writeMeta: async () => {
        throw failure;
      },
    });
    const outcome = await switchChatSession(r.input);
    expect(half.close).toHaveBeenCalledTimes(1);
    expect(half.release).toHaveBeenCalledWith({ retainLock: true });
    expect(outcome.error).toBe(failure);
    expect(outcome.handle.meta.model).toBe(ACP_FROM.model);
  });
});

describe("switchChatSession new session", () => {
  const switchFailure = new Error("agent gone\nsecond line");
  const rollbackFailure = new Error("still gone");

  function failingBoth(openFresh?: SwitchInput["openFresh"]): Rig {
    return rig({
      configure: null,
      reopen: async (to) => {
        throw to.model === ACP_TO.model ? switchFailure : rollbackFailure;
      },
      ...(openFresh ? { openFresh } : {}),
    });
  }

  test("AC-7 releases the previous handle without retainLock, opens fresh on the original target and returns the notice", async () => {
    const r = failingBoth();
    const outcome = await switchChatSession(r.input);
    expect(r.previous.release).toHaveBeenLastCalledWith();
    expect(r.openFresh).toHaveBeenCalledTimes(1);
    expect(r.openFresh).toHaveBeenCalledWith(ACP_FROM);
    expect(r.log.at(-1)).toBe("release old");
    expect(outcome.handle.meta.sessionId).toBe("fresh");
    expect(outcome.error).toBe(switchFailure);
    expect(outcome.notice).toBe(ROLLBACK_NEW_SESSION_NOTICE("old", "agent gone"));
  });

  test("AC-8 the notice text is exact", () => {
    expect(ROLLBACK_NEW_SESSION_NOTICE("abc", "agent gone")).toBe(
      "could not reopen session abc after the failed switch (agent gone); started a new session (/resume abc retries it)",
    );
  });

  test("AC-9 AC-10 when openFresh fails too it rejects with CHAT_SESSION_REOPEN_FAILED carrying both failures", async () => {
    const freshFailure = new Error("no slots");
    const r = failingBoth(async () => {
      throw freshFailure;
    });
    const error = await rejectionOf(switchChatSession(r.input));
    if (!(error instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(error)}`);
    const naxError = error;
    expect(naxError.code).toBe("CHAT_SESSION_REOPEN_FAILED");
    expect(naxError.cause).toBe(freshFailure);
    expect(naxError.context?.cause).toBe(freshFailure);
    expect(naxError.context).toMatchObject({
      stage: "chat",
      sessionId: "old",
      switchError: "agent gone\nsecond line",
    });
    expect(naxError.message).toContain("agent gone");
    expect(naxError.message).toContain("no slots");
    expect(r.previous.release).toHaveBeenLastCalledWith();
  });
});

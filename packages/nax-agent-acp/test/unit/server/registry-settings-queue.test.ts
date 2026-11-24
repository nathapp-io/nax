/**
 * Two settings mutations that overlap on one session, and a resume that races a
 * delete (US-001). The second of two overlapping mutations must compute from the
 * metadata the first persisted, not from the stale metadata both read; and a
 * resume that lost its metadata to a delete while it waited must be refused
 * rather than reopen the deleted session.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { OPTIONS, setupRegistry } from "#test/helpers/registry-setup";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});
function dir(): string {
  const made = makeTempDir("acp-settings-queue-");
  dirs.push(made);
  return made;
}

const MODEL = "anthropic/claude-haiku-4-5";
const STORED_MODEL = "anthropic/claude-sonnet-5-5";
const PROMPT = [{ type: "text" as const, text: "go" }];

const priced = (costUsd: number): Script =>
  async function* () {
    yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd };
    yield turnEnd("completed");
  };

const codeOf = (error: unknown): number => (error instanceof RequestError ? error.code : 0);

type Settlement = "pending" | "fulfilled" | "rejected";

/** Reads a promise's settlement without awaiting it, so a test can assert "still pending". */
function settlementOf(promise: Promise<unknown>): () => Settlement {
  let settlement: Settlement = "pending";
  void promise.then(
    () => {
      settlement = "fulfilled";
    },
    () => {
      settlement = "rejected";
    },
  );
  return () => settlement;
}

/** Yields the event loop a few times, so a queued continuation would have run. */
async function tick(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Resolves at once for the create open (call 1), and holds the second call where a mutation parks. */
function heldCredentials() {
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const ensureCredentials = async (): Promise<void> => {
    calls += 1;
    if (calls !== 2) return;
    entered.resolve();
    await held.promise;
  };
  return { held, entered, ensureCredentials, calls: () => calls };
}

interface OverlapExtra {
  readonly scripts?: readonly Script[];
}

/**
 * The overlap fixture: a session created and switched to `full`; then the model
 * switch started (it parks on the held credential lookup) and the mode switch
 * started while it is parked.
 */
async function overlapFixture(d: string, extra: OverlapExtra = {}) {
  const credentials = heldCredentials();
  const s = setupRegistry(d, OPTIONS, {
    ensureCredentials: credentials.ensureCredentials,
    ...(extra.scripts !== undefined ? { scripts: extra.scripts } : {}),
  });
  const { sessionId } = await s.registry.create(s.input());
  await s.registry.setMode(sessionId, "full");
  const modelSwitch = s.registry.setConfigOption(sessionId, "model", MODEL);
  await credentials.entered.promise;
  const openedBeforeModeSwitch = s.opened.length;
  const modeSwitch = s.registry.setMode(sessionId, "read");
  return { s, sessionId, credentials, modelSwitch, modeSwitch, openedBeforeModeSwitch };
}

/** Releases the held lookup and shuts the registry down, whatever the test did. */
async function closeOverlap(fixture: Awaited<ReturnType<typeof overlapFixture>>): Promise<void> {
  fixture.credentials.held.resolve();
  await Promise.all([fixture.modelSwitch.catch(() => undefined), fixture.modeSwitch.catch(() => undefined)]);
  await fixture.s.registry.closeAll();
}

describe("two settings mutations that overlap on one session", () => {
  test("AC-1: both mutations resolve once the held credential lookup is released", async () => {
    const fixture = await overlapFixture(dir());
    try {
      expect(fixture.credentials.calls()).toBe(2);
      fixture.credentials.held.resolve();
      const [options] = await Promise.all([fixture.modelSwitch, fixture.modeSwitch]);
      expect(options.map((option) => option.id)).toEqual(["mode", "model", "bashApproval"]);
    } finally {
      await closeOverlap(fixture);
    }
  });

  test("AC-2: the persisted metadata carries both changes", async () => {
    const fixture = await overlapFixture(dir());
    try {
      fixture.credentials.held.resolve();
      await Promise.all([fixture.modelSwitch, fixture.modeSwitch]);
      expect(await fixture.s.storage.readMeta(fixture.sessionId)).toMatchObject({ mode: "read", model: MODEL });
    } finally {
      await closeOverlap(fixture);
    }
  });

  test("AC-3: the last open carries the read profile and the new model", async () => {
    const fixture = await overlapFixture(dir());
    try {
      fixture.credentials.held.resolve();
      await Promise.all([fixture.modelSwitch, fixture.modeSwitch]);
      expect(fixture.s.opened.at(-1)).toMatchObject({ profile: "read", model: MODEL });
    } finally {
      await closeOverlap(fixture);
    }
  });

  test("AC-4: the mode switch queued behind the parked model switch opens nothing", async () => {
    const fixture = await overlapFixture(dir());
    const settlement = settlementOf(fixture.modeSwitch);
    try {
      expect(fixture.openedBeforeModeSwitch).toBe(2); // the create and the switch to full
      await tick();
      expect(fixture.s.opened).toHaveLength(2);
      expect(settlement()).toBe("pending");
    } finally {
      await closeOverlap(fixture);
    }
  });

  test("AC-5: after release the model switch is recorded before the mode switch", async () => {
    const fixture = await overlapFixture(dir());
    try {
      fixture.credentials.held.resolve();
      await Promise.all([fixture.modelSwitch, fixture.modeSwitch]);
      const modelAt = fixture.s.opened.findIndex((request) => request.model === MODEL);
      const modeAt = fixture.s.opened.findIndex((request) => request.profile === "read");
      expect(modelAt).toBeGreaterThan(-1);
      expect(modeAt).toBeGreaterThan(modelAt);
    } finally {
      await closeOverlap(fixture);
    }
  });

  test("AC-6: a prompt started while both mutations wait still runs and keeps its cost", async () => {
    const fixture = await overlapFixture(dir(), { scripts: [priced(0.25)] });
    try {
      // Both settings calls have started and the credential lookup is still held: a turn is
      // not queued behind them, so the prompt runs now rather than after the mutations settle.
      expect(fixture.credentials.calls()).toBe(2);
      const reply = await fixture.s.registry.get(fixture.sessionId).prompt(PROMPT);
      expect(reply.stopReason).toBe("end_turn");
      expect((await fixture.s.storage.readMeta(fixture.sessionId))?.costUsd).toBe(0.25);
      fixture.credentials.held.resolve();
      await Promise.all([fixture.modelSwitch, fixture.modeSwitch]);
      expect((await fixture.s.storage.readMeta(fixture.sessionId))?.costUsd).toBe(0.25);
    } finally {
      await closeOverlap(fixture);
    }
  });
});

describe("settings mutations that do not overlap", () => {
  test("AC-7 (control): a model switch awaited before a mode switch persists both", async () => {
    const s = setupRegistry(dir(), OPTIONS);
    try {
      const { sessionId } = await s.registry.create(s.input());
      await s.registry.setConfigOption(sessionId, "model", MODEL);
      await s.registry.setMode(sessionId, "read");
      expect(await s.storage.readMeta(sessionId)).toMatchObject({ mode: "read", model: MODEL });
    } finally {
      await s.registry.closeAll();
    }
  });

  test("AC-8: a failed first mutation rejects alone and the queued second one still runs", async () => {
    // open 1 is the create, open 2 the failing switch, open 3 its restore.
    const s = setupRegistry(dir(), OPTIONS, { failOpens: [2] });
    try {
      const { sessionId } = await s.registry.create(s.input());
      // Same tick: the second waits for the first instead of being refused by it.
      const [first, second] = await Promise.allSettled([
        s.registry.setMode(sessionId, "full"),
        s.registry.setMode(sessionId, "read"),
      ]);
      expect(first.status).toBe("rejected");
      expect(second.status).toBe("fulfilled");
      expect((await s.storage.readMeta(sessionId))?.mode).toBe("read");
    } finally {
      await s.registry.closeAll();
    }
  });

  test("AC-9 (control): an uncontended model switch asks for the new model in the same tick", async () => {
    const models: string[] = [];
    const s = setupRegistry(dir(), OPTIONS, {
      ensureCredentials: async (model) => {
        models.push(model);
      },
    });
    try {
      const { sessionId } = await s.registry.create(s.input());
      models.length = 0;
      const switching = s.registry.setConfigOption(sessionId, "model", MODEL);
      expect(models).toEqual([MODEL]);
      await switching;
    } finally {
      await s.registry.closeAll();
    }
  });
});

/**
 * The resume-versus-delete case: a stored session is closed, a resume parks on the
 * second credential lookup (the create was the first) with its metadata already
 * read, the session is deleted, and only then is the lookup released.
 */
async function resumeVersusDelete(d: string) {
  const credentials = heldCredentials();
  const s = setupRegistry(d, OPTIONS, { ensureCredentials: credentials.ensureCredentials });
  const { sessionId } = await s.registry.create(s.input());
  await s.registry.close(sessionId);
  const resume = s.registry.resume(sessionId, s.input());
  await credentials.entered.promise; // readMeta has resolved; the resume holds no lock yet
  await s.registry.delete(sessionId);
  credentials.held.resolve();
  const outcome = await resume.then(
    (state) => ({ kind: "opened" as const, state }),
    (error: unknown) => ({ kind: "refused" as const, error }),
  );
  return { s, sessionId, outcome };
}

describe("a resume that races a delete", () => {
  test("AC-10: the refused resume reports the unknown-session code a never-created id reports", async () => {
    const { s, outcome } = await resumeVersusDelete(dir());
    try {
      expect(outcome.kind).toBe("refused");
      const never = await s.registry.resume("never-created", s.input()).catch((error: unknown) => error);
      expect(codeOf(outcome.kind === "refused" ? outcome.error : undefined)).toBe(codeOf(never));
      expect(codeOf(never)).toBe(-32002);
    } finally {
      await s.registry.closeAll();
    }
  });

  test("AC-11: the refused resume opens no session", async () => {
    const { s, outcome } = await resumeVersusDelete(dir());
    try {
      expect(outcome.kind).toBe("refused");
      expect(s.opened).toHaveLength(1); // the create, and nothing for the resume
    } finally {
      await s.registry.closeAll();
    }
  });

  test("AC-12: the refused resume released its own lock, so three releases happened", async () => {
    const { s, outcome } = await resumeVersusDelete(dir());
    try {
      expect(outcome.kind).toBe("refused");
      expect(s.releases()).toBe(3); // the close, the delete and the resume's own lock
    } finally {
      await s.registry.closeAll();
    }
  });

  test("AC-13 (control): the resume leaves no metadata behind", async () => {
    const { s, sessionId } = await resumeVersusDelete(dir());
    try {
      // Whatever the resume's outcome, the deleted session's metadata is never recreated.
      expect(await s.storage.hasMeta(sessionId)).toBe(false);
    } finally {
      await s.registry.closeAll();
    }
  });
});

describe("stored sessions that no delete raced", () => {
  test("AC-14 (control): a resume of a closed session reopens it with the stored settings", async () => {
    const s = setupRegistry(dir(), OPTIONS);
    try {
      const { sessionId } = await s.registry.create(s.input());
      await s.registry.setMode(sessionId, "full");
      await s.registry.close(sessionId);
      const state = await s.registry.resume(sessionId, s.input());
      expect(state.modes.currentModeId).toBe("full");
      expect(state.configOptions.find((option) => option.id === "model")?.currentValue).toBe(STORED_MODEL);
    } finally {
      await s.registry.closeAll();
    }
  });

  test("AC-15 (control): a delete of a closed session with no resume in flight removes it for good", async () => {
    const s = setupRegistry(dir(), OPTIONS);
    try {
      const { sessionId } = await s.registry.create(s.input());
      await s.registry.close(sessionId);
      await s.registry.delete(sessionId);
      expect(await s.storage.hasMeta(sessionId)).toBe(false);
      const code = codeOf(await s.registry.resume(sessionId, s.input()).catch((error: unknown) => error));
      expect(code).toBe(-32002);
    } finally {
      await s.registry.closeAll();
    }
  });
});

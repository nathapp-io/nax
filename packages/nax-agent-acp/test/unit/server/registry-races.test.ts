import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryTranscriptStore, type TranscriptDoc } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { OPTIONS, setupRegistry } from "#test/helpers/registry-setup";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});
function dir() {
  const d = makeTempDir("acp-registry-races-");
  dirs.push(d);
  return d;
}
const priced = (costUsd: number): Script =>
  async function* () {
    yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd };
    yield turnEnd("completed");
  };
const prompt = [{ type: "text" as const, text: "go" }];
const MODEL = "anthropic/claude-haiku-4-5";

describe("a model switch that waits on credentials keeps the turn's metadata", () => {
  /** Resolves at once for the create open (1st call) and holds the switch's lookup (2nd call). */
  function heldCredentials() {
    const held = Promise.withResolvers<void>();
    let calls = 0;
    const ensureCredentials = async (): Promise<void> => {
      calls += 1;
      if (calls === 2) await held.promise;
    };
    return { held, ensureCredentials, calls: () => calls };
  }

  test("a priced turn completed during the held lookup keeps its cost, title and timestamp", async () => {
    const credentials = heldCredentials();
    const s = setupRegistry(dir(), OPTIONS, {
      scripts: [priced(0.25)],
      ensureCredentials: credentials.ensureCredentials,
    });
    const { sessionId } = await s.registry.create(s.input());
    const before = await s.storage.readMeta(sessionId);
    expect(before?.title).toBeNull();
    expect(before?.updatedAt).toBeNull();

    const switching = s.registry.setConfigOption(sessionId, "model", MODEL);
    try {
      // The switch is parked on the second credential lookup, before it closes the session.
      expect(credentials.calls()).toBe(2);
      await s.registry.get(sessionId).prompt(prompt);
      expect((await s.storage.readMeta(sessionId))?.costUsd).toBe(0.25);
      credentials.held.resolve();
      await switching;

      const meta = await s.storage.readMeta(sessionId);
      expect(meta?.costUsd).toBe(0.25);
      expect(meta?.title).toBe("go");
      expect(meta?.updatedAt).not.toBeNull();
      expect(meta?.model).toBe(MODEL);
    } finally {
      credentials.held.resolve();
      await switching.catch(() => undefined);
      await s.registry.closeAll();
    }
  });

  test("(control) a priced turn finished before the switch keeps its model, cost and title", async () => {
    const s = setupRegistry(dir(), OPTIONS, { scripts: [priced(0.25)] });
    const { sessionId } = await s.registry.create(s.input());
    await s.registry.get(sessionId).prompt(prompt);
    await s.registry.setConfigOption(sessionId, "model", MODEL);
    const meta = await s.storage.readMeta(sessionId);
    expect(meta?.model).toBe(MODEL);
    expect(meta?.costUsd).toBe(0.25);
    expect(meta?.title).toBe("go");
    await s.registry.closeAll();
  });
});

/** Waits (bounded) until `predicate` holds, so a test never races the scheduler for a real interleaving. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A session created and shut down on a first registry, so a second registry over the same dir reopens it. */
async function storedThenClosed(d: string, transcripts = createMemoryTranscriptStore()) {
  const first = setupRegistry(d, OPTIONS, { transcripts });
  const { sessionId } = await first.registry.create(first.input());
  await first.registry.setMode(sessionId, "full");
  await first.registry.closeAll();
  return { sessionId, transcripts };
}

const STORED_MODEL = "anthropic/claude-sonnet-5-5";

/** The model option's current value, the way a client reads it (§5.2). */
const currentModel = (state: { configOptions: readonly { id: string; currentValue?: unknown }[] }): unknown =>
  state.configOptions.find((option) => option.id === "model")?.currentValue;

/**
 * A second registry whose openSession is held, with two resumes started before it
 * is released: the overlap both resume tests assert on.
 */
async function overlappingResumes(d: string, sessionId: string) {
  const gate = Promise.withResolvers<void>();
  const second = setupRegistry(d, OPTIONS, { openGate: gate.promise });
  const a = second.registry.resume(sessionId, second.input());
  const b = second.registry.resume(sessionId, second.input());
  await until(() => second.opened.length >= 1, "the first resume to open");
  gate.resolve();
  try {
    return { second, states: await Promise.all([a, b]) };
  } finally {
    gate.resolve(); // never leave the gate held if the pair rejects
  }
}

describe("overlapping reopens of one session", () => {
  test("two overlapping resumes open the session once, keeping the stored mode and model", async () => {
    const d = dir();
    const { sessionId } = await storedThenClosed(d);
    const { second, states } = await overlappingResumes(d, sessionId);
    expect(second.opened).toHaveLength(1);
    for (const state of states) {
      expect(state.modes.currentModeId).toBe("full");
      expect(currentModel(state)).toBe(STORED_MODEL);
    }
    await second.registry.closeAll();
  });

  test("overlapping resumes leave nothing open or locked after closeAll", async () => {
    const d = dir();
    const { sessionId } = await storedThenClosed(d);
    const { second } = await overlappingResumes(d, sessionId);
    await second.registry.closeAll();
    expect(second.fakes.every((fake) => fake.closed())).toBe(true);
    expect(second.fakes).toHaveLength(1);
    expect(second.releases()).toBe(second.fakes.length);
  });

  test("when the first open fails, the waiting resume opens the session itself", async () => {
    const d = dir();
    const { sessionId } = await storedThenClosed(d);
    const second = setupRegistry(d, OPTIONS, { failOpens: [1] });
    const first = second.registry.resume(sessionId, second.input());
    const waiting = second.registry.resume(sessionId, second.input());
    const failure = await first.catch((error: unknown) => error);
    // Only the caller whose open failed sees the rejection.
    expect(failure).toMatchObject({ message: "open 1 failed" });
    const state = await waiting;
    expect(second.opened).toHaveLength(2);
    expect(state.modes.currentModeId).toBe("full");
    expect(currentModel(state)).toBe(STORED_MODEL);
    await second.registry.closeAll();
  });

  test("two overlapping loads open once and each replays the transcript", async () => {
    const d = dir();
    const doc: TranscriptDoc = { savedAt: "x", messages: [{ role: "user", content: "hello" }] };
    const { sessionId, transcripts } = await storedThenClosed(d);
    await transcripts.save(sessionId, doc);
    const gate = Promise.withResolvers<void>();
    const second = setupRegistry(d, OPTIONS, { transcripts, openGate: gate.promise });
    const a = second.registry.load(sessionId, second.input());
    const b = second.registry.load(sessionId, second.input());
    try {
      await until(() => second.opened.length >= 1, "the first load to open");
      gate.resolve();
      await Promise.all([a, b]);
      expect(second.opened).toHaveLength(1);
      expect(second.port.updates.filter((u) => u.sessionUpdate === "user_message_chunk")).toHaveLength(2);
      await second.registry.closeAll();
    } finally {
      gate.resolve();
    }
  });

  test("(control) a resume after an overlapping pair settled finds the open entry", async () => {
    const d = dir();
    const { sessionId } = await storedThenClosed(d);
    const pair = await overlappingResumes(d, sessionId);
    const state = await pair.second.registry.resume(sessionId, pair.second.input());
    expect(pair.second.opened).toHaveLength(1);
    expect(state.modes.currentModeId).toBe("full");
    await pair.second.registry.closeAll();
  });
});

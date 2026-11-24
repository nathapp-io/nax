/**
 * US-003 (review e684 finding 6): the ACP record carries whether the session's
 * instructions actually reached the agent. A first turn rejected locally (an
 * unsupported image, thrown before any prompt is sent) still writes its turn
 * marker, so the marker alone cannot tell a resume whether the instructions are
 * already in the agent's context. Facade level, over `acpBackend` and the
 * in-process fake agent that advertises session/resume.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentLogger,
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  createMemoryTranscriptStore,
  type ImageAttachment,
  resumeAgentSession,
  type SessionEvent,
  setAgentLogger,
  type TranscriptDoc,
  type TranscriptStore,
  type TurnMarker,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { FakeScript } from "#test/fixtures/fake-agent/script";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { endOf } from "#test/helpers/session-events";

const RULES = "RULES";
const SESSION = "s-1";
const AGENT_SESSION = "fake-session-1";
const img: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 10, height: 20, source: "clipboard" };

/** The delivery fixture's agent: resumable, and its prompt capabilities exclude images. */
const RESUMABLE: FakeScript = { capabilities: { sessionCapabilities: { resume: {} } } };

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-delivery-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  setAgentLogger(null);
  cleanupTempDir(workdir);
});

interface Harness {
  readonly fake: InMemoryAgent;
  readonly store: TranscriptStore;
}

function harness(script: FakeScript = {}, store: TranscriptStore = createMemoryTranscriptStore()): Harness {
  const fake = inMemoryAgent({ ...RESUMABLE, ...script });
  _acpBackendDeps.launch = fake.launch;
  return { fake, store };
}

function optionsFor(h: Harness, extra: Partial<CreateAgentSessionOptions> = {}): CreateAgentSessionOptions {
  return {
    backend: acpBackend({ agent: { name: "fake", command: "fake" }, allowUnsandboxed: true }),
    profile: "full",
    workdir,
    transcriptStore: h.store,
    sessionId: SESSION,
    ...extra,
  };
}

/** Opens the delivery fixture; `instructions` absent means the option is not passed at all. */
async function open(h: Harness, instructions?: string): Promise<AgentSession> {
  const session = await createAgentSession(optionsFor(h, instructions === undefined ? {} : { instructions }));
  sessions.push(session);
  return session;
}

async function resume(h: Harness, instructions: string = RULES): Promise<AgentSession> {
  const session = await resumeAgentSession(SESSION, optionsFor(h, { instructions }));
  sessions.push(session);
  return session;
}

async function send(session: AgentSession, message: string, images?: readonly ImageAttachment[]) {
  const events: SessionEvent[] = [];
  for await (const event of session.send(message, images === undefined ? undefined : { images })) events.push(event);
  return endOf(events);
}

/** The last text block of every prompt the fake agent received, in order. */
const promptTexts = (fake: InMemoryAgent) =>
  fake.callsTo("session/prompt").map((params) => {
    const prompt: readonly { readonly text?: string }[] = JSON.parse(JSON.stringify(params)).prompt;
    return prompt.at(-1)?.text;
  });

/** The delivery state the stored document records (`undefined` when the field is absent). */
async function storedDelivery(h: Harness): Promise<boolean | undefined> {
  return (await h.store.load(SESSION))?.acp?.instructionsDelivered;
}

/** A valid ACP identity record for the delivery fixture's agent, plus `extra`. */
function identityAcp(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { agentSessionId: AGENT_SESSION, agent: "fake", cwd: workdir, ...extra };
}

/**
 * A stored document carrying an ACP record the type would reject. The JSON
 * round-trip is the suite's way to build a deliberately-illegal value without a
 * cast (`resume.test.ts`'s `docWith`), so a non-boolean delivery record is
 * representable here.
 */
function storedDoc(acp: Record<string, unknown>, turn?: TurnMarker): TranscriptDoc {
  return JSON.parse(
    JSON.stringify({ backend: "acp:fake", acp, turn, messages: [], savedAt: "2026-01-01T00:00:00.000Z" }),
  );
}

/** A store whose save throws once, for the one write that carries instructionsDelivered: true. */
function failingDeliveryOnce(inner: TranscriptStore): TranscriptStore {
  let failed = false;
  return {
    ...inner,
    save: async (sessionId, doc) => {
      if (!failed && doc.acp?.instructionsDelivered === true) {
        failed = true;
        throw new Error("disk full");
      }
      await inner.save(sessionId, doc);
    },
  };
}

interface Warning {
  readonly stage: string;
  readonly message: string;
}

function recordingLogger(warnings: Warning[]): AgentLogger {
  const ignore = () => {};
  return {
    error: ignore,
    info: ignore,
    debug: ignore,
    warn: (stage, message) => {
      warnings.push({ stage, message });
    },
  };
}

describe("ACP instruction delivery is recorded in the session document (US-003)", () => {
  test("AC-1: a session opened with instructions records instructionsDelivered false", async () => {
    const h = harness();
    await open(h, RULES);
    expect(await storedDelivery(h)).toBe(false);
  });

  test("AC-2: a first turn rejected locally leaves instructionsDelivered false", async () => {
    const h = harness();
    const session = await open(h, RULES);
    const end = await send(session, "look", [img]);
    expect(end).toMatchObject({ status: "errored", error: { code: "ACP_IMAGE_INPUT_UNSUPPORTED" } });
    expect(await storedDelivery(h)).toBe(false);
  });

  test("AC-3: after a locally rejected first turn, a resume sends the instructions with the next prompt", async () => {
    const h = harness();
    const first = await open(h, RULES);
    await send(first, "look", [img]);
    await first.close();
    const second = await resume(h);
    expect((await send(second, "next")).status).toBe("completed");
    expect(promptTexts(h.fake)).toEqual(["RULES\n\nnext"]);
  });

  test("AC-4: a first text turn the agent answers records instructionsDelivered true", async () => {
    const h = harness({ turns: [{ steps: [{ kind: "text", text: "hello" }] }] });
    const session = await open(h, RULES);
    expect((await send(session, "look")).status).toBe("completed");
    expect(await storedDelivery(h)).toBe(true);
  });

  test("AC-5: after a delivered first turn, a resume does not repeat the instructions", async () => {
    const h = harness({ turns: [{ steps: [{ kind: "text", text: "hello" }] }] });
    const first = await open(h, RULES);
    await send(first, "look");
    await first.close();
    const second = await resume(h);
    await send(second, "next");
    expect(promptTexts(h.fake)).toEqual(["RULES\n\nlook", "next"]);
  });
});

describe("a resume reads the recorded delivery, falling back to the turn marker (US-003)", () => {
  test("AC-6: a document with no delivery field and a turn marker is assumed delivered", async () => {
    const h = harness();
    await h.store.save(SESSION, storedDoc(identityAcp(), { turnId: "t-1", state: "ended" }));
    const session = await resume(h);
    await send(session, "next");
    expect(promptTexts(h.fake)).toEqual(["next"]);
  });

  test("AC-7: a document with no delivery field and no turn marker sends the instructions", async () => {
    const h = harness();
    await h.store.save(SESSION, storedDoc(identityAcp()));
    const session = await resume(h);
    await send(session, "next");
    expect(promptTexts(h.fake)).toEqual(["RULES\n\nnext"]);
  });

  test("AC-8: a recorded false wins over a turn marker", async () => {
    const h = harness();
    await h.store.save(
      SESSION,
      storedDoc(identityAcp({ instructionsDelivered: false }), {
        turnId: "t-1",
        state: "ended",
      }),
    );
    const session = await resume(h);
    await send(session, "next");
    expect(promptTexts(h.fake)).toEqual(["RULES\n\nnext"]);
  });

  test("AC-13: a non-boolean delivery record with a turn marker falls back to the turn marker", async () => {
    const h = harness();
    await h.store.save(
      SESSION,
      storedDoc(identityAcp({ instructionsDelivered: "yes" }), {
        turnId: "t-1",
        state: "ended",
      }),
    );
    const session = await resume(h);
    await send(session, "next");
    expect(promptTexts(h.fake)).toEqual(["next"]);
  });

  test("AC-14: a non-boolean delivery record with no turn marker sends the instructions", async () => {
    const h = harness();
    await h.store.save(SESSION, storedDoc(identityAcp({ instructionsDelivered: 1 })));
    const session = await resume(h);
    await send(session, "next");
    expect(promptTexts(h.fake)).toEqual(["RULES\n\nnext"]);
  });
});

describe("a failed delivery write is logged and retried by the next turn (US-003)", () => {
  test("AC-9: the first completed turn warns and leaves instructionsDelivered false", async () => {
    const warnings: Warning[] = [];
    setAgentLogger(recordingLogger(warnings));
    const h = harness(
      { turns: [{ steps: [{ kind: "text", text: "hello" }] }] },
      failingDeliveryOnce(createMemoryTranscriptStore()),
    );
    const session = await open(h, RULES);
    expect((await send(session, "look")).status).toBe("completed");
    expect(warnings).toContainEqual({ stage: "acp", message: "Could not save the ACP instruction delivery" });
    expect(await storedDelivery(h)).toBe(false);
  });

  test("AC-10: the next completed turn records the delivery", async () => {
    const h = harness(
      { turns: [{ steps: [{ kind: "text", text: "hello" }] }] },
      failingDeliveryOnce(createMemoryTranscriptStore()),
    );
    const session = await open(h, RULES);
    await send(session, "look");
    expect(await storedDelivery(h)).toBe(false);
    expect((await send(session, "again")).status).toBe("completed");
    expect(await storedDelivery(h)).toBe(true);
  });
});

describe("a session with no instructions records no delivery field (US-003)", () => {
  test("AC-11: opened with no instructions", async () => {
    const h = harness();
    await open(h);
    const doc = await h.store.load(SESSION);
    expect(doc?.acp).toBeDefined();
    expect(doc?.acp).not.toHaveProperty("instructionsDelivered");
  });

  test("AC-12: opened with empty instructions, after a completed text turn", async () => {
    const h = harness({ turns: [{ steps: [{ kind: "text", text: "hello" }] }] });
    const session = await open(h, "");
    expect((await send(session, "look")).status).toBe("completed");
    const doc = await h.store.load(SESSION);
    expect(doc?.acp).toBeDefined();
    expect(doc?.acp).not.toHaveProperty("instructionsDelivered");
  });
});

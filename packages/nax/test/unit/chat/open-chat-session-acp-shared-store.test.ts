/**
 * US-002 (review e684, finding 2): a failed ACP resume must leave every other chat on the
 * agent's shared transcript directory resumable.
 *
 * `openAcpBrain` builds ONE file store over `<sessions>/acp-<agent>` — a directory every chat
 * on that agent shares — and calls `retainFailed` when a resume fails with an unusable-session
 * error. `retainFailed` used to prune that directory down to `MAX_RETAINED_TRANSCRIPTS` counting
 * live documents and kept-on-failure archives TOGETHER, so one chat's failed resume deleted the
 * oldest live document in it: that chat's next open found `null` and silently created a fresh
 * agent session (its earlier conversation gone from the agent's own record).
 *
 * Every test here drives the production entry point (`openChatSession`) with the REAL
 * `createFileTranscriptStore` over real files, and mocks only the agent-session calls, keyed on
 * the session id. A store that still prunes live names fails the ACs below; the baseline test at
 * the end shows that same fixture being evicted by the pre-US-001 policy, so none of them is
 * vacuous.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, rename, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSession,
  AgentSessionError,
  type AgentSessionErrorCode,
  type CreateAgentSessionOptions,
  createFileTranscriptStore,
  createSessionStorage,
  MAX_RETAINED_TRANSCRIPTS,
  pruneRetainedTranscripts,
  type SessionBackend,
  type SessionStorage,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _acpSessionDeps, ACP_FRESH_SESSION_NOTICE, acpTranscriptDir } from "@/chat/acp/acp-session-options";
import {
  _openChatSessionDeps,
  type ChatSessionHandle,
  type OpenChatSessionRequest,
  openChatSession,
} from "@/chat/open-chat-session";
import { NaxError } from "@/errors";

/** The chat whose agent document is older, with an image sidecar, and must survive. */
const X = "chat-x-older";
/** The chat whose resume fails, taking the fresh-session fallback. */
const Y = "chat-y-failing";
const AGENT = "codex";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const DAY_MS = 86_400_000;
const BASE_MTIME_MS = new Date(2026, 0, 1).getTime();
/** 51 live documents in the shared directory: one more than the retention cap. */
const LIVE_DOCUMENTS = MAX_RETAINED_TRANSCRIPTS + 1;
const FILLER_COUNT = LIVE_DOCUMENTS - 2;
/** A stored agent document only resumes once its agent ran a turn. */
const ENDED_TURN: NonNullable<TranscriptDoc["turn"]> = { turnId: "t1", state: "ended" };
/** X's user prompt carries an image, so the store writes a `.transcript.images` sidecar for it. */
const X_MESSAGES: TranscriptDoc["messages"] = [
  { role: "user", content: "the screenshot", images: [{ mimeType: "image/png", data: "AAAA" }] },
];
const acpBackendStub: SessionBackend = {
  kind: "acp:test",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};

type CreateFn = (options: CreateAgentSessionOptions) => Promise<AgentSession>;
type ResumeFn = (id: string, options: CreateAgentSessionOptions) => Promise<AgentSession>;

let dir: string;
let storage: SessionStorage;
let request: OpenChatSessionRequest;
let deps: typeof _openChatSessionDeps;
let createMock: ReturnType<typeof mock<CreateFn>>;
let resumeMock: ReturnType<typeof mock<ResumeFn>>;
const originalAcpDeps = { ..._acpSessionDeps };
const releases: (() => Promise<void>)[] = [];

function fakeSession(id: string): AgentSession {
  return {
    id,
    backend: { kind: "acp:test", capabilities: {} },
    lastTurn: undefined,
    async *send() {
      // No turn is driven here; these tests assert which session was opened, not what it ran.
    },
    answer: () => "unknown",
    cancel() {},
    async close() {},
  };
}

function agentError(code: AgentSessionErrorCode): AgentSessionError {
  return new AgentSessionError(`injected ${code}`, code, {});
}

/** The directory every chat on the codex agent shares, as `openAcpBrain` computes it. */
function sharedDir(): string {
  return acpTranscriptDir(storage.dir, AGENT);
}

function docPath(at: string, id: string): string {
  return join(at, `${id}.transcript.json`);
}

function sidecarPath(at: string, id: string): string {
  return join(at, `${id}.transcript.images`);
}

function fillerName(n: number): string {
  return `chat-filler-${String(n).padStart(2, "0")}`;
}

async function setMtime(path: string, ms: number): Promise<void> {
  const at = new Date(ms);
  await utimes(path, at, at);
}

/** Live documents only: `X.transcript.images` is a folder, not a document. */
async function liveDocuments(): Promise<string[]> {
  const entries = await readdir(sharedDir());
  return entries.filter((entry) => entry.endsWith(".transcript.json")).sort();
}

/** The image files under `id`'s sidecar; `[]` when the sidecar itself is gone. */
async function sidecarEntries(id: string): Promise<string[]> {
  const at = sidecarPath(sharedDir(), id);
  return existsSync(at) ? (await readdir(at)).sort() : [];
}

/**
 * 51 live ended-turn documents in the shared directory, X and Y among them. mtimes put X's
 * document first, so a prune that counts live names drops X before anything else.
 */
async function seedSharedStore(): Promise<void> {
  const store = createFileTranscriptStore(sharedDir());
  const savedAt = NOW.toISOString();
  await store.save(X, { savedAt, messages: X_MESSAGES, turn: ENDED_TURN });
  await store.save(Y, { savedAt, messages: [], turn: ENDED_TURN });
  for (let n = 1; n <= FILLER_COUNT; n += 1) {
    await store.save(fillerName(n), { savedAt, messages: [], turn: ENDED_TURN });
  }
  await setMtime(docPath(sharedDir(), X), BASE_MTIME_MS);
  await setMtime(docPath(sharedDir(), Y), BASE_MTIME_MS + DAY_MS);
  for (let n = 1; n <= FILLER_COUNT; n += 1) {
    await setMtime(docPath(sharedDir(), fillerName(n)), BASE_MTIME_MS + (n + 1) * DAY_MS);
  }
}

/** Both chats own a metadata record naming the ACP codex model. */
async function seedMeta(id: string): Promise<void> {
  await storage.writeMeta({
    schemaVersion: 1,
    sessionId: id,
    cwd: request.cwd,
    mode: "ask",
    model: `acp:${AGENT}`,
    bashApproval: "raw",
    title: null,
    createdAt: NOW.toISOString(),
    updatedAt: null,
  });
}

function makeDeps(overrides: Partial<typeof _openChatSessionDeps> = {}): typeof _openChatSessionDeps {
  return {
    ..._openChatSessionDeps,
    randomUUID: () => "not-used-by-a-resumed-chat",
    now: () => NOW,
    nativeBackend: mock(() => {
      throw new NaxError("native backend must not open for an ACP chat", "TEST_FAILURE", { stage: "test" });
    }),
    createAgentSession: createMock,
    resumeAgentSession: resumeMock,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = makeTempDir("chat-open-acp-shared-store-");
  storage = createSessionStorage({ dir, pid: process.pid, now: () => NOW, logger: makeLogger() });
  request = {
    storage,
    cwd: join(dir, "work"),
    repoRoot: dir,
    mode: "guarded",
    loopHandlers: [],
    config: makeNaxConfig(),
  };
  // `sessionId` is optional on the options type; `openChatSession` always sets it (see AC-4).
  createMock = mock<CreateFn>(async (options) => fakeSession(options.sessionId ?? "missing-session-id"));
  // Keyed on the session id: Y's stored agent session is unusable, X's resumes.
  resumeMock = mock<ResumeFn>(async (id) => {
    if (id === Y) throw agentError("AGENT_SESSION_NOT_FOUND");
    return fakeSession(id);
  });
  // `createFileTranscriptStore` stays the real one: these ACs are about real files.
  deps = makeDeps();
  _acpSessionDeps.acpBackend = mock(() => acpBackendStub);
  await seedMeta(X);
  await seedMeta(Y);
  await seedSharedStore();
});

afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()));
  Object.assign(_acpSessionDeps, originalAcpDeps);
  mock.restore();
  cleanupTempDir(dir);
});

async function open(
  overrides: Partial<OpenChatSessionRequest> = {},
  useDeps: typeof _openChatSessionDeps = deps,
): Promise<ChatSessionHandle> {
  const handle = await openChatSession({ ...request, ...overrides }, useDeps);
  releases.push(handle.release);
  return handle;
}

/** Chat Y's open: its resume fails with an unusable-session error. */
async function openY(useDeps: typeof _openChatSessionDeps = deps): Promise<ChatSessionHandle> {
  return open({ resumeId: Y }, useDeps);
}

describe("openChatSession on ACP over the shared agent store: a failed resume", () => {
  test("AC-1: another chat's live document is still loadable, turn marker and all", async () => {
    // The real store, not a fake: these ACs are about what the files hold afterwards.
    expect(deps.createFileTranscriptStore).toBe(createFileTranscriptStore);
    expect(await liveDocuments()).toHaveLength(LIVE_DOCUMENTS);

    await openY();

    const document = await createFileTranscriptStore(sharedDir()).load(X);
    expect(document).not.toBeNull();
    expect(document?.turn).toEqual(ENDED_TURN);
  });

  test("AC-2: another chat's image sidecar and the image in it still exist", async () => {
    const before = await sidecarEntries(X);
    expect(before).toHaveLength(1);

    await openY();

    expect(await sidecarEntries(X)).toEqual(before);
  });

  test("AC-3: a later open of that chat resumes it instead of creating a second session", async () => {
    await openY();
    const createsAfterY = createMock.mock.calls.length;
    expect(createsAfterY).toBe(1);

    await open({ resumeId: X });

    expect(resumeMock.mock.calls.map(([id]) => id)).toContain(X);
    expect(createMock.mock.calls.length).toBe(createsAfterY);
  });

  test("AC-4: the failing chat's own open created exactly one fresh agent session", async () => {
    await openY();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0].sessionId).toBe(Y);
  });

  test("AC-5: the failing chat's handle carries the Codex fresh-session notice", async () => {
    const handle = await openY();

    expect(handle.notice).toBe(ACP_FRESH_SESSION_NOTICE("Codex"));
  });
});

/**
 * The baseline the ACs guard. The pre-US-001 `retainFailed` renamed the failed document and then
 * pruned the shared directory counting live names and archives together, so this same fixture lost
 * X's document (and, with it, X's sidecar) on Y's failure. Reproduced here through the same
 * exported primitive the store used, since that policy is what the ACs exist to keep out.
 */
describe("openChatSession on ACP over the shared agent store: the pre-fix retention policy", () => {
  function legacyStore(at: string): TranscriptStore {
    const real = createFileTranscriptStore(at);
    return {
      ...real,
      retainFailed: async (sessionId: string) => {
        await rename(docPath(at, sessionId), join(at, `${sessionId}.transcript.failed-legacy.json`));
        await pruneRetainedTranscripts(at, MAX_RETAINED_TRANSCRIPTS);
      },
    };
  }

  test("baseline: pruning live names evicts the older chat's document and sidecar", async () => {
    expect(await sidecarEntries(X)).toHaveLength(1);

    await openY(makeDeps({ createFileTranscriptStore: (at: string) => legacyStore(at) }));

    expect(await createFileTranscriptStore(sharedDir()).load(X)).toBeNull();
    expect(await sidecarEntries(X)).toEqual([]);
    // Y's own fallback is unchanged: the only difference the fix makes is X's survival.
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

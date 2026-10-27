import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentSession,
  createSessionStorage,
  defaultSessionsDir,
  type SessionBackend,
  type SessionMeta,
  type SessionStorage,
  type TranscriptDoc,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import {
  _openChatSessionDeps,
  createChatStorage,
  type OpenChatSessionRequest,
  openChatSession,
  resolveChatSessionsDir,
} from "@/chat/open-chat-session";
import { globalConfigDir, type TuiPermissions } from "@/config";
import { NaxError } from "@/errors";

const ID = "injected-session-id";
const NOW = new Date("2026-10-01T00:00:00.000Z");
const backend: SessionBackend = {
  kind: "native",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};
const session: AgentSession = {
  id: ID,
  backend: { kind: "native", capabilities: {} },
  lastTurn: undefined,
  async *send() {},
  answer: () => "unknown",
  cancel() {},
  async close() {},
};
let dir: string;
let storage: SessionStorage;
let request: OpenChatSessionRequest;
let deps: typeof _openChatSessionDeps;
let doc: TranscriptDoc | null;
const releases: (() => Promise<void>)[] = [];

beforeEach(() => {
  dir = makeTempDir("chat-open-");
  storage = createSessionStorage({ dir, pid: process.pid, now: () => NOW, logger: makeLogger() });
  request = {
    storage,
    cwd: join(dir, "work"),
    repoRoot: dir,
    model: "anthropic/new",
    loopHandlers: [],
    config: makeNaxConfig(),
  };
  doc = null;
  deps = {
    ..._openChatSessionDeps,
    randomUUID: () => ID,
    now: () => NOW,
    nativeBackend: mock(() => backend),
    createAgentSession: mock(async () => session),
    resumeAgentSession: mock(async () => session),
    createFileTranscriptStore: mock(() => ({
      load: mock(async () => doc),
      save: async () => {},
      retainFailed: async () => {},
      delete: async () => {},
      markTurn: async () => {},
    })),
    resolveRuleSet: mock(_openChatSessionDeps.resolveRuleSet),
  };
});
afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()));
  mock.restore();
  cleanupTempDir(dir);
});

async function open(overrides: Partial<OpenChatSessionRequest> = {}) {
  const handle = await openChatSession({ ...request, ...overrides }, deps);
  releases.push(handle.release);
  return handle;
}
async function seed(overrides: Partial<SessionMeta> = {}) {
  await storage.writeMeta({
    schemaVersion: 1,
    sessionId: ID,
    cwd: request.cwd,
    mode: "full",
    model: "anthropic/stored",
    bashApproval: "raw",
    title: "Existing",
    createdAt: NOW.toISOString(),
    updatedAt: null,
    ...overrides,
  });
}

describe("openChatSession", () => {
  test.each([
    ["AC-1", "bashApproval", "raw"],
    ["AC-2", "allowUnsandboxed", true],
    ["AC-3", "allowUnsandboxedCommands", true],
    ["AC-4", "loopHandlerRole", "tui"],
  ])("%s guarded backend %s", async (_ac, key, value) => {
    await open({ mode: "guarded" });
    expect(deps.nativeBackend).toHaveBeenCalledWith(expect.objectContaining({ [key]: value }));
  });
  test("AC-5 forwards nonempty catalogOverrides", async () => {
    const catalogOverrides = [{ provider: "anthropic", models: [] }];
    await open({ config: makeNaxConfig({ agent: { native: { catalogOverrides } } }) });
    expect(deps.nativeBackend).toHaveBeenCalledWith(expect.objectContaining({ catalogOverrides }));
  });
  test("AC-6 forwards disabled compaction", async () => {
    await open({ config: makeNaxConfig({ execution: { compaction: { enabled: false } } }) });
    expect(deps.nativeBackend).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ enabled: false }) }),
    );
  });
  test.each(["AC-7", "AC-8", "AC-9"])("%s full session options", async () => {
    await open({ mode: "full", config: makeNaxConfig({ execution: { approvalTimeout: 42_000 } }) });
    expect(deps.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "full", workdir: request.cwd, approvalTimeoutMs: 42_000 }),
    );
  });
  test("AC-10 includes repository rule index and forwards rule overrides", async () => {
    await Bun.write(
      join(dir, ".nax/rules/error-handling.md"),
      "---\nappliesTo: ['**/*.ts']\n---\n# Error handling\nUse causes.\n",
    );
    await open();
    expect(deps.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ instructions: expect.stringContaining("error-handling") }),
    );
    expect(deps.resolveRuleSet).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: dir, packageDir: dir }));
  });
  test("AC-11 persists injected id, ISO timestamp and ask metadata", async () => {
    const handle = await open();
    expect(await storage.readMeta(ID)).toEqual(handle.meta);
    expect(handle.meta).toMatchObject({
      sessionId: ID,
      mode: "ask",
      bashApproval: "raw",
      createdAt: NOW.toISOString(),
      updatedAt: null,
      title: null,
    });
  });
  test("AC-12 holds own lock until release", async () => {
    const handle = await open();
    expect(await storage.readLockHolder(ID)).toMatchObject({ state: "own" });
    await handle.release();
    expect(await storage.readLockHolder(ID)).toBeNull();
  });
  test("AC-13 resumes a transcript without creating", async () => {
    await seed();
    doc = { savedAt: NOW.toISOString(), messages: [] };
    await open({ resumeId: ID });
    expect(deps.resumeAgentSession).toHaveBeenCalledWith(ID, expect.objectContaining({ sessionId: ID }));
    expect(deps.createAgentSession).not.toHaveBeenCalled();
    expect(deps.createFileTranscriptStore).toHaveBeenCalledWith(storage.dir);
  });
  test("AC-14 creates an unprompted resumed session", async () => {
    await seed();
    await open({ resumeId: ID });
    expect(deps.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: ID }));
    expect(deps.resumeAgentSession).not.toHaveBeenCalled();
  });
  test("AC-15 plain resume preserves stored model and mode", async () => {
    await seed();
    const handle = await open({ resumeId: ID, model: undefined });
    expect(handle.meta).toMatchObject({ model: "anthropic/stored", mode: "full" });
    expect(deps.nativeBackend).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/stored", bashApproval: "raw" }),
    );
    expect(deps.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ profile: "full" }));
  });
  test.each(["AC-16", "AC-22"])("%s missing metadata refuses before locking", async () => {
    const acquire = spyOn(storage, "acquireLock");
    const error = open({ resumeId: ID });
    await expect(error).rejects.toBeInstanceOf(NaxError);
    await expect(error).rejects.toMatchObject({
      code: "CHAT_SESSION_NOT_FOUND",
      message: `no session ${ID} in ${dir}`,
    });
    expect(acquire).not.toHaveBeenCalled();
  });
  test.each(["read", "none"] as const)(
    "AC-17/23 unsupported %s refuses before locking even with override",
    async (mode) => {
      await seed({ mode });
      const acquire = spyOn(storage, "acquireLock");
      await expect(open({ resumeId: ID, mode: "full" })).rejects.toMatchObject({
        code: "CHAT_SESSION_MODE_UNSUPPORTED",
        message: `session ${ID} was created in mode ${mode}; nax chat opens full or ask sessions only`,
      });
      expect(acquire).not.toHaveBeenCalled();
    },
  );
  test.each(["AC-18", "AC-24"])("%s corrupt metadata propagates before locking", async () => {
    await Bun.write(join(dir, `${ID}.session.json`), "not json");
    const acquire = spyOn(storage, "acquireLock");
    await expect(open({ resumeId: ID })).rejects.toMatchObject({ code: "SESSION_META_UNREADABLE" });
    expect(acquire).not.toHaveBeenCalled();
  });
  test("AC-19 creation failure releases lock and preserves error identity", async () => {
    const error = new NaxError("creation failed", "TEST_FAILURE", { stage: "test" });
    deps.createAgentSession = mock(async () => {
      throw error;
    });
    await expect(open()).rejects.toBe(error);
    expect(await storage.readLockHolder(ID)).toBeNull();
  });
});

describe("openChatSession resolved posture", () => {
  test("AC-7/8/9/10 resolves once and shares the guarded posture", async () => {
    const posture = { bashApproval: "gated", askRules: ["Write"], denyRules: [] } as const;
    deps.resolveTuiPermissions = mock(() => posture);
    const backendSpy = spyOn(deps, "nativeBackend");
    const handle = await open({ mode: "guarded" });
    expect(deps.resolveTuiPermissions).toHaveBeenCalledTimes(1);
    expect(deps.resolveTuiPermissions).toHaveBeenCalledWith(request.config);
    expect(deps.nativeBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        bashApproval: "gated",
        sandbox: request.config.execution.sandbox,
        askRules: posture.askRules,
        denyRules: posture.denyRules,
        askOnUnsandboxed: true,
        askWhenSandboxDown: true,
        askDiscoveredTools: true,
      }),
    );
    const options = backendSpy.mock.calls[0]?.[0];
    expect(options?.askRules).toBe(posture.askRules);
    expect(options?.denyRules).toBe(posture.denyRules);
    expect(handle.meta.bashApproval).toBe("gated");
    expect(deps.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ profile: "full" }));
  });
  test("AC-11/12 full never resolves or forwards guarded-only keys", async () => {
    deps.resolveTuiPermissions = mock(_openChatSessionDeps.resolveTuiPermissions);
    const backendSpy = spyOn(deps, "nativeBackend");
    await open({ mode: "full" });
    expect(deps.resolveTuiPermissions).not.toHaveBeenCalled();
    const options = backendSpy.mock.calls[0]?.[0];
    expect(options).toMatchObject({ bashApproval: "raw", sandbox: request.config.execution.sandbox });
    for (const key of ["askRules", "denyRules", "askOnUnsandboxed", "askWhenSandboxDown", "askDiscoveredTools"]) {
      expect(options).not.toHaveProperty(key);
    }
  });
  test.each(["guarded", "full"] as const)("AC-13 %s uses execution sandbox", async (mode) => {
    const config = makeNaxConfig({ execution: { sandbox: { enabled: false } } });
    await open({ mode, config });
    expect(deps.nativeBackend).toHaveBeenCalledWith(expect.objectContaining({ sandbox: config.execution.sandbox }));
  });
  test("AC-14 guarded raw metadata remains ask", async () => {
    await open({ config: makeNaxConfig({ execution: { bashApproval: "raw" } }) });
    expect(await storage.readMeta(ID)).toMatchObject({ mode: "ask", bashApproval: "raw" });
  });
  test("AC-15 resume recomputes current policy without writing stored policy", async () => {
    await seed({ mode: "ask", bashApproval: "gated" });
    doc = { savedAt: NOW.toISOString(), messages: [] };
    deps.resolveTuiPermissions = mock((): TuiPermissions => ({ bashApproval: "raw", askRules: [], denyRules: [] }));
    const handle = await open({ resumeId: ID, model: undefined });
    expect(handle.meta).toMatchObject({ mode: "ask", bashApproval: "raw" });
    expect(deps.resumeAgentSession).toHaveBeenCalledWith(ID, expect.objectContaining({ profile: "full" }));
    expect(deps.nativeBackend).toHaveBeenCalledWith(expect.objectContaining({ bashApproval: "raw" }));
    expect(deps.resolveTuiPermissions).toHaveBeenCalledTimes(1);
    expect(deps.resolveTuiPermissions).toHaveBeenCalledWith(request.config);
    expect(await storage.readMeta(ID)).toMatchObject({ bashApproval: "gated" });
  });
  test("explicit full switch from stored ask skips posture resolution", async () => {
    await seed({ mode: "ask", bashApproval: "gated" });
    deps.resolveTuiPermissions = mock(_openChatSessionDeps.resolveTuiPermissions);
    await open({ resumeId: ID, mode: "full" });
    expect(deps.resolveTuiPermissions).not.toHaveBeenCalled();
  });
});

describe("openChatSession edge cases", () => {
  test.each(["../outside", "nested/session", "nested\\session", "/absolute", "", ".", "..", "a".repeat(129)])(
    "F1 rejects invalid resume id %j before storage access",
    async (resumeId) => {
      const read = spyOn(storage, "readMeta");
      const acquire = spyOn(storage, "acquireLock");
      await expect(open({ resumeId })).rejects.toMatchObject({ code: "CHAT_SESSION_ID_INVALID" });
      expect(read).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(deps.createFileTranscriptStore).not.toHaveBeenCalled();
    },
  );
  test.each(["other-session", "../outside"])(
    "F1 rejects mismatched stored session id %j before locking",
    async (sessionId) => {
      await seed();
      const stored = await storage.readMeta(ID);
      await Bun.write(join(dir, `${ID}.session.json`), JSON.stringify({ ...stored, sessionId }));
      const acquire = spyOn(storage, "acquireLock");
      await expect(open({ resumeId: ID })).rejects.toMatchObject({ code: "SESSION_META_UNREADABLE" });
      expect(acquire).not.toHaveBeenCalled();
      expect(deps.nativeBackend).not.toHaveBeenCalled();
      expect(deps.createAgentSession).not.toHaveBeenCalled();
      expect(deps.resumeAgentSession).not.toHaveBeenCalled();
    },
  );
  test("explicit switches override mode and model without committing metadata", async () => {
    await seed();
    const handle = await open({ resumeId: ID, mode: "guarded", model: "anthropic/switched" });
    expect(handle.meta).toMatchObject({
      mode: "ask",
      bashApproval: "raw",
      model: "anthropic/switched",
      title: "Existing",
    });
    expect(await storage.readMeta(ID)).toMatchObject({ mode: "full", model: "anthropic/stored" });
    expect(deps.nativeBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic/switched",
        bashApproval: "raw",
        carryHistoryAcrossModels: true,
        loopHandlers: request.loopHandlers,
      }),
    );
  });
  test("requires a model before locking a new session", async () => {
    const acquire = spyOn(storage, "acquireLock");
    await expect(open({ model: undefined })).rejects.toMatchObject({ code: "CHAT_SESSION_MODEL_REQUIRED" });
    expect(acquire).not.toHaveBeenCalled();
  });
  test.each(["metadata", "rules", "backend", "transcript", "resume"] as const)(
    "releases ownership after %s failure",
    async (stage) => {
      const error = new NaxError("injected failure", "TEST_FAILURE", { stage: "test" });
      const fail = () => {
        throw error;
      };
      if (stage === "metadata") spyOn(storage, "writeMeta").mockImplementation(fail);
      if (stage === "rules") deps.resolveRuleSet = mock(fail);
      if (stage === "backend") deps.nativeBackend = mock(fail);
      if (stage === "transcript")
        deps.createFileTranscriptStore = mock(() => ({
          ..._openChatSessionDeps.createFileTranscriptStore(dir),
          load: async () => fail(),
        }));
      if (stage === "resume") {
        await seed();
        doc = { savedAt: NOW.toISOString(), messages: [] };
        deps.resumeAgentSession = mock(fail);
      }
      await expect(open(stage === "resume" ? { resumeId: ID } : {})).rejects.toBe(error);
      expect(await storage.readLockHolder(ID)).toBeNull();
    },
  );
  test("passes configured rule overrides and omits an empty catalog", async () => {
    await open({
      config: makeNaxConfig({ context: { rules: { overrideDir: join(dir, "overrides"), overrideMode: "replace" } } }),
    });
    expect(deps.resolveRuleSet).toHaveBeenCalledWith({
      repoRoot: dir,
      packageDir: dir,
      overrideDir: join(dir, "overrides"),
      overrideMode: "replace",
    });
    expect(deps.nativeBackend).not.toHaveBeenCalledWith(
      expect.objectContaining({ catalogOverrides: expect.anything() }),
    );
  });
});

describe("resolveChatSessionsDir", () => {
  test("AC-20 honours environment override", () => {
    expect(resolveChatSessionsDir({ NAX_AGENT_SESSIONS_DIR: "/tmp/s" })).toBe("/tmp/s");
  });
  test("AC-21 defaults to shared global sessions directory", () => {
    expect(resolveChatSessionsDir({})).toBe(defaultSessionsDir(globalConfigDir()));
  });
});

describe("createChatStorage", () => {
  test("forwards pid, Date clock and logger to storage factory", () => {
    const logger = makeLogger();
    const now = () => NOW;
    const factory = spyOn(_openChatSessionDeps, "createSessionStorage").mockReturnValue(storage);
    expect(createChatStorage({ env: { NAX_AGENT_SESSIONS_DIR: dir }, pid: 123, now, logger })).toBe(storage);
    expect(factory).toHaveBeenCalledWith({ dir, pid: 123, now, logger });
  });
});

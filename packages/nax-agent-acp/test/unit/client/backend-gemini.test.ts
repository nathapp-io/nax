import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  resumeAgentSession,
  type SessionEvent,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { FULL_REASON } from "#src/client/permissions";
import {
  CLAUDE_CONFIG_OPTIONS,
  CODEX_CONFIG_OPTIONS,
  type FakeScript,
  GEMINI_SESSION_MODELS,
  GEMINI_SESSION_MODES,
  type PermissionStep,
} from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-gemini-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

const MODE_CALL = "session/set_mode";
const MODEL_CALL = "session/set_model";
const CONFIG_CALL = "session/set_config_option";
const AGENT_SESSION_ID = "fake-session-1";
const PLAN_MODE = { sessionId: AGENT_SESSION_ID, modeId: "plan" };
const FLASH_MODEL = "gemini-3-flash-preview";

interface OpenOptions {
  readonly agent?: AcpBackendOptions["agent"];
  readonly profile?: AgentSessionProfile;
  readonly model?: string;
  readonly script?: FakeScript;
  readonly tools?: readonly EmbedderTool[];
}

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

function backendFor(agent: AcpBackendOptions["agent"], model: string | undefined) {
  return acpBackend({
    agent,
    allowUnsandboxed: true,
    command: `fake-${typeof agent === "string" ? agent : agent.name}`,
    ...(model === undefined ? {} : { model }),
  });
}

/** A fake process for one open; the caller decides whether the open is awaited (a refusal throws). */
function launched(profile: AgentSessionProfile, options: OpenOptions, store: TranscriptStore) {
  const agent = options.agent ?? "gemini";
  const fake = inMemoryAgent({ agentInfo: { name: `${String(agent)}-acp`, version: "1.0.0" }, ...options.script });
  _acpBackendDeps.launch = fake.launch;
  const opened = createAgentSession({
    backend: backendFor(agent, options.model),
    profile,
    workdir,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    transcriptStore: store,
    sessionId: "s-1",
  });
  return { fake, opened };
}

async function open(
  profile: AgentSessionProfile,
  options: OpenOptions = {},
  store: TranscriptStore = createMemoryTranscriptStore(),
): Promise<Opened> {
  const { fake, opened } = launched(profile, options, store);
  const session = await opened;
  sessions.push(session);
  return { fake, session };
}

/** A new process (so a fresh record) restoring the session the store holds. */
async function restore(store: TranscriptStore, options: OpenOptions = {}): Promise<Opened> {
  const agent = options.agent ?? "gemini";
  const fake = inMemoryAgent({ agentInfo: { name: `${String(agent)}-acp`, version: "1.0.0" }, ...options.script });
  _acpBackendDeps.launch = fake.launch;
  const session = await resumeAgentSession("s-1", {
    backend: backendFor(agent, options.model),
    profile: options.profile ?? "read",
    workdir,
    transcriptStore: store,
  });
  sessions.push(session);
  return { fake, session };
}

const setModes = (o: Opened) => o.fake.callsTo(MODE_CALL);
const setModels = (o: Opened) => o.fake.callsTo(MODEL_CALL);
const configCalls = (o: Opened) => o.fake.callsTo(CONFIG_CALL);
const answers = (o: Opened) => o.fake.callsTo("permission-outcome");
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
const methods = (o: Opened) => o.fake.recorded().map((call) => call.method);

/** A modes block without `plan`: gemini cannot enforce read-only with it. */
const NO_PLAN_MODES: SessionModeState = {
  availableModes: [{ id: "default", name: "Default" }],
  currentModeId: "default",
};

/** Gemini's `plan` behind a config option, the ACP 1.x way of offering the same value. */
const PLAN_CONFIG_OPTIONS: readonly SessionConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
];

/** Gemini's Flash model behind a config option, beside the legacy models block. */
const FLASH_CONFIG_OPTIONS: readonly SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "auto",
    options: [
      { value: "auto", name: "Auto" },
      { value: FLASH_MODEL, name: "Gemini 3 Flash Preview" },
    ],
  },
];

/** 60 models, the first of which a request may name; a refusal lists the first 50. */
const MANY_MODELS: Readonly<Record<string, unknown>> = {
  availableModels: Array.from({ length: 60 }, (_unused, index) => ({
    modelId: `m-${index + 1}`,
    name: `Model ${index + 1}`,
  })),
  currentModelId: "m-1",
};

const EDIT: PermissionStep = { kind: "permission", options: ["allow_once", "reject_once"] };
const RUN: PermissionStep = {
  kind: "permission",
  options: ["allow_once", "reject_once"],
  toolCall: { kind: "execute", title: "Run tests", rawInput: { command: "bun test ./x" } },
};

const LOOKUP: EmbedderTool = {
  name: "lookup",
  description: "Look a word up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  approval: "never",
  run: async () => ({ content: "found" }),
};

describe("gemini's read-only profiles run in its plan mode (nax#2372)", () => {
  const MODES_ONLY: FakeScript = { modes: GEMINI_SESSION_MODES };

  test("AC-11: read opens against a modes-only session/new answer", async () => {
    const o = await open("read", { script: MODES_ONLY });
    expect(o.session.backend.kind).toBe("acp:gemini");
    expect(o.session.backend.capabilities).toMatchObject({ readOnlyMode: true, preApproval: false });
    expect(o.fake.callsTo("session/new")).toHaveLength(1);
  });

  test("AC-12: read sets plan exactly once, through session/set_mode", async () => {
    const o = await open("read", { script: MODES_ONLY });
    expect(setModes(o)).toEqual([PLAN_MODE]);
  });

  test("AC-13: read sends no session/set_config_option: the modes block is the only offer", async () => {
    const o = await open("read", { script: MODES_ONLY });
    expect(configCalls(o)).toEqual([]);
  });

  test.each(["review", "none"] as const)("AC-14: %s also runs in plan mode", async (profile) => {
    const o = await open(profile, { script: MODES_ONLY });
    expect(setModes(o)).toEqual([PLAN_MODE]);
  });

  test("AC-15: full keeps gemini's launch mode", async () => {
    const o = await open("full", { script: MODES_ONLY });
    expect(setModes(o)).toEqual([]);
    expect(configCalls(o)).toEqual([]);
  });
});

describe("a mode neither block offers is refused (nax#2372)", () => {
  test("AC-16: read without plan anywhere: CAPABILITY_UNSUPPORTED profile", async () => {
    const { opened } = launched("read", { script: { modes: NO_PLAN_MODES } }, createMemoryTranscriptStore());
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "profile" });
  });

  test("AC-17: the refused open kills the agent process once", async () => {
    const { fake, opened } = launched("read", { script: { modes: NO_PLAN_MODES } }, createMemoryTranscriptStore());
    await rejection(opened);
    expect(fake.kills()).toBe(1);
  });
});

describe("gemini's models block sets the model through session/set_model (nax#2372)", () => {
  const MODELS_ONLY: FakeScript = { models: GEMINI_SESSION_MODELS };

  test("AC-18: full with a models-only session/new answer opens", async () => {
    const o = await open("full", { script: MODELS_ONLY, model: FLASH_MODEL });
    expect(o.session.backend.kind).toBe("acp:gemini");
    expect(o.fake.callsTo("session/new")).toHaveLength(1);
  });

  test("AC-19: the model is set once, through session/set_model", async () => {
    const o = await open("full", { script: MODELS_ONLY, model: FLASH_MODEL });
    expect(setModels(o)).toEqual([{ sessionId: AGENT_SESSION_ID, modelId: FLASH_MODEL }]);
  });

  test("AC-20: a model no block offers: CAPABILITY_UNSUPPORTED model", async () => {
    const { opened } = launched("full", { model: "gemini-9", script: MODELS_ONLY }, createMemoryTranscriptStore());
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "model" });
  });

  test("AC-21: the refusal lists the models block's ids", async () => {
    const { opened } = launched("full", { model: "gemini-9", script: MODELS_ONLY }, createMemoryTranscriptStore());
    const err = sessionError(await rejection(opened));
    expect(err.context).toMatchObject({ offered: ["auto", FLASH_MODEL] });
  });
});

describe("a config option still wins over the legacy blocks (nax#2372)", () => {
  test("AC-22: claude sets its mode and model through session/set_config_option", async () => {
    const o = await open("read", {
      agent: "claude",
      model: "sonnet",
      script: { configOptions: CLAUDE_CONFIG_OPTIONS, modes: NO_PLAN_MODES },
    });
    expect(configCalls(o)).toEqual([
      { sessionId: AGENT_SESSION_ID, configId: "mode", value: "default" },
      { sessionId: AGENT_SESSION_ID, configId: "model", value: "sonnet" },
    ]);
  });

  test("AC-23: claude sends no session/set_mode and no session/set_model", async () => {
    const o = await open("read", {
      agent: "claude",
      model: "sonnet",
      script: { configOptions: CLAUDE_CONFIG_OPTIONS, modes: NO_PLAN_MODES },
    });
    expect(methods(o)).toContain(CONFIG_CALL);
    expect(setModes(o)).toEqual([]);
    expect(setModels(o)).toEqual([]);
  });

  test("AC-24: codex still sets its read-only mode through session/set_config_option", async () => {
    const o = await open("read", { agent: "codex", script: { configOptions: CODEX_CONFIG_OPTIONS } });
    expect(configCalls(o)).toEqual([{ sessionId: AGENT_SESSION_ID, configId: "mode", value: "read-only" }]);
  });

  test("AC-25: codex sends no session/set_mode", async () => {
    const o = await open("read", { agent: "codex", script: { configOptions: CODEX_CONFIG_OPTIONS } });
    expect(setModes(o)).toEqual([]);
  });

  test("AC-37: a mode option and a modes block: the option is used, session/set_mode is not", async () => {
    const o = await open("read", {
      script: { configOptions: PLAN_CONFIG_OPTIONS, modes: GEMINI_SESSION_MODES },
    });
    expect(configCalls(o)).toEqual([{ sessionId: AGENT_SESSION_ID, configId: "mode", value: "plan" }]);
    expect(setModes(o)).toEqual([]);
  });

  test("AC-38: a model option and a models block: the option is used, session/set_model is not", async () => {
    const o = await open("full", {
      model: FLASH_MODEL,
      script: { configOptions: FLASH_CONFIG_OPTIONS, models: GEMINI_SESSION_MODELS },
    });
    expect(configCalls(o)).toEqual([{ sessionId: AGENT_SESSION_ID, configId: "model", value: FLASH_MODEL }]);
    expect(setModels(o)).toEqual([]);
  });

  test("AC-39: no option and no models block offers the model: the failed open kills the process", async () => {
    const { fake, opened } = launched(
      "full",
      { model: "gemini-9", script: { configOptions: FLASH_CONFIG_OPTIONS, models: GEMINI_SESSION_MODELS } },
      createMemoryTranscriptStore(),
    );
    expect(sessionError(await rejection(opened)).context).toMatchObject({ capability: "model" });
    expect(fake.kills()).toBe(1);
  });
});

describe("a restored gemini session re-applies plan mode (nax#2372)", () => {
  async function stored(script: FakeScript): Promise<TranscriptStore> {
    const store = createMemoryTranscriptStore();
    const { session } = await open("read", { script }, store);
    await session.close();
    return store;
  }

  test("AC-26: session/load answers the modes block; plan is set after it", async () => {
    const store = await stored({ modes: GEMINI_SESSION_MODES, capabilities: { loadSession: true } });
    const o = await restore(store, { script: { modes: GEMINI_SESSION_MODES, capabilities: { loadSession: true } } });
    expect(o.session.backend.capabilities).toMatchObject({ restoredWith: "load" });
    expect(o.fake.callsTo("session/load")).toHaveLength(1);
    expect(setModes(o)).toEqual([PLAN_MODE]);
    expect(methods(o).indexOf("session/load")).toBeLessThan(methods(o).indexOf(MODE_CALL));
  });

  test("AC-27: session/resume answers the modes block; plan is set after it", async () => {
    const script: FakeScript = { modes: GEMINI_SESSION_MODES, capabilities: { sessionCapabilities: { resume: {} } } };
    const store = await stored(script);
    const o = await restore(store, { script });
    expect(o.session.backend.capabilities).toMatchObject({ restoredWith: "resume" });
    expect(o.fake.callsTo("session/resume")).toHaveLength(1);
    expect(setModes(o)).toEqual([PLAN_MODE]);
    expect(methods(o).indexOf("session/resume")).toBeLessThan(methods(o).indexOf(MODE_CALL));
  });
});

describe("a failed legacy setter fails the open as any other open step (nax#2372)", () => {
  const MODE_FAILURE = { code: -32603, message: "mode failed" };
  const MODEL_FAILURE = { code: -32603, message: "model failed" };

  test("AC-28: session/set_mode fails: BACKEND_UNAVAILABLE with the step and rpc code", async () => {
    const { opened } = launched(
      "read",
      { script: { modes: GEMINI_SESSION_MODES, setModeFailure: MODE_FAILURE } },
      createMemoryTranscriptStore(),
    );
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.context).toMatchObject({ step: MODE_CALL, rpcCode: -32603 });
  });

  test("AC-29: the failed session/set_mode step kills the agent process once", async () => {
    const { fake, opened } = launched(
      "read",
      { script: { modes: GEMINI_SESSION_MODES, setModeFailure: MODE_FAILURE } },
      createMemoryTranscriptStore(),
    );
    await rejection(opened);
    expect(fake.kills()).toBe(1);
  });

  test("AC-30: session/set_model fails: BACKEND_UNAVAILABLE with the step and rpc code", async () => {
    const { opened } = launched(
      "full",
      { model: FLASH_MODEL, script: { models: GEMINI_SESSION_MODELS, setModelFailure: MODEL_FAILURE } },
      createMemoryTranscriptStore(),
    );
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.context).toMatchObject({ step: MODEL_CALL, rpcCode: -32603 });
  });

  test("AC-31: the failed session/set_model step kills the agent process once", async () => {
    const { fake, opened } = launched(
      "full",
      { model: FLASH_MODEL, script: { models: GEMINI_SESSION_MODELS, setModelFailure: MODEL_FAILURE } },
      createMemoryTranscriptStore(),
    );
    await rejection(opened);
    expect(fake.kills()).toBe(1);
  });
});

describe("gemini's model refusal is bounded (nax#2372)", () => {
  const SCRIPT: FakeScript = { models: MANY_MODELS };

  test("AC-32: a model no block offers: CAPABILITY_UNSUPPORTED model", async () => {
    const { opened } = launched("full", { model: "gemini-9", script: SCRIPT }, createMemoryTranscriptStore());
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "model" });
  });

  test("AC-33: the refusal lists exactly 50 ids, from the first the block offers", async () => {
    const { opened } = launched("full", { model: "gemini-9", script: SCRIPT }, createMemoryTranscriptStore());
    const err = sessionError(await rejection(opened));
    const firstFifty = Array.from({ length: 50 }, (_unused, index) => `m-${index + 1}`);
    expect(err.context).toMatchObject({ offered: firstFifty });
  });
});

describe("gemini permissions are decided by profile, outside plan mode (nax#2372)", () => {
  test("AC-34: full answers an execute request with allow_once", async () => {
    const o = await open("full", { script: { turns: [{ steps: [RUN, { kind: "text", text: "ran" }] }] } });
    await driveTurn(o.session, "go");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
  });

  test("AC-35: that decision is recorded with FULL_REASON", async () => {
    const o = await open("full", { script: { turns: [{ steps: [RUN, { kind: "text", text: "ran" }] }] } });
    const events = await driveTurn(o.session, "go");
    expect(find(events, "approval_requested")).toMatchObject({ tool: "execute", reason: FULL_REASON });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "profile" });
  });

  test("AC-40: full answers an edit request with allow_once", async () => {
    const o = await open("full", { script: { turns: [{ steps: [EDIT] }] } });
    await driveTurn(o.session, "go");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
  });

  const ASK: FakeScript = { turns: [{ steps: [RUN, { kind: "text", text: "continued" }] }] };

  test("AC-41: ask puts the execute request to the caller; a deny answers reject_once", async () => {
    const o = await open("ask", { script: ASK });
    await driveTurn(o.session, "go", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "deny" });
    });
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
  });

  test("AC-42: the denied execute request does not abort the turn: it completes with the agent's text", async () => {
    const o = await open("ask", { script: ASK });
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "deny" });
    });
    expect(endOf(events)).toMatchObject({ status: "completed", output: "continued" });
  });
});

describe("gemini's capability boundary (nax#2372)", () => {
  test("AC-36: read with one embedder tool is refused: gemini has no pre-approval channel", async () => {
    const { fake, opened } = launched(
      "read",
      { script: { modes: GEMINI_SESSION_MODES }, tools: [LOOKUP] },
      createMemoryTranscriptStore(),
    );
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
    expect(fake.kills()).toBe(1);
  });
});

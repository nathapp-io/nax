/**
 * US-002 (chat-acp-switch-and-replay): the ACP backend's OpenedBackend.configure sets the
 * model and the effort on the live agent session with session/set_config_option, and keeps
 * what it applied so a reconnect re-applies it. Everything is driven through
 * createAgentSession({ backend: acpBackend(...) }).configure against the in-memory fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { type AgentSession, createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { type AcpLink, openConnection } from "#src/client/connection";
import { openRequestError } from "#src/client/errors";
import { configModelIds } from "#src/client/open";
import { rejectLocally } from "#src/client/permissions";
import { type AppliedPart, configureAcpSession } from "#src/client/session-configure";
import { buildFakeAgent } from "#test/fixtures/fake-agent/agent";
import { CODEX_CONFIG_OPTIONS, CURSOR_CONFIG_OPTIONS, type FakeScript } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
const links: AcpLink[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-configure-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const link of links.splice(0)) link.close();
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

const CONFIG_CALL = "session/set_config_option";
const AGENT_SESSION_ID = "fake-session-1";
const RESUMABLE: FakeScript = { capabilities: { sessionCapabilities: { resume: {} } } };
/** Lets the backend observe the in-memory process exit. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function select(id: string, category: string, values: readonly string[]): SessionConfigOption {
  return {
    id,
    name: id,
    category,
    type: "select",
    currentValue: values[0] ?? "",
    options: values.map((value) => ({ value, name: value })),
  };
}

const MODEL_AB = select("model", "model", ["a", "b"]);
const THOUGHT_HIGH = select("thought", "thought_level", ["low", "high"]);
const CODEX_WITH = (...extra: SessionConfigOption[]) => [...CODEX_CONFIG_OPTIONS, ...extra];

interface OpenOptions {
  readonly agent?: "codex" | "cursor";
  readonly model?: string;
  readonly effort?: string;
  readonly initializeTimeoutMs?: number;
}

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

async function open(script: FakeScript, options: OpenOptions = {}): Promise<Opened> {
  const agent = options.agent ?? "codex";
  const fake = inMemoryAgent({ agentInfo: { name: `${agent}-acp`, version: "1.0.0" }, ...RESUMABLE, ...script });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({
      agent,
      allowUnsandboxed: true,
      command: `fake-${agent}`,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: options.initializeTimeoutMs }),
    }),
    profile: "full",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

function configureOf(session: AgentSession) {
  const configure = session.configure;
  if (configure === undefined) throw new Error("the facade always provides configure");
  return configure.bind(session);
}

const configCalls = (o: Opened) => o.fake.callsTo(CONFIG_CALL);
const call = (configId: string, value: string) => ({ sessionId: AGENT_SESSION_ID, configId, value });

describe("configure sets the model and the effort on the live session", () => {
  test("AC-1: a model sends set_config_option with the model option's id and the value", async () => {
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB) });
    await configureOf(o.session)({ model: "b" });
    expect(configCalls(o)).toEqual([call("model", "b")]);
  });

  test("AC-2: an effort sends set_config_option with the thought_level option's id", async () => {
    const o = await open({ configOptions: CODEX_WITH(THOUGHT_HIGH) });
    await configureOf(o.session)({ effort: "high" });
    expect(configCalls(o)).toEqual([call("thought", "high")]);
  });

  test("AC-3: the effort option is resolved from the model response's configOptions", async () => {
    const initial = CODEX_WITH(MODEL_AB, select("thought", "thought_level", ["low"]));
    const answer = CODEX_WITH(MODEL_AB, THOUGHT_HIGH);
    const o = await open({ configOptions: initial, setConfigOptionsAnswer: answer });
    await configureOf(o.session)({ model: "b", effort: "high" });
    expect(configCalls(o)).toEqual([call("model", "b"), call("thought", "high")]);
  });

  test("AC-4: Codex's reasoning_effort option sets the effort when it has no thought_level category", async () => {
    const o = await open({ configOptions: CODEX_WITH(select("reasoning_effort", "other", ["low", "high"])) });
    await configureOf(o.session)({ effort: "high" });
    expect(configCalls(o)).toEqual([call("reasoning_effort", "high")]);
  });

  test("AC-5: Cursor's bare model name resolves to the offered id that carries settings", async () => {
    const options = [
      ...CURSOR_CONFIG_OPTIONS.filter((option) => option.category !== "model"),
      select("model", "model", ["default[]", "gpt-5.5[context=272k]"]),
    ];
    const o = await open({ configOptions: options }, { agent: "cursor" });
    await configureOf(o.session)({ model: "gpt-5.5" });
    expect(configCalls(o)).toEqual([call("model", "gpt-5.5[context=272k]")]);
  });
});

describe("configure refuses what the agent does not offer, before any request", () => {
  test("AC-6: a model no option offers is CAPABILITY_UNSUPPORTED (capability model)", async () => {
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB) });
    const err = sessionError(await rejection(configureOf(o.session)({ model: "zzz" })));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "model" });
    expect(configCalls(o)).toEqual([]);
  });

  test("AC-7: an effort no option offers is CAPABILITY_UNSUPPORTED (capability effort)", async () => {
    const o = await open({ configOptions: CODEX_WITH(THOUGHT_HIGH) });
    const err = sessionError(await rejection(configureOf(o.session)({ effort: "max" })));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "effort" });
    expect(configCalls(o)).toEqual([]);
  });
});

describe("a configure request is bounded and classified", () => {
  test("AC-8: an unanswered request times out with BACKEND_UNAVAILABLE", async () => {
    const o = await open(
      { configOptions: CODEX_WITH(MODEL_AB), setConfigOptionHang: true },
      { initializeTimeoutMs: 50 },
    );
    const err = sessionError(await rejection(configureOf(o.session)({ model: "b" })));
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(configCalls(o)).toHaveLength(1);
  });

  test("AC-9: a JSON-RPC error is BACKEND_UNAVAILABLE with the step in its context", async () => {
    const failure = { code: -32603, message: "boom" };
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB), setConfigOptionFailure: failure });
    const err = sessionError(await rejection(configureOf(o.session)({ model: "b" })));
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.context).toMatchObject({ step: CONFIG_CALL });
  });

  test("AC-10: close() while the request is pending rejects the configure with SESSION_CLOSED", async () => {
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB), setConfigOptionHang: true });
    const pending = rejection(configureOf(o.session)({ model: "b" }));
    await waitForCondition(() => configCalls(o).length === 1, 2_000);
    await o.session.close();
    expect(sessionError(await pending).code).toBe("AGENT_SESSION_CLOSED");
  });

  test.each([
    ["an internal error", { code: -32603, message: "boom" }],
    ["an authentication error", { code: -32000, message: "login first" }],
  ])("AC-18: %s is classified as openRequestError classifies it", async (_name, failure) => {
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB), setConfigOptionFailure: failure });
    const err = sessionError(await rejection(configureOf(o.session)({ model: "b" })));
    const expected = openRequestError(CONFIG_CALL, new RequestError(failure.code, failure.message), []);
    expect(err.code).toBe(expected.code);
    expect(err.message).toBe(expected.message);
    expect(err.context).toEqual(expected.context);
  });
});

describe("configure and the process", () => {
  test("AC-11: after a model configure and an exit, the reconnect's open sets the model", async () => {
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB) });
    await configureOf(o.session)({ model: "b" });
    o.fake.crash();
    await tick();
    await driveTurn(o.session, "hi");
    expect(o.fake.requests).toHaveLength(2);
    expect(configCalls(o)).toEqual([call("model", "b"), call("model", "b")]);
  });

  test("AC-12: after an effort configure and an exit, the reconnect's open sets the effort", async () => {
    const o = await open({ configOptions: CODEX_WITH(THOUGHT_HIGH) });
    await configureOf(o.session)({ effort: "high" });
    o.fake.crash();
    await tick();
    await driveTurn(o.session, "hi");
    expect(configCalls(o)).toEqual([call("thought", "high"), call("thought", "high")]);
  });

  test("AC-13: a send after a configure runs on the same process", async () => {
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB) });
    await configureOf(o.session)({ model: "b" });
    expect(endOf(await driveTurn(o.session, "hi")).status).toBe("completed");
    expect(o.fake.requests).toHaveLength(1);
  });

  test("AC-14: a configure after the process exited reconnects once and sends on the new process", async () => {
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB) });
    o.fake.crash();
    await tick();
    await configureOf(o.session)({ model: "b" });
    expect(o.fake.requests).toHaveLength(2);
    expect(o.fake.callsTo("session/resume")).toHaveLength(1);
    expect(configCalls(o)).toEqual([call("model", "b")]);
  });

  test("AC-15: the model is resolved from the options the open's effort response returned", async () => {
    const initial = CODEX_WITH(select("model", "model", ["a"]), THOUGHT_HIGH);
    const answer = CODEX_WITH(MODEL_AB, THOUGHT_HIGH);
    const o = await open({ configOptions: initial, setConfigOptionsAnswer: answer }, { effort: "high" });
    expect(configCalls(o)).toEqual([call("thought", "high")]);
    await configureOf(o.session)({ model: "b" });
    expect(configCalls(o)).toEqual([call("thought", "high"), call("model", "b")]);
  });

  test("AC-16: a failed effort keeps the applied model, which a reconnect re-applies", async () => {
    const o = await open({ configOptions: CODEX_WITH(MODEL_AB, THOUGHT_HIGH) });
    const err = sessionError(await rejection(configureOf(o.session)({ model: "b", effort: "max" })));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "effort" });
    expect(configCalls(o)).toEqual([call("model", "b")]);
    o.fake.crash();
    await tick();
    await driveTurn(o.session, "hi");
    expect(configCalls(o)).toEqual([call("model", "b"), call("model", "b")]);
  });
});

describe("configModelIds", () => {
  test("AC-17: lists every model select option's values in offer order and ignores other categories", () => {
    const options: SessionConfigOption[] = [
      select("mode", "mode", ["agent"]),
      select("m1", "model", ["x", "y"]),
      select("thought", "thought_level", ["high"]),
      select("m2", "model", ["z"]),
    ];
    expect(configModelIds(options)).toEqual(["x", "y", "z"]);
  });
});

describe("the offered models after open", () => {
  test("AC-19: a model set at open leaves offeredModels as the post-model offers", async () => {
    const answer = CODEX_WITH(select("model", "model", ["gpt-5.4"]));
    const o = await open(
      { configOptions: CODEX_WITH(select("model", "model", ["gpt-5.5", "gpt-5.4"])), setConfigOptionsAnswer: answer },
      { model: "gpt-5.4" },
    );
    expect(o.session.backend.capabilities).toMatchObject({ offeredModels: ["gpt-5.4"] });
  });
});

describe("configureAcpSession reports each applied part", () => {
  async function linkFor(script: FakeScript) {
    const app = buildFakeAgent(script, {
      record: () => {},
      exit: () => {
        throw new Error("no exit in process");
      },
    });
    const link = openConnection(
      { kind: "app", agent: app },
      {
        onUpdate: () => {},
        onPermission: async (r) => rejectLocally(r),
        onElicitation: async () => ({ action: "cancel" }),
      },
    );
    links.push(link);
    await link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await link.newSession({ cwd: workdir, mcpServers: [] });
    return { link, agentSessionId: created.sessionId, configOptions: created.configOptions ?? [] };
  }

  test("the model is reported before the effort step fails", async () => {
    const answer = CODEX_WITH(select("model", "model", ["a", "b"]));
    const { link, agentSessionId, configOptions } = await linkFor({
      configOptions: CODEX_WITH(MODEL_AB),
      setConfigOptionsAnswer: answer,
    });
    const applied: { part: AppliedPart; options: readonly SessionConfigOption[] }[] = [];
    const err = await rejection(
      configureAcpSession(
        {
          link,
          agentSessionId,
          agentName: "codex",
          secrets: [],
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          sessionId: "s-1",
          configOptions,
          change: { model: "b", effort: "max" },
        },
        (part, options) => applied.push({ part, options }),
      ),
    );
    expect(sessionError(err).code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(applied).toEqual([{ part: { model: "b" }, options: answer }]);
  });
});

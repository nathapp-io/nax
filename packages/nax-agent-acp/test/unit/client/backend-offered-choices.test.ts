import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { type AgentSession, createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { type AcpLink, openConnection } from "#src/client/connection";
import { rejectLocally } from "#src/client/permissions";
import { buildFakeAgent } from "#test/fixtures/fake-agent/agent";
import { CODEX_CONFIG_OPTIONS, type FakeScript } from "#test/fixtures/fake-agent/script";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
const links: AcpLink[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-offered-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const link of links.splice(0)) link.close();
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

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

const MODEL_OPTION = select("model", "model", ["gpt-5.5", "gpt-5.4"]);
const EFFORT_OPTION = select("thought", "thought_level", ["low", "high"]);

async function open(script: FakeScript, model?: string): Promise<AgentSession> {
  const fake = inMemoryAgent({ agentInfo: { name: "codex-acp", version: "1.0.0" }, ...script });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({ agent: "codex", allowUnsandboxed: true, command: "fake-agent", ...(model ? { model } : {}) }),
    profile: "full",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return session;
}

describe("acpBackend reports what the agent offers", () => {
  test("offeredModels lists the model option's values", async () => {
    const session = await open({ configOptions: [...CODEX_CONFIG_OPTIONS, MODEL_OPTION] });
    expect(session.backend.capabilities).toMatchObject({ offeredModels: ["gpt-5.5", "gpt-5.4"] });
  });

  test("offeredEfforts lists the thought_level option's values", async () => {
    const session = await open({ configOptions: [...CODEX_CONFIG_OPTIONS, MODEL_OPTION, EFFORT_OPTION] });
    expect(session.backend.capabilities).toMatchObject({ offeredEfforts: ["low", "high"] });
  });

  test("offeredModels are the offers after the model step", async () => {
    const answer = [...CODEX_CONFIG_OPTIONS, select("model", "model", ["gpt-5.4"])];
    const session = await open(
      { configOptions: [...CODEX_CONFIG_OPTIONS, MODEL_OPTION], setConfigOptionsAnswer: answer },
      "gpt-5.4",
    );
    expect(session.backend.capabilities).toMatchObject({ offeredModels: ["gpt-5.4"] });
  });

  test("an agent offering no config options reports no models and no efforts", async () => {
    const session = await open({});
    expect(session.backend.capabilities).toMatchObject({ offeredModels: [], offeredEfforts: [] });
  });
});

describe("the fake agent's set_config_option answer", () => {
  function pair(script: FakeScript) {
    const app = buildFakeAgent(script, { record: () => {}, exit: () => never() });
    const link = openConnection(
      { kind: "app", agent: app },
      {
        onUpdate: () => {},
        onPermission: async (r) => rejectLocally(r),
        onElicitation: async () => ({ action: "cancel" }),
      },
    );
    links.push(link);
    return link;
  }

  function never(): never {
    throw new Error("no exit in process");
  }

  async function setMode(script: FakeScript) {
    const link = pair(script);
    await link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await link.newSession({ cwd: workdir, mcpServers: [] });
    return link.setConfigOption({ sessionId: created.sessionId, configId: "mode", value: "agent" });
  }

  test("returns exactly setConfigOptionsAnswer when set", async () => {
    const answer = [select("model", "model", ["only"])];
    const response = await setMode({ configOptions: CODEX_CONFIG_OPTIONS, setConfigOptionsAnswer: answer });
    expect(response.configOptions).toEqual(answer);
  });

  test("returns the session/new options when it is not set", async () => {
    const response = await setMode({ configOptions: CODEX_CONFIG_OPTIONS });
    expect(response.configOptions).toEqual([...CODEX_CONFIG_OPTIONS]);
  });
});

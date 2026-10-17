/**
 * Cursor's registration and its settings-carrying model ids (SPEC-cursor-pi-acp-read-only
 * US-001): `cursor-agent acp` launches, CURSOR_API_KEY is the only auth variable, the
 * `ask` mode carries none/read/review, and a bare model name resolves to the single
 * offered id that carries settings.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { resolveModelValue } from "#src/client/capabilities";
import type { AcpBackendOptions } from "#src/client/options";
import { resolveAcpOptions } from "#src/client/options";
import { CLAUDE_CONFIG_OPTIONS, CURSOR_CONFIG_OPTIONS, type FakeScript } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError, thrown } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-cursor-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

const CONFIG_CALL = "session/set_config_option";
const MODEL_CALL = "session/set_model";
const AGENT_SESSION_ID = "fake-session-1";
const CURSOR_MODEL = "gpt-5.5[context=272k,reasoning=medium]";

interface OpenOptions {
  readonly agent?: AcpBackendOptions["agent"];
  readonly profile?: AgentSessionProfile;
  readonly model?: string;
  readonly script?: FakeScript;
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
function launched(profile: AgentSessionProfile, options: OpenOptions) {
  const agent = options.agent ?? "cursor";
  const fake = inMemoryAgent({ agentInfo: { name: `${String(agent)}-acp`, version: "1.0.0" }, ...options.script });
  _acpBackendDeps.launch = fake.launch;
  const opened = createAgentSession({
    backend: backendFor(agent, options.model),
    profile,
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  return { fake, opened };
}

async function open(profile: AgentSessionProfile, options: OpenOptions = {}): Promise<Opened> {
  const { fake, opened } = launched(profile, options);
  const session = await opened;
  sessions.push(session);
  return { fake, session };
}

const configCalls = (o: Opened) => o.fake.callsTo(CONFIG_CALL);
const setModels = (o: Opened) => o.fake.callsTo(MODEL_CALL);

/** The recorded calls whose `configId` is one of `ids`; the params are agent data, so every read is checked. */
const configCallsFor = (o: Opened, ids: readonly string[]) =>
  configCalls(o).filter(
    (params) =>
      typeof params === "object" && params !== null && "configId" in params && ids.includes(`${params.configId}`),
  );

describe("cursor is registered as an ACP agent (US-001)", () => {
  test('AC-3: acpBackend({ agent: "cursor" }) does not throw', () => {
    expect(() => acpBackend({ agent: "cursor", allowUnsandboxed: true })).not.toThrow();
  });

  test("AC-4: its kind is acp:cursor", () => {
    expect(acpBackend({ agent: "cursor", allowUnsandboxed: true }).kind).toBe("acp:cursor");
  });

  test("AC-5: CURSOR_API_KEY passes the env allowlist", () => {
    const resolved = resolveAcpOptions(
      { agent: "cursor", allowUnsandboxed: true, env: {} },
      { CURSOR_API_KEY: "k", OTHER: "x" },
    );
    expect(resolved.env.CURSOR_API_KEY).toBe("k");
  });

  test("AC-6: no other variable does", () => {
    const resolved = resolveAcpOptions(
      { agent: "cursor", allowUnsandboxed: true, env: {} },
      { CURSOR_API_KEY: "k", OTHER: "x" },
    );
    expect(Object.hasOwn(resolved.env, "OTHER")).toBe(false);
  });
});

describe("resolveModelValue resolves a bare Cursor model name (US-001)", () => {
  test("AC-7: the one offered id that carries settings", () => {
    expect(resolveModelValue("cursor", ["default[]", "gpt-5.5[context=272k]"], "gpt-5.5", [])).toBe(
      "gpt-5.5[context=272k]",
    );
  });

  test("AC-8: an exact offer wins", () => {
    expect(resolveModelValue("cursor", ["default[]", "gpt-5.5"], "gpt-5.5", [])).toBe("gpt-5.5");
  });

  test("AC-9: several matches throw CAPABILITY_UNSUPPORTED model, naming each", () => {
    const err = sessionError(thrown(() => resolveModelValue("cursor", ["a[x=1]", "a[x=2]"], "a", [])));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "model" });
    expect(err.message).toContain("a[x=1]");
    expect(err.message).toContain("a[x=2]");
  });

  test("AC-10: no match returns the requested name, so the refusal still names it", () => {
    expect(resolveModelValue("cursor", ["default[]"], "gpt-5.5", [])).toBe("gpt-5.5");
  });

  test("AC-11: another agent's model is never rewritten", () => {
    expect(resolveModelValue("gemini", ["gpt-5.5[context=272k]"], "gpt-5.5", [])).toBe("gpt-5.5");
  });

  test("AC-12: a longer name that is not a settings suffix is not a match", () => {
    expect(resolveModelValue("cursor", ["gpt-5.5-mini[x=1]"], "gpt-5.5", [])).toBe("gpt-5.5");
  });

  test("AC-13: the refusal scrubs the session's secrets from the ids it names", () => {
    const err = sessionError(thrown(() => resolveModelValue("cursor", ["k[s=SECRET12]", "k[s=2]"], "k", ["SECRET12"])));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.message).not.toContain("SECRET12");
    expect(err.message).toContain("[REDACTED]");
  });
});

/** Cursor's legacy `models` block: the same ids, without config options. */
const CURSOR_SESSION_MODELS: Readonly<Record<string, unknown>> = {
  availableModels: [
    { modelId: "default[]", name: "Auto" },
    { modelId: "gpt-5.5[context=272k]", name: "GPT-5.5" },
  ],
  currentModelId: "default[]",
};

describe("a Cursor open applies the resolved model (US-001)", () => {
  test("AC-14: a bare model name is set through the model config option, with its settings", async () => {
    const o = await open("full", { model: "gpt-5.5", script: { configOptions: CURSOR_CONFIG_OPTIONS } });
    expect(o.session.backend.kind).toBe("acp:cursor");
    expect(configCalls(o)).toEqual([{ sessionId: AGENT_SESSION_ID, configId: "model", value: CURSOR_MODEL }]);
  });

  test("AC-15: a bare name matching several offered ids refuses the open, naming each match only", async () => {
    const { opened } = launched("full", {
      model: "claude-sonnet-5-5",
      script: { configOptions: CURSOR_CONFIG_OPTIONS },
    });
    const err = sessionError(await rejection(opened));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "model" });
    expect(err.message).toContain("claude-sonnet-5-5[context=300k,reasoning_effort=high]");
    expect(err.message).toContain("claude-sonnet-5-5[context=300k,reasoning_effort=low]");
    expect(err.message).not.toContain("default[]");
  });

  test("AC-16: the refused open kills the agent process once", async () => {
    const { fake, opened } = launched("full", {
      model: "claude-sonnet-5-5",
      script: { configOptions: CURSOR_CONFIG_OPTIONS },
    });
    await rejection(opened);
    expect(fake.kills()).toBe(1);
  });

  test("AC-17: with no config options, the resolved name is set through session/set_model", async () => {
    const o = await open("full", { model: "gpt-5.5", script: { models: CURSOR_SESSION_MODELS } });
    expect(setModels(o)).toEqual([{ sessionId: AGENT_SESSION_ID, modelId: "gpt-5.5[context=272k]" }]);
  });

  test("AC-20: Claude's exact model name is still set through its model config option", async () => {
    const o = await open("full", {
      agent: "claude",
      model: "sonnet",
      script: { configOptions: CLAUDE_CONFIG_OPTIONS },
    });
    expect(configCalls(o)).toContainEqual({ sessionId: AGENT_SESSION_ID, configId: "model", value: "sonnet" });
  });
});

describe("a Cursor read-only profile runs in its ask mode (US-001)", () => {
  test("AC-18: profile read sets mode ask exactly once", async () => {
    const o = await open("read", { script: { configOptions: CURSOR_CONFIG_OPTIONS } });
    expect(configCallsFor(o, ["mode"])).toEqual([{ sessionId: AGENT_SESSION_ID, configId: "mode", value: "ask" }]);
  });

  test("AC-19: profile full sets no mode at all", async () => {
    const o = await open("full", { script: { configOptions: CURSOR_CONFIG_OPTIONS } });
    expect(configCallsFor(o, ["mode"])).toEqual([]);
  });
});

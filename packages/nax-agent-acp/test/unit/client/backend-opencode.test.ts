import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type SandboxPolicy,
  type SessionBackend,
  type SessionEvent,
  type SessionSandbox,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { REVIEW_NO_SANDBOX_REASON, readOnlyReason } from "#src/client/permissions";
import { OPENCODE_NONE_CONFIG, OPENCODE_READ_CONFIG, OPENCODE_REVIEW_CONFIG } from "#src/client/registry";
import { opencodePermissionConfig } from "#src/client/rule-policy";
import { CODEX_CONFIG_OPTIONS, type FakeScript, type PermissionStep } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-opencode-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

/** opencode's session config as the fake offers it: its agents as a `mode` select nax must leave alone. */
const OPENCODE_CONFIG_OPTIONS: readonly SessionConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "build",
    options: [
      { value: "build", name: "Build" },
      { value: "plan", name: "Plan" },
    ],
  },
];

/** The facade supplies no sandbox (nax builds the BackendOpenContext itself), so a test that needs one attaches it here. */
function withSandbox(backend: SessionBackend, sandbox: SessionSandbox): SessionBackend {
  return { kind: backend.kind, open: (ctx) => backend.open({ ...ctx, sandbox }) };
}

interface OpenOptions {
  readonly agent?: AcpBackendOptions["agent"];
  readonly script?: FakeScript;
  readonly sandbox?: SessionSandbox;
  readonly tools?: readonly EmbedderTool[];
  /** The backend options' env (nax's model def env). */
  readonly env?: Readonly<Record<string, string>>;
  /** nax's permission rules, as nax passes them from the resolved stage permissions. */
  readonly rules?: AcpBackendOptions["rules"];
}

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

async function open(profile: AgentSessionProfile, options: OpenOptions = {}): Promise<Opened> {
  const agent = options.agent ?? "opencode";
  const fake = inMemoryAgent({
    agentInfo: { name: `${agent}-acp`, version: "1.0.0" },
    configOptions: agent === "codex" ? CODEX_CONFIG_OPTIONS : OPENCODE_CONFIG_OPTIONS,
    ...options.script,
  });
  _acpBackendDeps.launch = fake.launch;
  const backend = acpBackend({
    agent,
    allowUnsandboxed: true,
    command: `fake-${agent}`,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  const session = await createAgentSession({
    backend: options.sandbox === undefined ? backend : withSandbox(backend, options.sandbox),
    profile,
    workdir,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

/** The first launch request: what the agent process was started with. */
const launchEnv = (o: Opened) => o.fake.requests[0]?.env ?? {};

const modeCalls = (o: Opened) =>
  o.fake
    .callsTo("session/set_config_option")
    .filter((call) => (call as { readonly configId?: string }).configId === "mode");

const answers = (o: Opened) => o.fake.callsTo("permission-outcome");
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
/** Lets the backend observe the in-memory process exit. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A sandbox whose only write root is `root`: a policy only an agent with a pre-approval channel receives. */
const policyFor = (root: string): SandboxPolicy => ({ writeRoots: [root], denyWrite: [], denyRead: [], network: {} });

const EDIT: PermissionStep = { kind: "permission", options: ["allow_once", "reject_once"] };
const RUN: PermissionStep = {
  kind: "permission",
  options: ["allow_once", "reject_once"],
  toolCall: { kind: "execute", title: "Run tests", rawInput: { command: "bun test ./x" } },
};

/** nax's rule grammar: a Read deny rule denies every Read, Glob and Grep pattern alike. */
const readDenyRules = (): AcpBackendOptions["rules"] => ({
  allow: [],
  deny: [{ tool: "Read", patterns: ["*"] }],
  ask: [],
});

/** What opencode gets for a read profile once Read is denied outright: read and list drop out. */
const TRANSLATED_READ_CONFIG = opencodePermissionConfig("read", {
  allow: [],
  deny: [{ tool: "Read", patterns: ["*"] }],
  ask: [],
});

const LOOKUP: EmbedderTool = {
  name: "lookup",
  description: "Look a word up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  approval: "never",
  run: async () => ({ content: "found" }),
};

describe("opencode enforces none/read/review with an injected permission config (nax#2372)", () => {
  test("read opens and launches with the read permission config; no mode is set", async () => {
    const o = await open("read");
    expect(o.session.backend.kind).toBe("acp:opencode");
    expect(o.session.backend.capabilities).toMatchObject({ readOnlyMode: true, preApproval: false });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_READ_CONFIG);
    expect(modeCalls(o)).toEqual([]);
    expect(o.fake.callsTo("session/set_config_option")).toEqual([]);
    expect(o.fake.callsTo("session/new")).toHaveLength(1);
  });

  test.each([
    ["none", OPENCODE_NONE_CONFIG],
    ["review", OPENCODE_REVIEW_CONFIG],
  ] as const)("%s launches with its own permission config", async (profile, expected) => {
    const o = await open(profile);
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(expected);
    expect(modeCalls(o)).toEqual([]);
  });

  test("full: no policy is injected when the caller sets none", async () => {
    const o = await open("full");
    expect(Object.hasOwn(launchEnv(o), "OPENCODE_CONFIG_CONTENT")).toBe(false);
    expect(o.fake.requests[0]?.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  test("read: the enforcement value wins over the caller's own OPENCODE_CONFIG_CONTENT", async () => {
    const o = await open("read", { env: { OPENCODE_CONFIG_CONTENT: "{}" } });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_READ_CONFIG);
  });

  test("full: the caller's own OPENCODE_CONFIG_CONTENT is passed through unchanged", async () => {
    const o = await open("full", { env: { OPENCODE_CONFIG_CONTENT: "{}" } });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe("{}");
  });
});

describe("opencode's launch env is translated from the caller's read-tool deny rules (SPEC US-002)", () => {
  test("read with a Read deny rule launches with the translated permission config", async () => {
    const o = await open("read", { rules: readDenyRules() });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(TRANSLATED_READ_CONFIG);
    // The translation really happened: read and list are gone, glob and grep stay.
    expect(TRANSLATED_READ_CONFIG).not.toBe(OPENCODE_READ_CONFIG);
    expect(JSON.parse(TRANSLATED_READ_CONFIG).permission).toEqual({ "*": "deny", glob: "allow", grep: "allow" });
  });

  test("read: a path-scoped or non-read rule changes nothing", async () => {
    const o = await open("read", {
      rules: { allow: [{ tool: "Read", patterns: ["*"] }], deny: [{ tool: "Grep", patterns: ["src/**"] }], ask: [] },
    });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_READ_CONFIG);
  });

  test("read: the translated value beats the caller's own OPENCODE_CONFIG_CONTENT", async () => {
    const o = await open("read", { env: { OPENCODE_CONFIG_CONTENT: "{}" }, rules: readDenyRules() });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(TRANSLATED_READ_CONFIG);
  });

  test.each(["full", "ask"] as const)("%s: no enforcement env at all, whatever the rules", async (profile) => {
    const o = await open(profile, { rules: readDenyRules() });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  test("none: a read-tool deny rule changes nothing (every tool is already denied)", async () => {
    const o = await open("none", { rules: readDenyRules() });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_NONE_CONFIG);
  });

  test("review: a Read deny rule drops read and list, keeping the asking shell", async () => {
    const o = await open("review", { rules: readDenyRules() });
    expect(JSON.parse(launchEnv(o).OPENCODE_CONFIG_CONTENT ?? "").permission).toEqual({
      "*": "deny",
      glob: "allow",
      grep: "allow",
      bash: "ask",
    });
  });
});

describe("the injected permission config survives a reconnect (S4-6 D6-g)", () => {
  const RESUMABLE: FakeScript = {
    agentInfo: { name: "opencode-acp", version: "2.0.27" },
    configOptions: OPENCODE_CONFIG_OPTIONS,
    capabilities: { sessionCapabilities: { resume: {} } },
  };

  test("read: the relaunch after a crash carries the same permission config", async () => {
    const o = await open("read", {
      script: { ...RESUMABLE, relaunch: { turns: [{ steps: [{ kind: "text", text: "back" }] }] } },
    });
    await driveTurn(o.session, "one");
    o.fake.crash();
    await tick();
    expect(endOf(await driveTurn(o.session, "two"))).toMatchObject({ status: "completed", output: "back" });
    expect(o.fake.requests).toHaveLength(2);
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_READ_CONFIG);
    expect(o.fake.requests[1]?.env.OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_READ_CONFIG);
  });

  test("read with a Read deny rule: the relaunch carries the translated permission config (SPEC US-002)", async () => {
    const o = await open("read", {
      rules: readDenyRules(),
      script: { ...RESUMABLE, relaunch: { turns: [{ steps: [{ kind: "text", text: "back" }] }] } },
    });
    await driveTurn(o.session, "one");
    o.fake.crash();
    await tick();
    expect(endOf(await driveTurn(o.session, "two"))).toMatchObject({ status: "completed", output: "back" });
    expect(o.fake.requests).toHaveLength(2);
    expect(o.fake.requests[0]?.env.OPENCODE_CONFIG_CONTENT).toBe(TRANSLATED_READ_CONFIG);
    expect(o.fake.requests[1]?.env.OPENCODE_CONFIG_CONTENT).toBe(TRANSLATED_READ_CONFIG);
  });
});

describe("opencode permissions are decided by profile, and it never receives the embedder sandbox", () => {
  test("review with a policy sandbox denies an execute request (REVIEW_NO_SANDBOX_REASON)", async () => {
    const o = await open("review", {
      sandbox: { kind: "policy", policy: policyFor(workdir) },
      script: { turns: [{ steps: [RUN] }] },
    });
    const events = await driveTurn(o.session, "run it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ tool: "execute", reason: REVIEW_NO_SANDBOX_REASON });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
  });

  test("read rejects a file edit with the read-only reason", async () => {
    const o = await open("read", { script: { turns: [{ steps: [EDIT] }] } });
    const events = await driveTurn(o.session, "edit it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: readOnlyReason("read") });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
  });
});

describe("opencode's capability boundary (nax#2372)", () => {
  test("read with one embedder tool is refused: opencode has no pre-approval channel", async () => {
    const fake = inMemoryAgent({
      configOptions: OPENCODE_CONFIG_OPTIONS,
      capabilities: { mcpCapabilities: { http: true } },
    });
    _acpBackendDeps.launch = fake.launch;
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({ agent: "opencode", allowUnsandboxed: true, command: "fake-opencode" }),
          profile: "read",
          workdir,
          tools: [LOOKUP],
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "tools" });
    expect(fake.kills()).toBe(1);
  });

  test("codex is unaffected: no injected permission config, still its own read-only mode", async () => {
    const o = await open("read", { agent: "codex" });
    expect(o.fake.requests[0]?.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "read-only" },
    ]);
    expect(modeCalls(o)).toHaveLength(1);
  });
});

describe("opencode's failure-handling table (nax#2372)", () => {
  test.each([
    ["none", OPENCODE_NONE_CONFIG],
    ["review", OPENCODE_REVIEW_CONFIG],
  ] as const)("%s: the enforcement value replaces a caller's OPENCODE_CONFIG_CONTENT", async (profile, expected) => {
    const o = await open(profile, { env: { OPENCODE_CONFIG_CONTENT: "{}" } });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe(expected);
  });

  test("ask: the caller's OPENCODE_CONFIG_CONTENT is passed through unchanged", async () => {
    const o = await open("ask", { env: { OPENCODE_CONFIG_CONTENT: "{}" } });
    expect(launchEnv(o).OPENCODE_CONFIG_CONTENT).toBe("{}");
  });
});

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
import { FULL_REASON, REVIEW_EXECUTE_REASON, REVIEW_NO_SANDBOX_REASON, readOnlyReason } from "#src/client/permissions";
import { DENIED_CONTINUATION_PROMPT, MAX_DENIED_CONTINUATIONS } from "#src/client/turn";
import {
  CLAUDE_CONFIG_OPTIONS,
  CODEX_CONFIG_OPTIONS,
  type FakeScript,
  type PermissionStep,
} from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

/** Ambient secret-named env vars, held out of the resolved agent env so suites stay hermetic (env.ts SECRET_KEY). */
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const ambientEnv: [string, string][] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-codex-");
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SECRET_KEY.test(key)) {
      ambientEnv.push([key, value]);
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
  for (const [key, value] of ambientEnv.splice(0)) process.env[key] = value;
});

/**
 * The facade supplies no sandbox (nax builds the BackendOpenContext itself), so a
 * test that needs one attaches it here: the backend still sees the real ctx it
 * would receive from nax, plus the sandbox under test.
 */
function withSandbox(backend: SessionBackend, sandbox: SessionSandbox): SessionBackend {
  return { kind: backend.kind, open: (ctx) => backend.open({ ...ctx, sandbox }) };
}

interface OpenOptions {
  readonly agent?: AcpBackendOptions["agent"];
  readonly script?: FakeScript;
  readonly sandbox?: SessionSandbox;
  readonly tools?: readonly EmbedderTool[];
}

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

async function open(profile: AgentSessionProfile, options: OpenOptions = {}): Promise<Opened> {
  const agent = options.agent ?? "codex";
  const fake = inMemoryAgent({
    agentInfo: { name: `${agent}-acp`, version: "1.0.0" },
    // Claude's own mode ids; every other agent here speaks codex's mode option.
    configOptions: agent === "claude" ? CLAUDE_CONFIG_OPTIONS : CODEX_CONFIG_OPTIONS,
    ...options.script,
  });
  _acpBackendDeps.launch = fake.launch;
  const backend = acpBackend({ agent, allowUnsandboxed: true, command: "fake-agent" });
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

/** A sandbox whose only write root is `root`: a policy Claude's R4 path check would act on. */
const policyFor = (root: string): SandboxPolicy => ({ writeRoots: [root], denyWrite: [], denyRead: [], network: {} });
const UNAVAILABLE: SessionSandbox = { kind: "unavailable", reason: "no bwrap on this host" };

const EDIT: PermissionStep = { kind: "permission", options: ["allow_once", "reject_once"] };
const RUN: PermissionStep = {
  kind: "permission",
  options: ["allow_once", "reject_once"],
  toolCall: { kind: "execute", title: "Run tests", rawInput: { command: "bun test ./x" } },
};
const OUTSIDE_EDIT: PermissionStep = {
  kind: "permission",
  options: ["allow_once", "reject_once"],
  toolCall: { kind: "edit", title: "Edit outside", rawInput: { file_path: "/etc/hosts" } },
};

const answers = (o: Opened) => o.fake.callsTo("permission-outcome");
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
const modeCalls = (o: Opened) =>
  o.fake
    .callsTo("session/set_config_option")
    .filter((call) => (call as { readonly configId?: string }).configId === "mode");

const LOOKUP: EmbedderTool = {
  name: "lookup",
  description: "Look a word up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  approval: "never",
  run: async () => ({ content: "found" }),
};

describe("codex runs the read-only profiles on its own read-only mode (nax#2372)", () => {
  test("read: opens and sets the mode once, to read-only", async () => {
    const o = await open("read");
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "read-only" },
    ]);
    expect(o.session.backend.capabilities).toMatchObject({ readOnlyMode: true, preApproval: false });
  });

  test("full: keeps codex's launch mode (no mode set_config_option)", async () => {
    const o = await open("full");
    expect(modeCalls(o)).toEqual([]);
    expect(o.fake.callsTo("session/set_config_option")).toEqual([]);
  });

  test("read: session/new carries no MCP server and no _meta", async () => {
    const o = await open("read");
    const [created] = o.fake.callsTo("session/new") as { mcpServers: unknown; _meta?: unknown }[];
    expect(created?.mcpServers).toEqual([]);
    expect(created !== undefined && "_meta" in created).toBe(false);
  });

  test.each(["review", "full"] as const)("%s with an unavailable sandbox opens anyway", async (profile) => {
    const o = await open(profile, { sandbox: UNAVAILABLE });
    expect(o.session.backend.kind).toBe("acp:codex");
    expect(o.fake.callsTo("session/new")).toHaveLength(1);
  });

  test("review with a policy sandbox still denies an execute request: the sandbox never reaches codex", async () => {
    const o = await open("review", {
      sandbox: { kind: "policy", policy: policyFor(workdir) },
      script: { turns: [{ steps: [RUN] }] },
    });
    const events = await driveTurn(o.session, "run it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ tool: "execute", reason: REVIEW_NO_SANDBOX_REASON });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
  });

  test("read: a file edit is rejected with the read-only reason", async () => {
    const o = await open("read", { script: { turns: [{ steps: [EDIT] }] } });
    const events = await driveTurn(o.session, "edit it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: readOnlyReason("read") });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
  });

  test("full with a policy sandbox allows an edit outside the workdir: no write-root check for codex", async () => {
    const o = await open("full", {
      sandbox: { kind: "policy", policy: policyFor(workdir) },
      script: { turns: [{ steps: [OUTSIDE_EDIT] }] },
    });
    const events = await driveTurn(o.session, "edit outside");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ tool: "edit", reason: FULL_REASON });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "profile" });
  });

  test("read when the agent offers no read-only mode value: refused, capability profile, process killed", async () => {
    const NO_READ_ONLY: readonly SessionConfigOption[] = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "agent",
        options: [{ value: "agent", name: "Agent" }],
      },
    ];
    const fake = inMemoryAgent({ configOptions: NO_READ_ONLY });
    _acpBackendDeps.launch = fake.launch;
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({ agent: "codex", allowUnsandboxed: true, command: "fake-codex" }),
          profile: "read",
          workdir,
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "profile" });
    // The refusal is the mode one: the session was created, then the mode could not be set.
    expect(fake.callsTo("session/new")).toHaveLength(1);
    expect(fake.callsTo("session/set_config_option")).toEqual([]);
    expect(fake.kills()).toBe(1);
  });

  test("read with an embedder tool opens: one http MCP server, no _meta (codex has no pre-approval channel)", async () => {
    const o = await open("read", {
      tools: [LOOKUP],
      script: { capabilities: { mcpCapabilities: { http: true } } },
    });
    const [created] = o.fake.callsTo("session/new") as { mcpServers: { type: string }[]; _meta?: unknown }[];
    expect(created?.mcpServers.map((server) => server.type)).toEqual(["http"]);
    expect(created !== undefined && "_meta" in created).toBe(false);
  });
});

describe("a deny that makes the agent cancel its turn is continued (nax#2582)", () => {
  /** codex-acp's sandbox escalation: its only reject_once option is `cancel`, which stops the turn. */
  const DENIED_THEN_CANCELLED = {
    steps: [{ kind: "text", text: "trying " }, RUN],
    stopReason: "cancelled",
    usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
  } as const;
  const prompts = (o: Opened) => o.fake.callsTo("session/prompt") as { prompt: { text: string }[] }[];

  test("read: the turn continues with one follow-up prompt, completes, and reports both prompts' tokens", async () => {
    const o = await open("read", {
      script: {
        turns: [
          DENIED_THEN_CANCELLED,
          {
            steps: [{ kind: "text", text: "done without it" }],
            usage: { totalTokens: 7, inputTokens: 4, outputTokens: 3, cachedReadTokens: 2 },
          },
        ],
      },
    });
    const events = await driveTurn(o.session, "write a file");
    expect(prompts(o).map((p) => p.prompt[0]?.text)).toEqual([
      expect.stringContaining("write a file"),
      DENIED_CONTINUATION_PROMPT,
    ]);
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
    expect(endOf(events)).toMatchObject({
      status: "completed",
      output: "trying done without it",
      usage: { inputTokens: 14, outputTokens: 8, cacheReadTokens: 2 },
    });
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  test("review: a denied execute request that cancels the turn is continued too", async () => {
    const o = await open("review", {
      script: { turns: [DENIED_THEN_CANCELLED, { steps: [{ kind: "text", text: "reviewed" }] }] },
    });
    expect(endOf(await driveTurn(o.session, "review it"))).toMatchObject({ status: "completed" });
    expect(prompts(o)).toHaveLength(2);
  });

  test("a denied request is work: an empty, unpriced continuation still completes (nax#2591)", async () => {
    const o = await open("read", {
      script: { turns: [{ steps: [RUN], stopReason: "cancelled" }, { steps: [] }] },
    });
    expect(endOf(await driveTurn(o.session, "write a file"))).toMatchObject({ status: "completed", output: "" });
    expect(prompts(o)).toHaveLength(2);
  });

  test(`bounded: after ${MAX_DENIED_CONTINUATIONS} continuations the turn ends ACP_STOP_CANCELLED`, async () => {
    const o = await open("read", { script: { turns: [DENIED_THEN_CANCELLED] } });
    const events = await driveTurn(o.session, "write a file");
    expect(endOf(events)).toMatchObject({ status: "errored", error: { code: "ACP_STOP_CANCELLED" } });
    expect(prompts(o)).toHaveLength(1 + MAX_DENIED_CONTINUATIONS);
  });

  test("the bound is per turn: the next turn starts with a fresh count", async () => {
    const o = await open("read", {
      script: {
        turns: [
          ...Array.from({ length: 1 + MAX_DENIED_CONTINUATIONS }, () => DENIED_THEN_CANCELLED),
          DENIED_THEN_CANCELLED,
          { steps: [{ kind: "text", text: "ok" }] },
        ],
      },
    });
    expect(endOf(await driveTurn(o.session, "one"))).toMatchObject({ status: "errored" });
    expect(endOf(await driveTurn(o.session, "two"))).toMatchObject({ status: "completed" });
  });

  test("a cancelled stop with no denial is not continued", async () => {
    const o = await open("read", {
      script: { turns: [{ steps: [{ kind: "text", text: "x" }], stopReason: "cancelled" }] },
    });
    expect(endOf(await driveTurn(o.session, "go"))).toMatchObject({
      status: "errored",
      error: { code: "ACP_STOP_CANCELLED" },
    });
    expect(prompts(o)).toHaveLength(1);
  });

  test("a cancelled stop after an allowed request is not continued", async () => {
    const o = await open("full", {
      script: { turns: [{ steps: [RUN], stopReason: "cancelled" }] },
    });
    expect(endOf(await driveTurn(o.session, "go"))).toMatchObject({ error: { code: "ACP_STOP_CANCELLED" } });
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(prompts(o)).toHaveLength(1);
  });

  test("a caller cancel during the continuation: cancelled, with both prompts' tokens", async () => {
    const o = await open("read", {
      script: {
        turns: [
          DENIED_THEN_CANCELLED,
          {
            steps: [{ kind: "awaitCancel" }],
            stopReason: "cancelled",
            usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 },
          },
        ],
      },
    });
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "approval_resolved") setTimeout(() => o.session.cancel(), 20);
    });
    expect(prompts(o)).toHaveLength(2);
    expect(endOf(events)).toMatchObject({ status: "cancelled", usage: { inputTokens: 12, outputTokens: 6 } });
  });

  test("a failed continuation prompt: errored, keeping the first prompt's tokens", async () => {
    const o = await open("read", {
      script: {
        turns: [DENIED_THEN_CANCELLED, { steps: [{ kind: "fail", failure: { code: -32603, message: "overloaded" } }] }],
      },
    });
    const events = await driveTurn(o.session, "go");
    expect(endOf(events)).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_TURN_FAILED" },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  test("a turn the caller cancels after a denial is not continued", async () => {
    const o = await open("read", {
      script: { turns: [{ steps: [EDIT, { kind: "awaitCancel" }], stopReason: "cancelled" }] },
    });
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "approval_resolved") o.session.cancel();
    });
    expect(endOf(events)).toMatchObject({ status: "cancelled" });
    expect(prompts(o)).toHaveLength(1);
  });
});

describe("Claude keeps the embedder sandbox (nax#2500, unchanged)", () => {
  test.each([true, false])("AC-14/15 full report edit with exemption=%s", async (exempt) => {
    const report = `${workdir}/.nax/features/f/workflow/r/US-005/report.md`;
    const policy = { ...policyFor(workdir), denyWrite: [`${workdir}/.nax/features`] };
    const o = await open("full", {
      agent: "claude",
      sandbox: { kind: "policy", policy, ...(exempt ? { writeExemption: report } : {}) },
      script: {
        turns: [
          {
            steps: [
              {
                ...EDIT,
                toolCall: {
                  kind: "edit",
                  title: "Write report",
                  rawInput: { file_path: report },
                },
              },
            ],
          },
        ],
      },
    });
    await driveTurn(o.session, "write the report");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: exempt ? "opt-allow_once" : "opt-reject_once" }]);
  });

  test("AC-21 full with unavailable sandbox refuses before opening", async () => {
    const err = sessionError(
      await rejection(open("full", { agent: "claude", sandbox: { kind: "unavailable", reason: "no bwrap" } })),
    );
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "profile" });
  });
  test("review with a policy sandbox allows an execute request once", async () => {
    const o = await open("review", {
      agent: "claude",
      sandbox: { kind: "policy", policy: policyFor(workdir) },
      script: { turns: [{ steps: [RUN] }] },
    });
    const events = await driveTurn(o.session, "run it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ tool: "execute", reason: REVIEW_EXECUTE_REASON });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "profile" });
  });

  test("review with an unavailable sandbox is still refused with capability profile", async () => {
    const err = sessionError(await rejection(open("review", { agent: "claude", sandbox: UNAVAILABLE })));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "profile" });
  });
});

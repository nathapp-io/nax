/**
 * review with no sandbox: the operator's Bash rules decide ACP shell commands
 * (SPEC-cursor-pi-acp-read-only US-003). The seam is `createAgentSession` with
 * `acpBackend({ agent, rules })` at profile `review`, a fake turn that sends one
 * permission request; the recorded answer and the `approval_requested` reason are
 * what the operator's configuration actually buys.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
  type SandboxPolicy,
  type SessionBackend,
  type SessionEvent,
  type SessionSandbox,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import {
  NO_ALLOW_ONCE_REASON,
  REVIEW_EXECUTE_REASON,
  REVIEW_NO_SANDBOX_REASON,
  readOnlyReason,
} from "#src/client/permissions";
import { SHELL_RULE_REASON } from "#src/client/shell-rules";
import {
  CLAUDE_CONFIG_OPTIONS,
  CURSOR_CONFIG_OPTIONS,
  type FakeScript,
  type PermissionStep,
} from "#test/fixtures/fake-agent/script";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-shell-rules-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

/** nax's rule grammar, as nax passes it from the resolved stage permissions. */
const bashAllow = (patterns: readonly string[]): AcpBackendOptions["rules"] => ({
  allow: [{ tool: "Bash", patterns }],
  deny: [],
  ask: [],
});

const configOptionsFor = (agent: string): readonly SessionConfigOption[] => {
  if (agent === "claude") return CLAUDE_CONFIG_OPTIONS;
  if (agent === "cursor") return CURSOR_CONFIG_OPTIONS;
  return [];
};

/** The facade supplies no sandbox (nax builds the BackendOpenContext itself), so a test that needs one attaches it here. */
function withSandbox(backend: SessionBackend, sandbox: SessionSandbox): SessionBackend {
  return { kind: backend.kind, open: (ctx) => backend.open({ ...ctx, sandbox }) };
}

interface OpenOptions {
  readonly agent?: AcpBackendOptions["agent"];
  readonly script?: FakeScript;
  readonly sandbox?: SessionSandbox;
  readonly rules?: AcpBackendOptions["rules"];
}

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

async function open(profile: AgentSessionProfile, options: OpenOptions = {}): Promise<Opened> {
  const agent = options.agent ?? "opencode";
  const agentName = typeof agent === "string" ? agent : agent.name;
  const fake = inMemoryAgent({
    agentInfo: { name: `${agentName}-acp`, version: "1.0.0" },
    configOptions: configOptionsFor(agentName),
    ...options.script,
  });
  _acpBackendDeps.launch = fake.launch;
  const backend = acpBackend({
    agent,
    allowUnsandboxed: true,
    command: `fake-${agent}`,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  const session = await createAgentSession({
    backend: options.sandbox === undefined ? backend : withSandbox(backend, options.sandbox),
    profile,
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

const answers = (o: Opened) => o.fake.callsTo("permission-outcome");
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);

/** One execute permission request for `command`, as opencode and Cursor send it. */
const executeStep = (
  toolCall: PermissionStep["toolCall"],
  options: PermissionStep["options"] = ["allow_once", "reject_once"],
): PermissionStep => ({ kind: "permission", options, toolCall });

const GIT_STATUS = executeStep({ kind: "execute", title: "git status", rawInput: { command: "git status --short" } });

const EDIT = executeStep({ kind: "edit", title: "Edit a.ts" });

const script = (...steps: PermissionStep[]): FakeScript => ({ turns: [{ steps }] });

/** A sandbox whose only write root is `root`. */
const policyFor = (root: string): SandboxPolicy => ({ writeRoots: [root], denyWrite: [], denyRead: [], network: {} });

const ALLOW_ONCE = { outcome: "selected", optionId: "opt-allow_once" };
const REJECT_ONCE = { outcome: "selected", optionId: "opt-reject_once" };

describe("review without a sandbox: an operator Bash rule allows the command (AC-19, AC-20)", () => {
  test("AC-19 and AC-20: opencode's git status is allowed, with the rule's reason", async () => {
    const o = await open("review", { rules: bashAllow(["git status*"]), script: script(GIT_STATUS) });
    const events = await driveTurn(o.session, "check the tree");
    expect(answers(o)).toEqual([ALLOW_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ tool: "execute", reason: SHELL_RULE_REASON });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "profile" });
  });
});

describe("review without a sandbox: everything else stays denied (AC-21, AC-22, AC-25, AC-26)", () => {
  test("AC-21: a redirect is denied with the review reason", async () => {
    const o = await open("review", {
      rules: bashAllow(["git status*"]),
      script: script(
        executeStep({ kind: "execute", title: "git status", rawInput: { command: "git status --short > out.txt" } }),
      ),
    });
    const events = await driveTurn(o.session, "write it");
    expect(answers(o)).toEqual([REJECT_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: REVIEW_NO_SANDBOX_REASON });
  });

  test("AC-22: with no rules the same request is denied as before", async () => {
    const o = await open("review", { script: script(GIT_STATUS) });
    const events = await driveTurn(o.session, "check the tree");
    expect(answers(o)).toEqual([REJECT_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: REVIEW_NO_SANDBOX_REASON });
  });

  test("AC-25: an unconditional Bash allow does not make an edit decidable", async () => {
    const o = await open("review", { rules: bashAllow(["*"]), script: script(EDIT) });
    const events = await driveTurn(o.session, "edit it");
    expect(answers(o)).toEqual([REJECT_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: readOnlyReason("review") });
  });

  test("AC-26: an allow verdict with no allow-once option is denied as today", async () => {
    const o = await open("review", {
      rules: bashAllow(["git status*"]),
      script: script(executeStep(GIT_STATUS.toolCall, ["reject_once"])),
    });
    const events = await driveTurn(o.session, "check the tree");
    expect(answers(o)).toEqual([REJECT_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: NO_ALLOW_ONCE_REASON });
  });
});

describe("read keeps its own refusal, whatever the rules say (AC-23)", () => {
  test("AC-23: the same allow rule does not survive into a read profile", async () => {
    const o = await open("read", { rules: bashAllow(["git status*"]), script: script(GIT_STATUS) });
    const events = await driveTurn(o.session, "check the tree");
    expect(answers(o)).toEqual([REJECT_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: readOnlyReason("read") });
  });
});

describe("Cursor carries its command in the title (AC-24)", () => {
  test("AC-24: the backticked title is adjudicated", async () => {
    const o = await open("review", {
      agent: "cursor",
      rules: bashAllow(["git status*"]),
      script: script(executeStep({ kind: "execute", title: "`git status --short`" })),
    });
    const events = await driveTurn(o.session, "check the tree");
    expect(answers(o)).toEqual([ALLOW_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: SHELL_RULE_REASON });
  });
});

describe("a sandbox still decides on its own (AC-35)", () => {
  test("AC-35: a Claude review session with a policy and no rules allows the command", async () => {
    const o = await open("review", {
      agent: "claude",
      sandbox: { kind: "policy", policy: policyFor(workdir) },
      script: script(GIT_STATUS),
    });
    const events = await driveTurn(o.session, "check the tree");
    expect(answers(o)).toEqual([ALLOW_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: REVIEW_EXECUTE_REASON });
  });
});

describe("the lexer's refusals survive all the way to the answer (AC-37)", () => {
  test.each([
    ["a command substitution", "echo $(cat secret)"],
    ["a redirect", "echo hi > shell.txt"],
    ["an opaque token", "echo $HOME"],
  ])("AC-37: %s is denied with the review reason under an unconditional Bash allow", async (_label, command) => {
    const o = await open("review", {
      rules: bashAllow(["*"]),
      script: script(executeStep({ kind: "execute", title: "shell", rawInput: { command } })),
    });
    const events = await driveTurn(o.session, "run it");
    expect(answers(o)).toEqual([REJECT_ONCE]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: REVIEW_NO_SANDBOX_REASON });
  });
});

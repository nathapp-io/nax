/**
 * Cursor's and pi's read-only enforcement runs through files nax writes before it
 * spawns anything (SPEC-cursor-pi-acp-read-only US-004). Cursor gets an isolated
 * `cli-config.json` named by `CURSOR_CONFIG_DIR` (its own modes enforce nothing);
 * pi gets a wrapper named by `PI_ACP_PI_COMMAND` that runs it with the profile's
 * `--tools` and, under review, the shell gate extension nax also writes. The seam
 * is `createAgentSession` with `acpBackend({ agent, rules, stateDir })`: the
 * recorded launch env, the files on disk and the pi gate's permission round trip
 * are what the operator's configuration actually buys.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { REVIEW_NO_SANDBOX_REASON } from "#src/client/permissions";
import { writeCursorPolicy, writePiFile } from "#src/client/policy-files";
import { type AcpPermissionRules, cursorCliConfig, NO_RULES } from "#src/client/rule-policy";
import { PI_SHELL_GATE_SOURCE, PI_SHELL_GATE_TITLE, SHELL_RULE_REASON } from "#src/client/shell-rules";
import { CURSOR_CONFIG_OPTIONS, type FakeScript, type PermissionStep } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { stubPolicyDeps } from "#test/helpers/policy-deps";
import { driveTurn } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;
let stateDir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-policy-");
  stateDir = makeTempDir("acp-policy-state-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
  cleanupTempDir(stateDir);
});

/** A Read deny rule: under read and review Cursor's allowance is removed and pi loses the read tool. */
const READ_DENY: AcpPermissionRules = { allow: [], deny: [{ tool: "Read", patterns: ["*"] }], ask: [] };

const bashAllow = (patterns: readonly string[]): AcpPermissionRules => ({
  allow: [{ tool: "Bash", patterns }],
  deny: [],
  ask: [],
});

/** pi's read wrapper exactly as the spec spells it, and what its content hashes to. */
const PI_READ_WRAPPER = "#!/bin/sh\nexec 'pi' '--tools' 'read,grep,find,ls' \"$@\"\n";

function hash16(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** The Cursor config path a failing write names. */
const cursorConfigPath = (): string => join(stateDir, "cursor", hash16(cursorCliConfig("read", READ_DENY)));

interface OpenOptions {
  readonly agent?: AcpBackendOptions["agent"];
  readonly script?: FakeScript;
  readonly env?: Readonly<Record<string, string>>;
  readonly rules?: AcpBackendOptions["rules"];
}

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

/** A fake process for one open; the caller decides whether the open is awaited (a refusal rejects). */
function launched(profile: AgentSessionProfile, options: OpenOptions = {}) {
  const agent = options.agent ?? "cursor";
  const name = typeof agent === "string" ? agent : agent.name;
  const fake = inMemoryAgent({
    agentInfo: { name: `${name}-acp`, version: "1.0.0" },
    // Cursor's read-only profiles go through its `ask` mode, so the fake must offer it.
    ...(name === "cursor" ? { configOptions: CURSOR_CONFIG_OPTIONS } : {}),
    ...options.script,
  });
  _acpBackendDeps.launch = fake.launch;
  const backend = acpBackend({
    agent,
    allowUnsandboxed: true,
    command: `fake-${name}`,
    stateDir,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const opened = createAgentSession({
    backend,
    profile,
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  return { fake, opened };
}

/** An open the test expects to succeed. */
async function open(profile: AgentSessionProfile, options: OpenOptions = {}): Promise<Opened> {
  const { fake, opened } = launched(profile, options);
  const session = await opened;
  sessions.push(session);
  return { fake, session };
}

/** The first launch request: what the agent process was started with. */
const launchEnv = (o: Opened) => o.fake.requests[0]?.env ?? {};
const answers = (o: Opened) => o.fake.callsTo("permission-outcome");
const mode = (path: string): Promise<number> => stat(path).then((s) => s.mode & 0o777);

describe("Cursor's read-only profile launches with its isolated config (AC-18)", () => {
  test("AC-18: CURSOR_CONFIG_DIR is the directory holding the translated config", async () => {
    const o = await open("read", { rules: READ_DENY });
    const content = cursorCliConfig("read", READ_DENY);
    const dir = await writeCursorPolicy(stateDir, content);
    expect(launchEnv(o).CURSOR_CONFIG_DIR).toBe(dir);
    // Really on disk, with the translated config, readable by its owner alone.
    expect(JSON.parse(await readFile(join(dir, "cli-config.json"), "utf8"))).toEqual(JSON.parse(content));
    expect(await mode(join(dir, "cli-config.json"))).toBe(0o600);
    expect(await mode(dir)).toBe(0o700);
  });
});

describe("pi's read profile launches with its own tool allowlist (AC-19, AC-20, AC-21)", () => {
  test("AC-19: a pi read open is no longer refused a profile", async () => {
    const o = await open("read", { agent: "pi" });
    expect(o.session.backend.kind).toBe("acp:pi");
    expect(o.session.backend.capabilities).toMatchObject({ readOnlyMode: true });
  });

  test("AC-20: PI_ACP_PI_COMMAND is the wrapper that runs pi with the read tools", async () => {
    const o = await open("read", { agent: "pi" });
    const wrapper = await writePiFile(stateDir, "wrapper", PI_READ_WRAPPER, 0o700);
    expect(launchEnv(o).PI_ACP_PI_COMMAND).toBe(wrapper);
    expect(await readFile(wrapper, "utf8")).toBe(PI_READ_WRAPPER);
    expect(await mode(wrapper)).toBe(0o700);
  });

  test("AC-21: the caller's own pi executable is wrapped, quoted for sh", async () => {
    const o = await open("read", { agent: "pi", env: { PI_ACP_PI_COMMAND: "/opt/it's/pi" } });
    const body = "#!/bin/sh\nexec '/opt/it'\\''s/pi' '--tools' 'read,grep,find,ls' \"$@\"\n";
    const wrapper = await writePiFile(stateDir, "wrapper", body, 0o700);
    expect(launchEnv(o).PI_ACP_PI_COMMAND).toBe(wrapper);
    expect(await readFile(wrapper, "utf8")).toBe(body);
  });
});

describe("pi's review profile runs every command through nax's gate (AC-22)", () => {
  test("AC-22: the gate extension is written first, then the wrapper that loads it with bash", async () => {
    const o = await open("review", { agent: "pi", rules: bashAllow(["ls *"]) });
    const gate = await writePiFile(stateDir, "shell-gate", PI_SHELL_GATE_SOURCE, 0o600);
    const args = ["-e", gate, "--tools", "read,grep,find,ls,bash"];
    const body = `#!/bin/sh\nexec 'pi' ${args.map((word) => `'${word}'`).join(" ")} "$@"\n`;
    expect(launchEnv(o).PI_ACP_PI_COMMAND).toBe(await writePiFile(stateDir, "wrapper", body, 0o700));
    expect(await readFile(gate, "utf8")).toBe(PI_SHELL_GATE_SOURCE);
    expect(await mode(gate)).toBe(0o600);
  });
});

describe("full adds no policy file and no enforcement env (AC-23, AC-24)", () => {
  test("AC-23: a Cursor and a pi full launch add neither variable", async () => {
    const cursor = await open("full", { env: {} });
    expect(Object.hasOwn(launchEnv(cursor), "CURSOR_CONFIG_DIR")).toBe(false);
    const pi = await open("full", { agent: "pi", env: {} });
    expect(Object.hasOwn(launchEnv(pi), "PI_ACP_PI_COMMAND")).toBe(false);
  });

  test("AC-24: full records no policy-file call at all", async () => {
    const recorder = stubPolicyDeps();
    try {
      await open("full");
      await open("full", { agent: "pi" });
      expect(recorder.io).toEqual([]);
    } finally {
      recorder.restore();
    }
  });
});

describe("a policy file that cannot be written refuses the open (AC-25 to AC-28, AC-34 to AC-36)", () => {
  test("AC-25 and AC-26: a rejecting mkdir refuses Cursor's open, and nothing is launched", async () => {
    const recorder = stubPolicyDeps("mkdir");
    try {
      const { fake, opened } = launched("read", { rules: READ_DENY });
      const err = sessionError(await rejection(opened));
      expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
      expect(fake.requests).toEqual([]);
    } finally {
      recorder.restore();
    }
  });

  test("AC-27 and AC-28: a rejecting rename refuses pi's open, and nothing is launched", async () => {
    const recorder = stubPolicyDeps("rename");
    try {
      const { fake, opened } = launched("read", { agent: "pi" });
      const err = sessionError(await rejection(opened));
      expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
      expect(fake.requests).toEqual([]);
    } finally {
      recorder.restore();
    }
  });

  test.each(["mkdir", "writeFile", "chmod", "rename"] as const)(
    "AC-34 to AC-36: a rejecting %s refuses both agents' opens, names the path and launches nothing",
    async (op) => {
      const recorder = stubPolicyDeps(op);
      try {
        const cursor = launched("read", { rules: READ_DENY });
        const cursorErr = sessionError(await rejection(cursor.opened));
        expect(cursorErr.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
        expect(cursorErr.message).toContain(cursorConfigPath());
        expect(cursor.fake.requests).toEqual([]);

        const pi = launched("read", { agent: "pi" });
        const piErr = sessionError(await rejection(pi.opened));
        const piWrapper = join(stateDir, "pi", `wrapper-${hash16(PI_READ_WRAPPER)}.sh`);
        expect(piErr.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
        expect(piErr.message).toContain(piWrapper);
        expect(pi.fake.requests).toEqual([]);
      } finally {
        recorder.restore();
      }
    },
  );
});

describe("pi's review gate reaches the operator's Bash rules (AC-30, AC-31)", () => {
  const gateStep = (message: string): PermissionStep => ({
    kind: "permission",
    options: ["allow_once", "reject_once"],
    toolCall: {
      kind: "other",
      title: PI_SHELL_GATE_TITLE,
      rawInput: { method: "confirm", title: PI_SHELL_GATE_TITLE, message },
    },
  });

  test("AC-30: an allowed command is answered allow-once, with the rule's reason", async () => {
    const o = await open("review", {
      agent: "pi",
      rules: bashAllow(["ls *"]),
      script: { turns: [{ steps: [gateStep("ls -la")] }] },
    });
    expect(Object.hasOwn(launchEnv(o), "PI_ACP_PI_COMMAND")).toBe(true);
    const events = await driveTurn(o.session, "list the directory");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(events.find((e) => e.type === "approval_requested")).toMatchObject({ reason: SHELL_RULE_REASON });
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({
      decision: "allow",
      decidedBy: "profile",
    });
  });

  test("AC-31: a command no rule allows is denied, with the review reason", async () => {
    const o = await open("review", {
      agent: "pi",
      rules: bashAllow(["ls *"]),
      script: { turns: [{ steps: [gateStep("rm -rf x")] }] },
    });
    const events = await driveTurn(o.session, "remove it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(events.find((e) => e.type === "approval_requested")).toMatchObject({ reason: REVIEW_NO_SANDBOX_REASON });
  });
});

describe("the policy path is content-addressed (AC-32, AC-33)", () => {
  test("AC-32: two Cursor read sessions with the same rules share one directory", async () => {
    const first = await open("read");
    const second = await open("read");
    const expected = await writeCursorPolicy(stateDir, cursorCliConfig("read", NO_RULES));
    expect(launchEnv(first).CURSOR_CONFIG_DIR).toBe(expected);
    expect(launchEnv(second).CURSOR_CONFIG_DIR).toBe(expected);
  });

  test("AC-33: a Read deny rule changes the environment", async () => {
    const plain = await open("read");
    const denying = await open("read", { rules: READ_DENY });
    const expected = await writeCursorPolicy(stateDir, cursorCliConfig("read", READ_DENY));
    expect(launchEnv(denying).CURSOR_CONFIG_DIR).toBe(expected);
    expect(launchEnv(denying).CURSOR_CONFIG_DIR).not.toBe(launchEnv(plain).CURSOR_CONFIG_DIR);
  });
});

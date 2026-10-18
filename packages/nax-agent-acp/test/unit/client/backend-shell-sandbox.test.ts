import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { type AgentSession, createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { modeFor } from "#src/client/capabilities";
import { resolveAcpOptions } from "#src/client/options";
import * as permissions from "#src/client/permissions";
import * as files from "#src/client/policy-files";
import { NO_RULES } from "#src/client/rule-policy";
import * as shellRules from "#src/client/shell-rules";
import { PI_SHELL_GATE_TITLE, SHELL_RULE_REASON } from "#src/client/shell-rules";
import * as sandbox from "#src/client/shell-sandbox";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { openContext } from "#test/helpers/open-context";
import { driveTurn } from "#test/helpers/session-events";

const prefix = "'/usr/bin/node' '/opt/nax/nax.js' 'policy.json' ";
const settings = { runtime: "/usr/bin/node", runner: ["/opt/nax/nax.js", "sandbox", "exec", "--"] };
const original = { ..._acpBackendDeps };
const originalFiles = { ...files._policyFilesDeps };
const originalSandbox = { ...sandbox._shellSandboxDeps };
let dir: string;
const sessions: AgentSession[] = [];
beforeEach(() => {
  dir = makeTempDir("acp-shell-sandbox-");
  sandbox._shellSandboxDeps.homedir = () => dir;
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  Object.assign(_acpBackendDeps, original);
  Object.assign(files._policyFilesDeps, originalFiles);
  Object.assign(sandbox._shellSandboxDeps, originalSandbox);
  cleanupTempDir(dir);
});

// Literal expected values deliberately do not depend on the implementation under test.
const quoted = "'echo '\\''a b'\\'' > x'";
describe("shared sandbox wrapping", () => {
  test("AC-1: quotes the whole command", () => {
    expect(sandbox.wrapForSandbox(prefix, "echo 'a b' > x")).toBe(prefix + quoted);
  });
  test("AC-2: verifies embedded apostrophes", () => {
    expect(sandbox.isSandboxWrapped(prefix, sandbox.wrapForSandbox(prefix, "echo 'a b' > x"))).toBe(true);
  });
  test("AC-3: rejects trailing shell syntax", () => {
    expect(sandbox.isSandboxWrapped(prefix, sandbox.wrapForSandbox(prefix, "ls") + "; touch x")).toBe(false);
  });
  test("AC-4: rejects leading wrappers", () => {
    expect(sandbox.isSandboxWrapped(prefix, "rtk " + sandbox.wrapForSandbox(prefix, "ls"))).toBe(false);
  });
  test("AC-5: wraps even a prefix-crafted command", () => {
    const command = sandbox.wrapForSandbox(prefix, "ls");
    expect(sandbox.wrapForSandbox(prefix, command)).toBe(prefix + sandbox.shellQuote(command));
  });
  test("AC-6: generated JavaScript agrees with TypeScript", async () => {
    const path = join(dir, "wrapper.mjs");
    await writeFile(path, sandbox.sandboxWrapSnippet(prefix) + "\nexport { naxSandboxWrap };\n");
    const generated = await import(path);
    for (const command of ["echo 'a b' > x", "", "a\nb", prefix + "'ls'"]) {
      expect(generated.naxSandboxWrap(command)).toBe(sandbox.wrapForSandbox(prefix, command));
    }
  });
});

const execute = (command: string): RequestPermissionRequest["toolCall"] => ({
  toolCallId: "t",
  kind: "execute",
  rawInput: { command },
  title: "`" + command + "`",
});
const bash = (kind: "allow" | "deny" | "ask", pattern: string) => ({
  ...NO_RULES,
  [kind]: [{ tool: "Bash", patterns: [pattern] }],
});
const unwrappedReason = "the command did not arrive in nax's sandbox wrapper";
const blockedReason = 'a "Bash" deny or ask rule matches the command';

describe("sandboxed review permission decisions", () => {
  test("AC-7: stable unwrapped reason", () => {
    expect(permissions.REVIEW_UNWRAPPED_REASON).toBe(unwrappedReason);
  });
  test.each([
    [8, "opencode", execute("bun test"), "rules", NO_RULES, true, permissions.REVIEW_EXECUTE_REASON],
    [
      9,
      "pi",
      { toolCallId: "t", kind: "other", rawInput: { method: "confirm", title: PI_SHELL_GATE_TITLE, message: "ls" } },
      "rules",
      NO_RULES,
      true,
      permissions.REVIEW_EXECUTE_REASON,
    ],
    [10, "cursor", execute(prefix + "'ls'"), "rules", NO_RULES, true, permissions.REVIEW_EXECUTE_REASON],
    [11, "cursor", execute("ls"), "deny", NO_RULES, false, unwrappedReason],
    [12, "cursor", execute("ls"), "rules", bash("allow", "ls"), true, SHELL_RULE_REASON],
    [13, "cursor", execute("ls"), "rules", NO_RULES, false, permissions.REVIEW_NO_SANDBOX_REASON],
    [
      14,
      "opencode",
      { toolCallId: "t", kind: "edit", title: "Edit x" },
      "rules",
      NO_RULES,
      false,
      permissions.readOnlyReason("review"),
    ],
    [15, "opencode", execute("ls"), "rules", NO_RULES, false, permissions.NO_ALLOW_ONCE_REASON],
    [16, "opencode", execute("rm x"), "rules", bash("deny", "rm *"), false, blockedReason],
    [17, "cursor", execute(prefix + "'git push origin'"), "rules", bash("ask", "git push *"), false, blockedReason],
  ] as const)("AC-%d: %s decision", async (ac, agentName, toolCall, onUnwrapped, rules, allowed, reason) => {
    const seen: unknown[] = [];
    const asks = openContext(dir).asks;
    const request: RequestPermissionRequest = {
      sessionId: "s",
      toolCall,
      options: (ac === 15 ? (["reject_once"] as const) : (["allow_once", "reject_once"] as const)).map((kind) => ({
        kind,
        name: kind,
        optionId: kind,
      })),
    };
    const answer = await permissions.decidePermission(request, {
      profile: "review",
      agentName,
      rules,
      secrets: [],
      signal: new AbortController().signal,
      asks: { ...asks, recordAutoDecision: (event, decision) => seen.push([event.reason, decision]) },
      shellSandbox: { prefix, verify: agentName === "cursor", onUnwrapped },
    });
    expect(answer.outcome).toEqual({ outcome: "selected", optionId: allowed ? "allow_once" : "reject_once" });
    expect(seen).toEqual([[reason, allowed ? "allow" : "deny"]]);
  });
});

describe("writeStateFile", () => {
  test("AC-23: atomic state file has the requested path, content and mode", async () => {
    const path = await files.writeStateFile(dir, "sandbox/x.json", "{}", 0o600);
    expect(path).toBe(join(dir, "sandbox", "x.json"));
    expect(await readFile(path, "utf8")).toBe("{}");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

async function setup(agent: "opencode" | "pi" = "opencode", enabled = true, available = true) {
  const stateDir = join(dir, "state");
  const options = {
    agent,
    allowUnsandboxed: true as const,
    command: `fake-${agent}`,
    stateDir,
    ...(enabled ? { shellSandbox: settings } : {}),
  };
  const policy = { writeRoots: [dir], denyWrite: [], denyRead: [], network: {} };
  const sessionSandbox = available
    ? { kind: "policy" as const, policy }
    : { kind: "unavailable" as const, reason: "x" };
  const fake = inMemoryAgent({
    turns: [{ steps: [{ kind: "permission", options: ["allow_once", "reject_once"], toolCall: execute("ls") }] }],
  });
  const seen: unknown[] = [];
  const backend = acpBackend(options);
  const plan =
    available && enabled
      ? await sandbox.shellSandboxPlan("review", resolveAcpOptions(options), sessionSandbox, dir)
      : undefined;
  _acpBackendDeps.launch = fake.launch;
  return { fake, stateDir, plan, seen, backend, sessionSandbox };
}

type Setup = Awaited<ReturnType<typeof setup>>;
async function open(o: Setup) {
  const session = await createAgentSession({
    backend: {
      kind: o.backend.kind,
      open: (ctx) =>
        o.backend.open({
          ...ctx,
          sandbox: o.sessionSandbox,
          asks: { ...ctx.asks, recordAutoDecision: (event, decision) => o.seen.push([event.reason, decision]) },
        }),
    },
    profile: "review",
    workdir: dir,
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s",
  });
  sessions.push(session);
  return session;
}

describe("backend sandbox plan wiring", () => {
  test("AC-18: policy exists with exact plan content at launch", async () => {
    const o = await setup();
    let contentAtLaunch: string | undefined;
    _acpBackendDeps.launch = (request) => {
      contentAtLaunch = readFileSync(o.plan?.policyFile ?? "missing", "utf8");
      return o.fake.launch(request);
    };
    await open(o);
    expect(contentAtLaunch).toBe(o.plan?.policyContent);
    expect(o.fake.requests[0]?.env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    expect((await stat(o.plan?.policyFile ?? "missing")).mode & 0o777).toBe(0o600);
  });
  test.each([true, false])("AC-19/20: opted-in = %s permission", async (enabled) => {
    const o = await setup("opencode", enabled);
    const session = await open(o);
    await driveTurn(session, "run ls");
    expect(o.fake.callsTo("permission-outcome")).toEqual([
      { outcome: "selected", optionId: enabled ? "opt-allow_once" : "opt-reject_once" },
    ]);
    expect(o.seen[0]).toEqual([
      enabled ? permissions.REVIEW_EXECUTE_REASON : permissions.REVIEW_NO_SANDBOX_REASON,
      enabled ? "allow" : "deny",
    ]);
  });
  test("AC-21: unavailable sandbox keeps pi's existing path", async () => {
    const o = await setup("pi", true, false);
    await open(o);
    expect(o.fake.requests).toHaveLength(1);
    expect(existsSync(join(o.stateDir, "sandbox"))).toBe(false);
  });
  test("AC-22: policy write failure refuses launch and names policy", async () => {
    const o = await setup();
    files._policyFilesDeps.writeFile = async (path, content) => {
      if (path.startsWith(o.plan?.policyFile ?? "missing")) throw new Error("write refused");
      return originalFiles.writeFile(path, content);
    };
    await expect(open(o)).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
      message: expect.stringContaining(o.plan?.policyFile ?? "missing"),
    });
    expect(o.fake.requests).toHaveLength(0);
  });
  test.each(["mkdir", "realpath"] as const)("AC-24: %s failure starts neither host nor process", async (method) => {
    const o = await setup();
    let hosts = 0;
    _acpBackendDeps.createToolHost = (...args) => {
      hosts++;
      return original.createToolHost(...args);
    };
    sandbox._shellSandboxDeps[method] = async () => {
      throw new Error("state refused");
    };
    // A tool ensures a host would be created if planning ran too late.
    const ctx = openContext(dir, {
      profile: "review",
      sandbox: o.sessionSandbox,
      tools: [
        { name: "read", description: "read", inputSchema: {}, approval: "never", run: async () => ({ content: "ok" }) },
      ],
    });
    await expect(o.backend.open(ctx)).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
      message: expect.stringContaining(o.stateDir),
    });
    expect(o.fake.requests).toHaveLength(0);
    expect(hosts).toBe(0);
  });
  test("sandboxed Cursor review selects its shell mode without an allow rule", () => {
    const options = resolveAcpOptions({ agent: "cursor", allowUnsandboxed: true });
    expect(modeFor("review", options.entry, NO_RULES, true)).toEqual(options.entry?.readOnly?.reviewShellMode);
    expect(modeFor("read", options.entry, NO_RULES, true)).toEqual(options.entry?.readOnly?.mode);
  });
});

describe("shellRuleBlocks", () => {
  test.each([
    ["ls && rm x", true],
    ["rm x > out", true],
    ["echo $(rm x)", false],
    ["ls", false],
  ])("deny rules inspect segments of %s", (command, expected) => {
    expect(shellRules.shellRuleBlocks(command, bash("deny", "rm *"))).toBe(expected);
  });
});

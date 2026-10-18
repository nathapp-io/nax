import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { type AgentSession, createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { modeFor } from "#src/client/capabilities";
import { resolveAcpOptions } from "#src/client/options";
import { REVIEW_EXECUTE_REASON, REVIEW_UNWRAPPED_REASON } from "#src/client/permissions";
import { _policyFilesDeps, digest } from "#src/client/policy-files";
import { cursorCliConfig, NO_RULES } from "#src/client/rule-policy";
import { _shellSandboxDeps, shellQuote, shellSandboxPlan, wrapForSandbox } from "#src/client/shell-sandbox";
import { CURSOR_CONFIG_OPTIONS } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn } from "#test/helpers/session-events";

const original = { ..._acpBackendDeps };
const originalFiles = { ..._policyFilesDeps };
const originalSandbox = { ..._shellSandboxDeps };
const sessions: AgentSession[] = [];
let dir: string;
beforeEach(() => {
  dir = makeTempDir("cursor-sandbox-");
  _shellSandboxDeps.homedir = () => dir;
  _shellSandboxDeps.platform = () => "linux";
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  Object.assign(_acpBackendDeps, original);
  Object.assign(_policyFilesDeps, originalFiles);
  Object.assign(_shellSandboxDeps, originalSandbox);
  cleanupTempDir(dir);
});

async function setup(available = true, onUnwrapped: "rules" | "deny" = "rules", wrapped = true) {
  const stateDir = join(dir, "state");
  const options = {
    agent: "cursor" as const,
    allowUnsandboxed: true as const,
    command: "fake-cursor",
    stateDir,
    env: { HOME: dir },
    rules: { ...NO_RULES, deny: [{ tool: "Read", patterns: ["*"] }] },
    shellSandbox: {
      runtime: process.execPath,
      runner: ["/test runner/nax.js", "sandbox", "exec"],
      cursor: { onUnwrapped },
    },
  };
  const sandbox = available
    ? { kind: "policy" as const, policy: { writeRoots: [dir], denyWrite: [], denyRead: [], network: {} } }
    : { kind: "unavailable" as const, reason: "x" };
  const plan = await shellSandboxPlan("review", resolveAcpOptions(options), sandbox, dir);
  const command = wrapped && plan ? wrapForSandbox(plan.prefix, "ls") : "ls";
  const fake = inMemoryAgent({
    configOptions: CURSOR_CONFIG_OPTIONS,
    turns: [
      {
        steps: [
          {
            kind: "permission",
            options: ["allow_once", "reject_once"],
            toolCall: {
              toolCallId: "t",
              kind: "execute",
              title: "`" + command + "`",
            },
          },
        ],
      },
    ],
  });
  _acpBackendDeps.launch = fake.launch;
  return { stateDir, options, sandbox, plan, fake, seen: [] as unknown[] };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function open(o: Setup) {
  const backend = acpBackend(o.options);
  const session = await createAgentSession({
    backend: {
      kind: backend.kind,
      open: (ctx) =>
        backend.open({
          ...ctx,
          sandbox: o.sandbox,
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
function homeOf(o: Setup): string {
  const home = o.fake.requests[0]?.env.HOME;
  expect(home).toBeString();
  if (!home?.startsWith(join(o.stateDir, "cursor-home"))) throw new Error("missing isolated HOME");
  return home;
}
async function hookOf(o: Setup): Promise<string> {
  const hooks = JSON.parse(await readFile(join(homeOf(o), ".cursor/hooks.json"), "utf8"));
  const command: string = hooks.hooks.preToolUse[0].command;
  const match = command.match(/'([^']+sandbox-hook-[a-f0-9]{16}\.mjs)'$/);
  if (!match?.[1]) throw new Error("missing hook path");
  return match[1];
}
async function runHook(o: Setup, input: string) {
  const proc = Bun.spawn([process.execPath, await hookOf(o)], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("cursorSandboxEnv through backend open", () => {
  test("AC-1: launches with a content-addressed isolated HOME", async () => {
    const o = await setup();
    await open(o);
    expect(homeOf(o)).toMatch(new RegExp(`^${o.stateDir}/cursor-home/[a-f0-9]{16}$`));
  });
  test("AC-2: installs the fail-closed hook and hashes hooks.json for HOME", async () => {
    const o = await setup();
    await open(o);
    const hook = await hookOf(o);
    expect(hook).toMatch(new RegExp(`^${o.stateDir}/cursor/sandbox-hook-[a-f0-9]{16}\\.mjs$`));
    const source = await readFile(hook, "utf8");
    expect(hook).toBe(join(o.stateDir, "cursor", `sandbox-hook-${digest(source)}.mjs`));
    const text = await readFile(join(homeOf(o), ".cursor/hooks.json"), "utf8");
    expect(JSON.parse(text)).toEqual({
      version: 1,
      hooks: {
        preToolUse: [
          {
            command: shellQuote(process.execPath) + " " + shellQuote(hook),
            failClosed: true,
          },
        ],
      },
    });
    expect(homeOf(o)).toBe(join(o.stateDir, "cursor-home", digest(text)));
  });
  test("AC-3: darwin links the real home's keychains", async () => {
    _shellSandboxDeps.platform = () => "darwin";
    const o = await setup();
    await open(o);
    expect(await readlink(join(homeOf(o), "Library/Keychains"))).toBe(join(dir, "Library/Keychains"));
  });
  test("AC-4: linux creates no Library directory", async () => {
    const o = await setup();
    await open(o);
    expect(existsSync(join(homeOf(o), "Library"))).toBe(false);
  });
  test("AC-5: a keychain symlink error refuses before launch", async () => {
    _shellSandboxDeps.platform = () => "darwin";
    let failedPath = "";
    _shellSandboxDeps.symlink = async (_target, path) => {
      failedPath = String(path);
      throw new Error("refused");
    };
    const o = await setup();
    const error = sessionError(await rejection(open(o)));
    expect(error.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(failedPath).toStartWith(join(o.stateDir, "cursor-home"));
    expect(failedPath).toEndWith("Library/Keychains");
    expect(error.message).toContain(failedPath);
    expect(o.fake.requests).toHaveLength(0);
  });
  test("AC-6: preserves the rule-based CURSOR_CONFIG_DIR", async () => {
    const o = await setup();
    await open(o);
    const config = o.fake.requests[0]?.env.CURSOR_CONFIG_DIR;
    expect(config).toBeString();
    expect(await readFile(join(config ?? "missing", "cli-config.json"), "utf8")).toBe(
      cursorCliConfig("review", o.options.rules),
    );
  });
  test.each([
    [7, true, "agent"],
    [8, false, "ask"],
  ] as const)("AC-%d: available=%s selects %s mode", async (_, available, mode) => {
    const o = await setup(available);
    await open(o);
    expect(o.fake.callsTo("session/set_config_option")).toContainEqual({
      sessionId: "fake-session-1",
      configId: "mode",
      value: mode,
    });
    if (!available) expect(o.fake.requests[0]?.env.HOME).toBe(dir);
  });
  test("AC-9: sandboxed review selects agent mode without Bash rules", () => {
    const options = resolveAcpOptions({ agent: "cursor", allowUnsandboxed: true });
    expect(modeFor("review", options.entry, NO_RULES, true)).toEqual({ configId: "mode", value: "agent" });
  });
  test.each([
    [13, "rules", true, "allow", REVIEW_EXECUTE_REASON],
    [14, "deny", false, "deny", REVIEW_UNWRAPPED_REASON],
  ] as const)("AC-%d: permission verifies the launched plan", async (_, policy, wrapped, decision, reason) => {
    const o = await setup(true, policy, wrapped);
    const session = await open(o);
    expect(homeOf(o)).toContain("/cursor-home/");
    await driveTurn(session, "run ls");
    expect(o.fake.callsTo("permission-outcome")).toEqual([
      { outcome: "selected", optionId: decision === "allow" ? "opt-allow_once" : "opt-reject_once" },
    ]);
    expect(o.seen).toEqual([[reason, decision]]);
  });
  test("AC-15: reuses HOME and accepts an existing correct keychain link", async () => {
    _shellSandboxDeps.platform = () => "darwin";
    const first = await setup();
    await open(first);
    const second = await setup();
    await open(second);
    expect(homeOf(second)).toBe(homeOf(first));
    expect(await readlink(join(homeOf(second), "Library/Keychains"))).toBe(join(dir, "Library/Keychains"));
  });
  test("AC-16: hook and hooks.json are private", async () => {
    const o = await setup();
    await open(o);
    for (const path of [await hookOf(o), join(homeOf(o), ".cursor/hooks.json")]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
  test.each([
    [17, "sandbox-hook-"],
    [18, "hooks.json"],
  ] as const)("AC-%d: failed write of %s refuses before launch", async (_, part) => {
    const o = await setup();
    let failedPath = "";
    _policyFilesDeps.rename = async (from, to) => {
      if (to.includes(part)) {
        failedPath = to;
        throw new Error("refused");
      }
      return originalFiles.rename(from, to);
    };
    const error = sessionError(await rejection(open(o)));
    expect(error.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(failedPath).toContain(part);
    expect(error.message).toContain(failedPath);
    expect(o.fake.requests).toHaveLength(0);
  });
  test.each(["directory", "wrong-link"])("AC-19: rejects an existing %s at Library/Keychains", async (kind) => {
    // First open on Linux writes the identical HOME, without a keychain link.
    const first = await setup();
    await open(first);
    const path = join(homeOf(first), "Library/Keychains");
    await mkdir(join(homeOf(first), "Library"));
    if (kind === "directory") await mkdir(path);
    else await symlink(join(dir, "wrong"), path);
    _shellSandboxDeps.platform = () => "darwin";
    const second = await setup();
    await expect(open(second)).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
      message: expect.stringContaining(path),
    });
    expect(second.fake.requests).toHaveLength(0);
  });
});

describe("cursorSandboxHookSource generated program", () => {
  test("AC-10: rewrites command and preserves all other input fields", async () => {
    const o = await setup();
    await open(o);
    const result = await runHook(
      o,
      JSON.stringify({ tool_name: "Shell", tool_input: { command: "ls", cwd: "", timeout: 30000 } }),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      updated_input: { command: wrapForSandbox(o.plan?.prefix ?? "missing", "ls"), cwd: "", timeout: 30000 },
    });
  });
  test.each([{ tool_name: "Read", tool_input: { path: "a" } }, {}, null, { tool_input: { command: 42 } }])(
    "AC-11: ignores input without a string command: %j",
    async (input) => {
      const o = await setup();
      await open(o);
      const result = await runHook(o, JSON.stringify(input));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
    },
  );
  test("AC-12: malformed stdin fails closed", async () => {
    const o = await setup();
    await open(o);
    const result = await runHook(o, "not json");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });
});

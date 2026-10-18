import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentSession, createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { _opencodeSandboxDeps } from "#src/client/opencode-sandbox";
import type { AcpBackendOptions } from "#src/client/options";
import { _policyFilesDeps } from "#src/client/policy-files";
import { NO_RULES, opencodePermissionConfig } from "#src/client/rule-policy";
import { SHELL_RULE_REASON } from "#src/client/shell-rules";
import { _shellSandboxDeps, wrapForSandbox } from "#src/client/shell-sandbox";
import type { FakeScript } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const original = { launch: _acpBackendDeps.launch, home: _shellSandboxDeps.homedir, write: _policyFilesDeps.writeFile };
const originalReads = { ..._opencodeSandboxDeps };
const sessions: AgentSession[] = [];
let dir: string;
let workdir: string;
let home: string;
let stateDir: string;
const settings = { runtime: "/usr/bin/node", runner: ["/opt/nax.js", "sandbox", "exec", "--"] };
const rules = { ...NO_RULES, deny: [{ tool: "Read", patterns: ["*"] }] };
beforeEach(async () => {
  dir = makeTempDir("opencode-sandbox-");
  home = join(dir, "home");
  workdir = join(dir, "repo", "child");
  stateDir = join(dir, "state");
  await mkdir(workdir, { recursive: true });
  await mkdir(join(dir, "repo", ".git"));
  _shellSandboxDeps.homedir = () => home;
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  _acpBackendDeps.launch = original.launch;
  _shellSandboxDeps.homedir = original.home;
  _policyFilesDeps.writeFile = original.write;
  Object.assign(_opencodeSandboxDeps, originalReads);
  cleanupTempDir(dir);
});
async function put(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}
function prepare(options: Partial<AcpBackendOptions> = {}, sandbox = true, script: FakeScript = {}) {
  const fake = inMemoryAgent({ agentInfo: { name: "opencode-acp", version: "2.0.27" }, ...script });
  _acpBackendDeps.launch = fake.launch;
  const backend = acpBackend({
    agent: "opencode",
    command: "fake-opencode",
    allowUnsandboxed: true,
    stateDir,
    shellSandbox: settings,
    rules,
    ...options,
  });
  const open = async () => {
    const session = await createAgentSession({
      backend: {
        kind: backend.kind,
        open: (ctx) =>
          backend.open({
            ...ctx,
            ...(sandbox
              ? {
                  sandbox: {
                    kind: "policy" as const,
                    policy: { writeRoots: [workdir], denyWrite: [], denyRead: [], network: {} },
                  },
                }
              : {}),
          }),
      },
      profile: "review",
      workdir,
      transcriptStore: createMemoryTranscriptStore(),
    });
    sessions.push(session);
    return session;
  };
  return { fake, open };
}
async function launch(options: Partial<AcpBackendOptions> = {}) {
  const o = prepare(options);
  const session = await o.open();
  return { ...o, session, env: o.fake.requests[0]?.env ?? {} };
}
function configDir(env: Readonly<Record<string, string>>) {
  expect(env.OPENCODE_CONFIG_DIR).toBeDefined();
  return env.OPENCODE_CONFIG_DIR ?? "missing-config-dir";
}

describe("opencodeSandboxEnv through backend open", () => {
  test("AC-1/2/3/17: isolates project config, preserves permissions and writes a private plugin", async () => {
    const { env } = await launch();
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(opencodePermissionConfig("review", rules));
    const path = configDir(env);
    expect(path.startsWith(join(stateDir, "opencode") + "/")).toBe(true);
    expect(path.split("/").at(-1)).toMatch(/^[a-f0-9]{16}$/);
    const plugin = join(path, "plugins", "nax-shell-sandbox.js");
    expect(await readFile(plugin, "utf8")).toContain("nax-shell-sandbox");
    expect((await stat(plugin)).mode & 0o777).toBe(0o600);
  });
  test.each([
    [4, "home", "opencode.json"],
    [5, "xdg", "opencode.jsonc"],
  ] as const)("AC-%d: preserves operator config from %s", async (_, kind, name) => {
    const user = kind === "home" ? join(home, ".config", "opencode") : join(dir, "xdg", "opencode");
    await put(join(user, name), "{}");
    // json wins over jsonc when both exist.
    if (name === "opencode.json") await put(join(user, "opencode.jsonc"), "{}");
    const { env } = await launch({ env: kind === "xdg" ? { XDG_CONFIG_HOME: join(dir, "xdg") } : {} });
    expect(env.OPENCODE_CONFIG).toBe(join(user, name));
  });
  test("AC-6: an empty caller config dir preserves isolation", async () => {
    await put(join(home, ".config", "opencode", "opencode.json"), "{}");
    const empty = join(dir, "empty");
    await mkdir(empty);
    const { env } = await launch({ env: { OPENCODE_CONFIG_DIR: empty } });
    expect(Object.hasOwn(env, "OPENCODE_CONFIG")).toBe(false);
    expect(configDir(env)).not.toBe(empty);
  });
  test("AC-7: explicit operator config is never replaced", async () => {
    await put(join(home, ".config", "opencode", "opencode.json"), "{}");
    const { env } = await launch({ env: { OPENCODE_CONFIG: "/my/opencode.json" } });
    expect(env.OPENCODE_CONFIG).toBe("/my/opencode.json");
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  });
  test("AC-8/9: restores instructions nearest first, stopping at the git boundary", async () => {
    const user = join(dir, "user");
    await put(join(user, "AGENTS.md"), "G");
    await put(join(workdir, "AGENTS.md"), "W");
    await put(join(dir, "repo", "AGENTS.md"), "R");
    await put(join(dir, "AGENTS.md"), "outside");
    const { env } = await launch({ env: { OPENCODE_CONFIG_DIR: user } });
    expect(await readFile(join(configDir(env), "AGENTS.md"), "utf8")).toBe("G\n\nW\n\nR");
  });
  test("AC-10: absent instructions produce no AGENTS.md", async () => {
    const { env } = await launch();
    expect(existsSync(join(configDir(env), "AGENTS.md"))).toBe(false);
  });
  test("AC-11: projectConfig keep retains the old launch environment", async () => {
    const { env } = await launch({ shellSandbox: { ...settings, opencode: { projectConfig: "keep" } } });
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(opencodePermissionConfig("review", rules));
    for (const key of ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_DISABLE_PROJECT_CONFIG"]) {
      expect(Object.hasOwn(env, key)).toBe(false);
    }
  });
  test("AC-12: a reconnect uses the same content-addressed config", async () => {
    const o = prepare({}, true, {
      capabilities: { sessionCapabilities: { resume: {} } },
      relaunch: { turns: [{ steps: [{ kind: "text", text: "back" }] }] },
    });
    const session = await o.open();
    const first = configDir(o.fake.requests[0]?.env ?? {});
    await driveTurn(session, "one");
    o.fake.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(endOf(await driveTurn(session, "two"))).toMatchObject({ status: "completed", output: "back" });
    expect(o.fake.requests).toHaveLength(2);
    expect(o.fake.requests[1]?.env.OPENCODE_CONFIG_DIR).toBe(first);
  });
  test.each([
    [18, "nax-shell-sandbox.js"],
    [19, "AGENTS.md"],
  ] as const)("AC-%d: a failed %s write refuses open before launch", async (_, name) => {
    await put(join(workdir, "AGENTS.md"), "W");
    _policyFilesDeps.writeFile = async (path, content) => {
      if (path.includes(name)) throw new Error("disk unavailable");
      return original.write(path, content);
    };
    const o = prepare();
    const error = sessionError(await rejection(o.open()));
    expect(error.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(error.message).toContain(name);
    expect(error.message).toContain(join(stateDir, "opencode"));
    expect(o.fake.requests).toHaveLength(0);
  });
  test.each(["readFile", "stat"] as const)(
    "refuses unexpected %s failures rather than losing operator config",
    async (operation) => {
      _opencodeSandboxDeps[operation] = async () => {
        throw new Error("access denied");
      };
      const o = prepare();
      const error = sessionError(await rejection(o.open()));
      expect(error.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
      expect(error.message).toContain(operation === "readFile" ? "AGENTS.md" : ".git");
      expect(o.fake.requests).toHaveLength(0);
    },
  );
  test("instruction changes produce a different config address and unchanged launches repair the plugin", async () => {
    const first = configDir((await launch()).env);
    const plugin = join(first, "plugins", "nax-shell-sandbox.js");
    const source = await readFile(plugin, "utf8");
    await writeFile(plugin, "corrupted");
    expect(configDir((await launch()).env)).toBe(first);
    expect(await readFile(plugin, "utf8")).toBe(source);
    await put(join(workdir, "AGENTS.md"), "new instructions");
    const second = configDir((await launch()).env);
    expect(second).not.toBe(first);
    expect(await readFile(join(second, "AGENTS.md"), "utf8")).toBe("new instructions");
  });
  test("AC-20: no sandbox keeps the existing Bash-rule permission path", async () => {
    const o = prepare({ rules: { ...NO_RULES, allow: [{ tool: "Bash", patterns: ["ls"] }] } }, false, {
      turns: [
        {
          steps: [
            {
              kind: "permission",
              options: ["allow_once", "reject_once"],
              toolCall: { kind: "execute", rawInput: { command: "ls" }, title: "ls" },
            },
          ],
        },
      ],
    });
    const session = await o.open();
    const events = await driveTurn(session, "go");
    expect(o.fake.callsTo("permission-outcome")).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(events.find((event) => event.type === "approval_requested")).toMatchObject({ reason: SHELL_RULE_REASON });
    expect(o.fake.requests[0]?.env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });
});

type Event = { tool: string; input: Record<string, unknown> };
async function loadPlugin() {
  const { opencodeSandboxPluginSource } = await import("#src/client/opencode-sandbox");
  const prefix = "'/runtime' '/runner' '/policy' ";
  const path = join(dir, "plugin.mjs");
  await writeFile(path, opencodeSandboxPluginSource(prefix));
  const plugin = (await import(path)).default;
  const hooks: { name: string; hook: (event: Event) => void }[] = [];
  await plugin.setup({
    tool: {
      hook: (name: string, hook: (event: Event) => void) => {
        hooks.push({ name, hook });
      },
    },
  });
  expect(plugin.id).toBe("nax-shell-sandbox");
  expect(hooks.map((h) => h.name)).toEqual(["execute.before"]);
  const hook = hooks[0]?.hook;
  if (!hook) throw new Error("missing hook");
  return { hook, prefix };
}
describe("opencodeSandboxPluginSource", () => {
  test("AC-13: registers exactly one execute.before hook", async () => {
    await loadPlugin();
  });
  test.each(["shell", "bash", "SHELL", "BaSh"])("AC-14/15: wraps %s and preserves other input", async (tool) => {
    const { hook, prefix } = await loadPlugin();
    const event = { tool, input: { command: "ls", description: "d" } };
    hook(event);
    expect(event.input).toEqual({ command: wrapForSandbox(prefix, "ls"), description: "d" });
  });
  test.each<[string, Record<string, unknown>]>([
    ["read", { filePath: "a" }],
    ["shell", { command: 42 }],
    ["bash", {}],
  ])("AC-16: leaves %s without a shell command untouched", async (tool, input) => {
    const { hook } = await loadPlugin();
    const event = { tool, input };
    const before = event.input;
    const snapshot = { ...before };
    hook(event);
    expect(event.input).toBe(before);
    expect(event.input).toEqual(snapshot);
  });
});

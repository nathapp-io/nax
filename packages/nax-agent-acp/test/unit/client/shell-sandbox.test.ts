import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionProfile, SandboxPolicy, SessionSandbox } from "@nathapp/nax-agent";
import { resolveAcpOptions } from "#src/client/options";
import { _shellSandboxDeps, shellQuote, shellSandboxPlan } from "#src/client/shell-sandbox";

const SHELL = { runtime: "/runtime with space/bun", runner: ["/opt/it's nax.js", "sandbox", "exec"] };
const POLICY: SandboxPolicy = { writeRoots: ["/w"], denyWrite: ["/locked"], denyRead: ["/private"], network: {} };
const SANDBOX: SessionSandbox = { kind: "policy", policy: POLICY };
const original = { ..._shellSandboxDeps };
let home: string;
let stateDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "acp-shell-plan-"));
  stateDir = join(home, "state");
  _shellSandboxDeps.homedir = () => home;
});
afterEach(async () => {
  Object.assign(_shellSandboxDeps, original);
  await rm(home, { recursive: true, force: true });
});
function options(agent = "opencode", extra = {}) {
  return resolveAcpOptions({ agent, allowUnsandboxed: true, stateDir, shellSandbox: SHELL, ...extra }, {});
}
async function plan() {
  const result = await shellSandboxPlan("review", options(), SANDBOX, "/w");
  expect(result).toBeDefined();
  if (!result) throw new Error("expected plan");
  return result;
}

describe("shellSandboxPlan", () => {
  test.each([
    ["AC-7", "opencode", false],
    ["AC-8", "pi", false],
    ["AC-9", "cursor", true],
  ] as const)("%s plans %s", async (_ac, agent, verify) => {
    const result = await shellSandboxPlan("review", options(agent), SANDBOX, "/w");
    expect(result).toMatchObject({
      agent,
      verify,
      onUnwrapped: "rules",
      piExtensions: "user",
      home,
      workdir: "/w",
      runtime: SHELL.runtime,
    });
  });
  test.each<[string, AgentSessionProfile, string, SessionSandbox | undefined, object]>([
    ["AC-10 full", "full", "opencode", SANDBOX, {}],
    ["AC-11 unavailable", "review", "opencode", { kind: "unavailable", reason: "no bwrap" }, {}],
    ["AC-12 absent sandbox", "review", "opencode", undefined, {}],
    ["AC-13 claude", "review", "claude", SANDBOX, {}],
    ["AC-14 absent settings", "review", "opencode", SANDBOX, { shellSandbox: undefined }],
    ["AC-15 keep", "review", "opencode", SANDBOX, { shellSandbox: { ...SHELL, opencode: { projectConfig: "keep" } } }],
    ["none profile", "none", "pi", SANDBOX, {}],
    ["read profile", "read", "cursor", SANDBOX, {}],
    ["codex", "review", "codex", SANDBOX, {}],
    ["gemini", "review", "gemini", SANDBOX, {}],
  ])("%s skips without filesystem calls", async (_ac, profile, agent, sandbox, extra) => {
    _shellSandboxDeps.mkdir = async () => {
      throw new Error("must not touch disk");
    };
    expect(await shellSandboxPlan(profile, options(agent, extra), sandbox, "/w")).toBeUndefined();
  });
  test("AC-16 creates 0700 state and appends its realpath without mutating input", async () => {
    const result = await plan();
    expect(result.policy.denyWrite).toEqual([...POLICY.denyWrite, await realpath(stateDir)]);
    expect((await stat(stateDir)).isDirectory()).toBe(true);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect(POLICY.denyWrite).toEqual(["/locked"]);
  });
  test("AC-17 credential realpaths, including pi, appended in order", async () => {
    const auth = join(home, ".local/share/opencode/auth.json");
    const pi = join(home, ".pi/agent/auth.json");
    await mkdir(join(home, ".local/share/opencode"), { recursive: true });
    await mkdir(join(home, ".pi/agent"), { recursive: true });
    await writeFile(auth, "{}");
    await symlink(auth, pi);
    expect((await plan()).policy.denyRead).toEqual([...POLICY.denyRead, await realpath(auth), await realpath(pi)]);
  });
  test("AC-18 absent credential files preserve denies", async () => {
    expect((await plan()).policy.denyRead).toEqual(POLICY.denyRead);
  });
  test("AC-19 exact writer contract", async () => {
    const result = await plan();
    expect(result.policyContent).toBe(
      JSON.stringify({ version: 1, home, stripEnv: result.stripEnv, policy: result.policy }),
    );
  });
  test("AC-20 content-addressed filename", async () => {
    const result = await plan();
    const hash = createHash("sha256").update(result.policyContent).digest("hex").slice(0, 16);
    expect(result.policyFile).toBe(join(stateDir, "sandbox", `policy-${hash}.json`));
  });
  test("AC-21 quoted prefix with trailing space", async () => {
    const result = await plan();
    expect(result.prefix).toBe(`${[SHELL.runtime, ...SHELL.runner, result.policyFile].map(shellQuote).join(" ")} `);
  });
  test("AC-23 strips sorted deduplicated credential env, not PATH", async () => {
    const env = { CURSOR_API_KEY: "k-123456789", OPENROUTER_API_KEY: "sk-or-123456789", PATH: "/bin" };
    const result = await shellSandboxPlan("review", options("cursor", { env }), SANDBOX, "/w");
    expect(result?.stripEnv).toEqual(["CURSOR_API_KEY", "OPENROUTER_API_KEY"]);
  });
  test.each(["realpath", "mkdir"] as const)("AC-24 %s failure names stateDir", async (operation) => {
    _shellSandboxDeps[operation] = async () => {
      throw new Error("disk refused");
    };
    await expect(plan()).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
      message: expect.stringContaining(stateDir),
    });
  });
  test("registry auth names are stripped even when absent from env", async () => {
    const opts = options("cursor");
    expect(opts.entry?.authEnv).toContain("CURSOR_API_KEY");
    expect((await shellSandboxPlan("review", opts, SANDBOX, "/w"))?.stripEnv).toContain("CURSOR_API_KEY");
  });
  test("credential resolution errors other than ENOENT fail closed", async () => {
    _shellSandboxDeps.realpath = async (path) => {
      if (path === stateDir) return stateDir;
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    await expect(plan()).rejects.toMatchObject({ code: "AGENT_SESSION_BACKEND_UNAVAILABLE" });
  });
});
describe("shellQuote", () => {
  test("AC-22 quotes apostrophes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
  });
});

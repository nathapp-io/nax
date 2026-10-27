/**
 * S3-4: profiles are capability statements (spec 4.5). This pins the tools
 * each profile advertises, GitCommit only with ignore patterns, the embedder
 * default protected-paths policy (spec 6.2), the credential read-deny reaching
 * Read, and the sandbox floor for "full" (spec 6.3).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import * as codingSupport from "#src/coding-tools/coding-tool-support";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "#src/config/schemas-sandbox";
import { _resetCredentialsConfig, configureCredentials, credentialsConfig } from "#src/infra/credentials-config";
import { chainAskLinks } from "#src/permissions/index";
import {
  askRulesFor,
  buildSessionToolSupport,
  declaredToolsFor,
  defaultProtectedPaths,
  grantsFor,
  resolveSessionLauncher,
  type SessionToolSupportArgs,
} from "#src/session/session-tool-support";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import type { CodingToolName } from "#src/tools/types";
import {
  assertNaxError,
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

const tempDirs: string[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

const EMPTY: ProtectedPathsPolicy = { gitExcludePathspecs: [], gitIgnorePatterns: [] };
// Typed so the profile assertions below check the literals against the real union.
const TRIO: readonly CodingToolName[] = ["ScratchpadWrite", "ScratchpadRead", "ScratchpadList"];

async function args(extra: Partial<SessionToolSupportArgs> = {}): Promise<SessionToolSupportArgs> {
  return {
    profile: "none",
    root: makeTestDir("nax-session-tools-"),
    sessionName: "s1",
    protectedPaths: EMPTY,
    bashApproval: "gated",
    launcher: undefined,
    askResolver: chainAskLinks([]),
    interceptor: undefined,
    ...extra,
  };
}

function names(support: { tools: readonly { name: string }[] }): string[] {
  return support.tools.map((tool) => tool.name).sort();
}

/** A tool's `inputSchema.properties` keys, without casting to a Capitalised type. */
function bashPropertyKeys(tool: { readonly inputSchema: Record<string, unknown> }): string[] {
  const properties: unknown = tool.inputSchema.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error("expected the Bash tool's inputSchema.properties to be an object");
  }
  return Object.keys(properties).sort();
}

describe("declaredToolsFor and grantsFor", () => {
  test("none is the scratchpad trio; read adds the read tools; full adds the write tools", () => {
    expect(declaredToolsFor("none", EMPTY)).toEqual(TRIO);
    expect(declaredToolsFor("read", EMPTY)).toEqual([...TRIO, "Read", "Glob", "Grep", "Git"]);
    expect(declaredToolsFor("full", EMPTY)).toEqual([
      ...TRIO,
      "Read",
      "Glob",
      "Grep",
      "Git",
      "Write",
      "Edit",
      "Delete",
      "Bash",
    ]);
  });

  test("full declares GitCommit only when ignore patterns are supplied", () => {
    expect(declaredToolsFor("full", { ...EMPTY, gitIgnorePatterns: ["dist/"] })).toContain("GitCommit");
    expect(declaredToolsFor("read", { ...EMPTY, gitIgnorePatterns: ["dist/"] })).not.toContain("GitCommit");
  });

  test("ask declares the full tool set and asks for every mutating tool", () => {
    const policy = { gitExcludePathspecs: [], gitIgnorePatterns: [".nax/"] };
    const declared = declaredToolsFor("ask", policy);
    expect(declared).toEqual(declaredToolsFor("full", policy));
    const asked = askRulesFor(declared, "gated", "ask")
      .map((rule) => rule.tool)
      .sort();
    expect(asked).toEqual(["Bash", "Delete", "Edit", "GitCommit", "Write"]);
    expect(askRulesFor(declared, "gated", "ask").every((rule) => rule.patterns.join() === "*")).toBe(true);
  });

  test("full keeps the 0.2.0 ask rules (Bash under gated only)", () => {
    const declared = declaredToolsFor("full", EMPTY);
    expect(askRulesFor(declared, "gated", "full").map((rule) => rule.tool)).toEqual(["Bash"]);
    expect(askRulesFor(declared, "raw", "full")).toEqual([]);
    expect(askRulesFor(declared, "escalate", "full")).toEqual([]);
    expect(askRulesFor(declaredToolsFor("read", EMPTY), "gated", "full")).toEqual([]);
  });

  test("every declared tool gets an unconditional grant", () => {
    expect(grantsFor(["Read", "Git"])).toEqual([
      { tool: "Read", patterns: ["*"] },
      { tool: "Git", patterns: ["*"] },
    ]);
  });
});

describe("defaultProtectedPaths", () => {
  const saved = credentialsConfig();
  afterEach(() => configureCredentials(saved));

  test("uses the configured credentials directory when the session has no credentials of its own", () => {
    expect(defaultProtectedPaths(false)).toEqual({ ...EMPTY, credentialDir: saved.configDir() });
  });

  test("a session with its own credentials source gets no credential directory", () => {
    expect(defaultProtectedPaths(true)).toEqual(EMPTY);
  });

  test("without configureCredentials there is no credential directory", () => {
    _resetCredentialsConfig();
    expect(defaultProtectedPaths(false)).toEqual(EMPTY);
  });
});

describe("buildSessionToolSupport", () => {
  test("advertises the profile's tools, with grants", async () => {
    const none = buildSessionToolSupport(await args());
    expect(names(none.support)).toEqual([...TRIO].sort());
    expect(none.grants).toHaveLength(3);
    const read = buildSessionToolSupport(await args({ profile: "read" }));
    expect(names(read.support)).toEqual([...TRIO, "Read", "Glob", "Grep", "Git"].sort());
  });

  test("full without a launcher advertises Write, Edit, Delete and Bash", async () => {
    const full = buildSessionToolSupport(await args({ profile: "full" }));
    expect(names(full.support)).toEqual(expect.arrayContaining(["Write", "Edit", "Delete", "Bash"]));
    expect(names(full.support)).not.toContain("GitCommit");
    expect(names(full.support)).not.toContain("RunCommand");
  });

  test("full + gated puts a Bash command to the ask resolver, and a denial does not run it", async () => {
    const asked: string[] = [];
    const recording = chainAskLinks([
      {
        name: "recording",
        async resolve(req) {
          asked.push(req.command ?? "");
          return { decision: "deny", decidedBy: "human" };
        },
      },
    ]);
    const { support } = buildSessionToolSupport(await args({ profile: "full", askResolver: recording }));
    const outcome = await support.runtime.callTool("Bash", { command: "echo hi" });
    expect(asked).toEqual(["echo hi"]);
    expect(outcome.kind).toBe("denied");
  });

  test("AC-14: allowedTools narrows the grants, so no Write grant is issued", async () => {
    const narrowed = buildSessionToolSupport(await args({ profile: "full", allowedTools: ["Read"] }));
    const granted = narrowed.grants.map((grant) => grant.tool);
    expect(granted).not.toContain("Write");
    expect(granted.slice().sort()).toEqual(["Read", ...TRIO].sort());
    expect(names(narrowed.support)).toEqual(["Read", ...TRIO].sort());
  });

  test("allowedTools leaves the ask rules of a declared tool unchanged and drops those of an undeclared one", async () => {
    const withBash = buildSessionToolSupport(await args({ profile: "full", allowedTools: ["Bash"] }));
    expect(names(withBash.support)).toEqual(["Bash", ...TRIO].sort());
    const without = buildSessionToolSupport(await args({ profile: "full", allowedTools: ["Read"] }));
    expect(names(without.support)).not.toContain("Bash");
  });

  test("Read refuses the credential directory", async () => {
    const base = await args({ profile: "read" });
    const credentialDir = join(base.root, "creds");
    await mkdir(credentialDir);
    await writeFile(join(credentialDir, "token.json"), "{}");
    const { support } = buildSessionToolSupport({ ...base, protectedPaths: { ...EMPTY, credentialDir } });
    const outcome = await support.runtime.callTool("Read", { path: "creds/token.json" });
    expect(outcome.kind).toBe("error");
    const plain = await support.runtime.callTool("Read", { path: "creds" });
    expect(plain.kind).not.toBe("ok");
  });

  /**
   * US-003 AC-14: the session's `unsandboxedCommands` option reaches the Bash
   * tool it advertises. Read off `tools`, which is what the prompt is built
   * from -- an option the schema does not show the model does not exist.
   */
  test("unsandboxedCommands reaches the advertised Bash schema (and is absent without it)", async () => {
    const on = buildSessionToolSupport(await args({ profile: "full", unsandboxedCommands: true }));
    const bashOn = on.support.tools.find((tool) => tool.name === "Bash");
    if (bashOn === undefined) throw new Error("full must advertise Bash");
    expect(bashPropertyKeys(bashOn)).toContain("unsandboxed");

    const off = buildSessionToolSupport(await args({ profile: "full" }));
    const bashOff = off.support.tools.find((tool) => tool.name === "Bash");
    if (bashOff === undefined) throw new Error("full must advertise Bash");
    expect(bashPropertyKeys(bashOff)).not.toContain("unsandboxed");
    expect(bashPropertyKeys(bashOff)).not.toContain("unsandboxedReason");
  });
});

describe("resolveSessionLauncher", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  const launcherArgs = {
    root: "/work",
    protectedPaths: EMPTY,
    bashApproval: "gated" as const,
    allowUnsandboxed: false,
  };

  test("none and read need no sandbox, resolve a disabled state and never probe", async () => {
    let probed = 0;
    _sessionSandboxDeps.probe = async () => {
      probed += 1;
      return { available: true };
    };
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "none" })).toEqual({
      launcher: undefined,
      sandbox: { kind: "disabled" },
    });
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "read" })).toEqual({
      launcher: undefined,
      sandbox: { kind: "disabled" },
    });
    expect(probed).toBe(0);
  });

  // AC-13: the read profile is the tool-less case — disabled, and the probe is never asked.
  test("read resolves the disabled sandbox without calling the probe", async () => {
    let probed = 0;
    _sessionSandboxDeps.probe = async () => {
      probed += 1;
      return { available: true };
    };
    const result = await resolveSessionLauncher({ ...launcherArgs, profile: "read", bashApproval: "gated" });
    expect(result).toEqual({ launcher: undefined, sandbox: { kind: "disabled" } });
    expect(probed).toBe(0);
  });

  test("full with a usable sandbox returns an available launcher and its state", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const result = await resolveSessionLauncher({ ...launcherArgs, profile: "full" });
    expect(result.launcher?.state.kind).toBe("available");
    expect(result.sandbox.kind).toBe("available");
  });

  test("full without a sandbox fails with the probe's reason", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no sandbox backend on this host" });
    let caught: unknown;
    try {
      await resolveSessionLauncher({ ...launcherArgs, profile: "full" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
    expect(caught.message).toContain("no sandbox backend on this host");
  });

  test("ask without a sandbox fails like full, while none needs none", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no sandbox backend on this host" });
    let caught: unknown;
    try {
      await resolveSessionLauncher({ ...launcherArgs, profile: "ask" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
    expect((await resolveSessionLauncher({ ...launcherArgs, profile: "none" })).launcher).toBeUndefined();
  });

  test("gated with allowUnsandboxed runs without a launcher and reports the unavailable state", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "none" });
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "full", allowUnsandboxed: true })).toEqual({
      launcher: undefined,
      sandbox: { kind: "unavailable", backend: "srt", reason: "none" },
    });
  });

  // AC-9: raw plus the explicit fallback is the interactive host's "full" mode.
  test('full, raw and allowUnsandboxed with no sandbox returns no launcher and the "srt missing" state', async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "srt missing" });
    expect(
      await resolveSessionLauncher({
        profile: "full",
        bashApproval: "raw",
        allowUnsandboxed: true,
        root: "/work",
        protectedPaths: EMPTY,
      }),
    ).toEqual({
      launcher: undefined,
      sandbox: { kind: "unavailable", backend: "srt", reason: "srt missing" },
    });
  });

  // AC-10: without the opt-in the floor still holds, and the refusal says how to opt in.
  test("full, raw and no allowUnsandboxed still refuses, naming the fallback option", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "srt missing" });
    let caught: unknown;
    try {
      await resolveSessionLauncher({
        profile: "full",
        bashApproval: "raw",
        allowUnsandboxed: false,
        root: "/work",
        protectedPaths: EMPTY,
      });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
    expect(caught.message.endsWith("Pass allowUnsandboxed: true to run without one.")).toBe(true);
  });

  // AC-11 and AC-12: on a machine that has the sandbox, the opt-in changes nothing.
  test("full, raw and allowUnsandboxed keep a defined launcher and an available state", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const result = await resolveSessionLauncher({
      profile: "full",
      bashApproval: "raw",
      allowUnsandboxed: true,
      root: "/work",
      protectedPaths: EMPTY,
    });
    expect(result.launcher).toBeDefined();
    expect(result.sandbox.kind).toBe("available");
  });
});

describe("profile review (nax#2500)", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  test("declares the read tools plus Bash, no write tools", () => {
    const declared = declaredToolsFor("review", { ...EMPTY, gitIgnorePatterns: [".nax/"] });
    expect(declared).toContain("Bash");
    expect(declared).toContain("Git");
    expect(declared).not.toContain("Write");
    expect(declared).not.toContain("Edit");
    expect(declared).not.toContain("Delete");
    expect(declared).not.toContain("GitCommit");
  });

  test("the sandbox floor applies to review", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no srt" });
    await expect(
      resolveSessionLauncher({
        profile: "review",
        root: "/tmp/r",
        protectedPaths: EMPTY,
        bashApproval: "raw",
        allowUnsandboxed: false,
      }),
    ).rejects.toThrow('Profile "review" needs a usable sandbox');
  });
});

describe("session posture forwarding", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  test("AC-14: configured asks follow profile Bash asks and denies are forwarded", async () => {
    const spy = spyOn(codingSupport, "buildCodingToolSupport");
    const rule = { tool: "GitCommit" as const, patterns: ["*"] };
    const denyRules = [{ tool: "Delete" as const, patterns: ["keep/**"] }];
    try {
      buildSessionToolSupport(await args({ profile: "full", bashApproval: "gated", askRules: [rule], denyRules }));
      expect(spy.mock.calls[0]?.[0].askRules).toEqual([{ tool: "Bash", patterns: ["*"] }, rule]);
      expect(spy.mock.calls[0]?.[0].denyRules).toEqual(denyRules);
    } finally {
      spy.mockRestore();
    }
  });

  test("AC-15: disabled config and explicit fallback returns no launcher", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const result = await resolveSessionLauncher({
      profile: "full",
      root: "/work",
      protectedPaths: EMPTY,
      bashApproval: "raw",
      allowUnsandboxed: true,
      config: { ...DEFAULT_SANDBOX_CONFIG, enabled: false },
    });
    expect(result.sandbox.kind).toBe("disabled");
    expect(result.launcher).toBeUndefined();
  });

  test.each([false, true])("AC-16/17: backend receives default or configured domains (custom=%s)", async (custom) => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const configs: SandboxConfig[] = [];
    _sessionSandboxDeps.backendFor = (config) => {
      configs.push(config);
      return seam.backend;
    };
    const config = {
      ...DEFAULT_SANDBOX_CONFIG,
      network: { ...DEFAULT_SANDBOX_CONFIG.network, allowedDomains: ["registry.npmjs.org"] },
    };
    await resolveSessionLauncher({
      profile: "full",
      root: "/work",
      protectedPaths: EMPTY,
      bashApproval: "gated",
      allowUnsandboxed: false,
      ...(custom ? { config } : {}),
    });
    expect(configs).toEqual([custom ? config : DEFAULT_SANDBOX_CONFIG]);
  });
});

describe("buildSessionToolSupport discovered asks", () => {
  test.each([true, false])("AC-18/19: full provider asks opt-in=%s", async (ask) => {
    const spy = spyOn(codingSupport, "buildCodingToolSupport");
    try {
      buildSessionToolSupport(
        await args({
          profile: "full",
          bashApproval: "raw",
          ...(ask ? { askDiscoveredTools: true } : {}),
          providerTools: {
            tools: [],
            grants: [],
            askTools: ["docs__write"],
            providerIdByTool: new Map(),
            instructions: [],
            failures: [],
            skipped: [],
            withheld: [],
            entries: [],
          },
        }),
      );
      expect(spy.mock.calls[0]?.[0].askRules ?? []).toEqual(ask ? [{ tool: "docs__write", patterns: ["*"] }] : []);
    } finally {
      spy.mockRestore();
    }
  });
});

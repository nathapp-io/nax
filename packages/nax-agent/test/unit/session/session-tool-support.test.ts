/**
 * S3-4: profiles are capability statements (spec 4.5). This pins the tools
 * each profile advertises, GitCommit only with ignore patterns, the embedder
 * default protected-paths policy (spec 6.2), the credential read-deny reaching
 * Read, and the sandbox floor for "full" (spec 6.3).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
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
import { assertNaxError, stubSessionSandboxDeps, withDepsRestore, withSessionSandboxSeam } from "#test/helpers/index";

const EMPTY: ProtectedPathsPolicy = { gitExcludePathspecs: [], gitIgnorePatterns: [] };
// Typed so the profile assertions below check the literals against the real union.
const TRIO: readonly CodingToolName[] = ["ScratchpadWrite", "ScratchpadRead", "ScratchpadList"];

async function args(extra: Partial<SessionToolSupportArgs> = {}): Promise<SessionToolSupportArgs> {
  return {
    profile: "none",
    root: await mkdtemp(join(tmpdir(), "nax-session-tools-")),
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

  test("none and read need no sandbox and never probe", async () => {
    let probed = 0;
    _sessionSandboxDeps.probe = async () => {
      probed += 1;
      return { available: true };
    };
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "none" })).toBeUndefined();
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "read" })).toBeUndefined();
    expect(probed).toBe(0);
  });

  test("full with a usable sandbox returns an available launcher", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const launcher = await resolveSessionLauncher({ ...launcherArgs, profile: "full" });
    expect(launcher?.state.kind).toBe("available");
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
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "none" })).toBeUndefined();
  });

  test("gated with allowUnsandboxed runs without a launcher", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "none" });
    expect(await resolveSessionLauncher({ ...launcherArgs, profile: "full", allowUnsandboxed: true })).toBeUndefined();
  });
});

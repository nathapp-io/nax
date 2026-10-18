import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpBackend } from "#src/client/backend";
import { type AcpBackendOptions, resolveAcpOptions } from "#src/client/options";
import { ACP_AGENT_NAMES, registryEntry } from "#src/client/registry";
import { NO_RULES } from "#src/client/rule-policy";
import { sessionError, thrown } from "#test/helpers/errors";

const SOURCE = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-test-0123456789", AWS_SECRET_ACCESS_KEY: "x" };

function invalid(input: unknown): { readonly code: string; readonly path: unknown } {
  const err = sessionError(thrown(() => resolveAcpOptions(input, SOURCE)));
  return { code: err.code, path: err.context?.path };
}

describe("resolveAcpOptions: allowUnsandboxed (R7)", () => {
  test.each([undefined, false, "true", 1])("allowUnsandboxed %p is AGENT_SESSION_SANDBOX_UNAVAILABLE", (value) => {
    expect(invalid({ agent: "claude", allowUnsandboxed: value }).code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
  });

  test("checked before anything else, and for a non-object input", () => {
    expect(invalid({ agent: "nope" }).code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
    expect(invalid(null).code).toBe("AGENT_SESSION_SANDBOX_UNAVAILABLE");
  });
});

describe("resolveAcpOptions: registered agents (§6.2, §6.10)", () => {
  test("claude: kind, registry entry and candidates, defaults, allowlisted env and its secrets", () => {
    const resolved = resolveAcpOptions({ agent: "claude", allowUnsandboxed: true }, SOURCE);
    expect(resolved.kind).toBe("acp:claude");
    expect(resolved.agentName).toBe("claude");
    expect(resolved.entry).toBe(registryEntry("claude"));
    expect(resolved.launch).toEqual({ kind: "registry", candidates: registryEntry("claude")?.launch ?? [] });
    expect(resolved.cancelGraceMs).toBe(10_000);
    expect(resolved.initializeTimeoutMs).toBe(60_000);
    expect(resolved.model).toBeUndefined();
    expect(resolved.env).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-test-0123456789" });
    expect(resolved.secrets).toEqual(["sk-ant-test-0123456789"]);
  });

  test("a command override is explicit and keeps the registry entry", () => {
    const resolved = resolveAcpOptions(
      { agent: "claude", allowUnsandboxed: true, command: "/opt/acp/claude", args: ["--x"], model: "sonnet" },
      SOURCE,
    );
    expect(resolved.launch).toEqual({ kind: "explicit", candidate: { command: "/opt/acp/claude", args: ["--x"] } });
    expect(resolved.entry).toBe(registryEntry("claude"));
    expect(resolved.model).toBe("sonnet");
  });

  test("the zod enum matches the registry", () => {
    for (const name of ACP_AGENT_NAMES) {
      expect(resolveAcpOptions({ agent: name, allowUnsandboxed: true }, SOURCE).kind).toBe(`acp:${name}`);
    }
  });
});

describe("resolveAcpOptions: custom agents (§6.2, D-h)", () => {
  test("a custom agent has no registry entry and launches its own command", () => {
    const resolved = resolveAcpOptions(
      { agent: { name: "my-agent", command: "my-agent-acp", args: ["acp"] }, allowUnsandboxed: true },
      SOURCE,
    );
    expect(resolved.kind).toBe("acp:my-agent");
    expect(resolved.entry).toBeUndefined();
    expect(resolved.launch).toEqual({ kind: "explicit", candidate: { command: "my-agent-acp", args: ["acp"] } });
    expect(resolved.env).toEqual({ PATH: "/usr/bin" });
  });

  test.each(["claude", "Bad Name", "__proto__", "", "a".repeat(65)])("custom name %p is invalid", (name) => {
    expect(invalid({ agent: { name, command: "x" }, allowUnsandboxed: true }).code).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });

  test("a custom agent cannot also take a top-level command", () => {
    expect(invalid({ agent: { name: "my-agent", command: "a" }, command: "b", allowUnsandboxed: true })).toEqual({
      code: "AGENT_SESSION_INVALID_OPTIONS",
      path: "command",
    });
  });
});

describe("resolveAcpOptions: invalid input is AGENT_SESSION_INVALID_OPTIONS", () => {
  test.each([
    { agent: "aider" },
    { agent: "claude", args: ["x"] },
    { agent: "claude", command: "./bin/agent" },
    { agent: "claude", command: "bad\u0000cmd" },
    { agent: "claude", env: { "A=B": "1" } },
    { agent: "claude", env: { A: "x\u0000y" } },
    { agent: "claude", cancelGraceMs: 0 },
    { agent: "claude", initializeTimeoutMs: 1.5 },
    { agent: "claude", model: "" },
    { agent: "claude", unknown: true },
  ])("%p", (input) => {
    expect(invalid({ ...input, allowUnsandboxed: true }).code).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("the error names the offending option", () => {
    expect(invalid({ agent: "claude", args: ["x"], allowUnsandboxed: true }).path).toBe("args");
    expect(invalid({ agent: "claude", command: "./bin/agent", allowUnsandboxed: true }).path).toBe("command");
    expect(invalid({ agent: "claude", cancelGraceMs: 0, allowUnsandboxed: true }).path).toBe("cancelGraceMs");
  });

  test("bare and absolute commands are accepted", () => {
    expect(resolveAcpOptions({ agent: "claude", command: "agent", allowUnsandboxed: true }, SOURCE).launch.kind).toBe(
      "explicit",
    );
    expect(
      resolveAcpOptions({ agent: "claude", command: "/abs/agent", allowUnsandboxed: true }, SOURCE).launch.kind,
    ).toBe("explicit");
  });
});

describe("resolveAcpOptions: effort (S4b spec §8)", () => {
  test("absent by default; a non-empty string is kept", () => {
    expect(resolveAcpOptions({ agent: "claude", allowUnsandboxed: true }, SOURCE).effort).toBeUndefined();
    expect(resolveAcpOptions({ agent: "claude", allowUnsandboxed: true, effort: "high" }, SOURCE).effort).toBe("high");
  });

  test("an empty effort is AGENT_SESSION_INVALID_OPTIONS at effort", () => {
    expect(invalid({ agent: "claude", allowUnsandboxed: true, effort: "" })).toEqual({
      code: "AGENT_SESSION_INVALID_OPTIONS",
      path: "effort",
    });
  });
});

describe("resolveAcpOptions: onProcess (S4b spec §8)", () => {
  test("hooks are kept by reference; absent by default", () => {
    const hooks = { spawned: () => {}, exited: () => {} };
    expect(resolveAcpOptions({ agent: "claude", allowUnsandboxed: true }, SOURCE).onProcess).toBeUndefined();
    expect(resolveAcpOptions({ agent: "claude", allowUnsandboxed: true, onProcess: hooks }, SOURCE).onProcess).toBe(
      hooks,
    );
  });

  test.each<[unknown]>([[{ spawned: 1 }], ["x"], [{ exited: "no" }], [null]])(
    "onProcess %p is AGENT_SESSION_INVALID_OPTIONS",
    (onProcess) => {
      expect(invalid({ agent: "claude", allowUnsandboxed: true, onProcess })).toEqual({
        code: "AGENT_SESSION_INVALID_OPTIONS",
        path: "onProcess",
      });
    },
  );
});

const SHELL = { runtime: "/usr/local/bin/bun", runner: ["/opt/nax/nax.js", "sandbox", "exec"] };

describe("resolveAcpOptions: shellSandbox", () => {
  test("AC-1 defaults and frozen detached settings", () => {
    const result = resolveAcpOptions({ agent: "pi", allowUnsandboxed: true, shellSandbox: SHELL }, {});
    expect(result.shellSandbox).toEqual({
      ...SHELL,
      piExtensions: "user",
      opencodeProjectConfig: "disable",
      cursorOnUnwrapped: "rules",
    });
    expect(Object.isFrozen(result.shellSandbox)).toBe(true);
    expect(Object.isFrozen(result.shellSandbox?.runner)).toBe(true);
    expect(result.shellSandbox?.runner).not.toBe(SHELL.runner);
    expect(result).not.toHaveProperty("shellSandboxPlan");
  });
  test("AC-2 explicit knobs", () => {
    const result = resolveAcpOptions(
      {
        agent: "pi",
        allowUnsandboxed: true,
        shellSandbox: {
          ...SHELL,
          pi: { extensions: "none" },
          opencode: { projectConfig: "keep" },
          cursor: { onUnwrapped: "deny" },
        },
      },
      {},
    );
    expect(result.shellSandbox).toEqual({
      ...SHELL,
      piExtensions: "none",
      opencodeProjectConfig: "keep",
      cursorOnUnwrapped: "deny",
    });
  });
  test("AC-3 absent settings", () => {
    expect(resolveAcpOptions({ agent: "pi", allowUnsandboxed: true }, {}).shellSandbox).toBeUndefined();
  });
  test.each([
    ["AC-4", { ...SHELL, runtime: "bun" }, "shellSandbox.runtime"],
    ["AC-5", { ...SHELL, runner: [] }, "shellSandbox.runner"],
    ["AC-6 cursor", { ...SHELL, cursor: { onUnwrapped: "allow" } }, "shellSandbox.cursor.onUnwrapped"],
    ["AC-6 pi", { ...SHELL, pi: { extensions: "invalid" } }, "shellSandbox.pi.extensions"],
    ["AC-6 opencode", { ...SHELL, opencode: { projectConfig: "invalid" } }, "shellSandbox.opencode.projectConfig"],
  ])("%s rejects invalid settings", (_ac, shellSandbox, path) => {
    expect(invalid({ agent: "pi", allowUnsandboxed: true, shellSandbox })).toEqual({
      code: "AGENT_SESSION_INVALID_OPTIONS",
      path,
    });
  });
});

const OPENCODE = { agent: "opencode", allowUnsandboxed: true } as const;

describe("resolveAcpOptions: rules and stateDir (SPEC-cursor-pi-acp-read-only US-002)", () => {
  test("rules default to none and stateDir to the package's temp directory", () => {
    const resolved = resolveAcpOptions(OPENCODE, SOURCE);
    expect(resolved.rules).toEqual(NO_RULES);
    expect(resolved.stateDir).toBe(join(tmpdir(), "nax-agent-acp"));
  });

  test("rules are kept with the absent lists empty, and an absolute stateDir is kept", () => {
    const resolved = resolveAcpOptions(
      { ...OPENCODE, rules: { allow: [{ tool: "Bash", patterns: ["git status*"] }] }, stateDir: "/s" },
      SOURCE,
    );
    expect(resolved.rules).toEqual({ allow: [{ tool: "Bash", patterns: ["git status*"] }], deny: [], ask: [] });
    expect(resolved.stateDir).toBe("/s");
  });

  test("a relative stateDir is AGENT_SESSION_INVALID_OPTIONS at stateDir", () => {
    expect(invalid({ ...OPENCODE, stateDir: "relative/dir" })).toEqual({
      code: "AGENT_SESSION_INVALID_OPTIONS",
      path: "stateDir",
    });
  });

  test.each<[string, unknown, string]>([
    ["an empty pattern list", { allow: [{ tool: "Bash", patterns: [] }] }, "rules.allow.0"],
    ["a non-string pattern element", { deny: [{ tool: "Read", patterns: [3] }] }, "rules.deny.0"],
    ["an unknown rules key", { ask: [], unknown: true }, "rules"],
    ["a rule without a tool", { allow: [{ patterns: ["*"] }] }, "rules.allow.0"],
  ])("%s is AGENT_SESSION_INVALID_OPTIONS inside rules", (_label, rules, prefix) => {
    const err = sessionError(thrown(() => resolveAcpOptions({ ...OPENCODE, rules }, SOURCE)));
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(String(err.context?.path)).toStartWith(prefix);
  });

  test("acpBackend rejects a relative stateDir before anything else", () => {
    const err = sessionError(thrown(() => acpBackend({ ...OPENCODE, stateDir: "relative/dir" })));
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(err.context).toMatchObject({ path: "stateDir" });
  });

  test("acpBackend rejects a rule whose patterns are empty", () => {
    const err = sessionError(
      thrown(() => acpBackend({ ...OPENCODE, rules: { allow: [{ tool: "Bash", patterns: [] }] } })),
    );
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(String(err.context?.path)).toStartWith("rules.allow.0");
  });

  // A number where a pattern string belongs has no TypeScript spelling: the zod schema is
  // the gate for it, so the fixture is data rather than a cast (test/ escapes are ratcheted).
  const untypedRules = (json: string): NonNullable<AcpBackendOptions["rules"]> => JSON.parse(json);

  test("acpBackend rejects a rule whose patterns hold a non-string", () => {
    const rules = untypedRules('{"deny":[{"tool":"Read","patterns":[3]}]}');
    const err = sessionError(thrown(() => acpBackend({ ...OPENCODE, rules })));
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(String(err.context?.path)).toStartWith("rules.deny.0");
  });
});

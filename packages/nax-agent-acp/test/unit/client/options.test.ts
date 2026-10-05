import { describe, expect, test } from "bun:test";
import { resolveAcpOptions } from "#src/client/options";
import { ACP_AGENT_NAMES, registryEntry } from "#src/client/registry";
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

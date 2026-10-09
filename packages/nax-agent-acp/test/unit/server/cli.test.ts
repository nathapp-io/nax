import { describe, expect, test } from "bun:test";
import { parseCli, USAGE } from "#src/server/cli";

describe("parseCli", () => {
  test("no arguments and the explicit acp command both serve ACP with no flags", () => {
    expect(parseCli([])).toEqual({ kind: "acp", flags: {} });
    expect(parseCli(["acp"])).toEqual({ kind: "acp", flags: {} });
  });

  test("maps every option to its flag", () => {
    expect(
      parseCli([
        "--config-dir",
        "/c",
        "--sessions-dir",
        "/s",
        "--model",
        "minimax/MiniMax-M3",
        "--mode",
        "read",
        "--bash-approval",
        "escalate",
      ]),
    ).toEqual({
      kind: "acp",
      flags: {
        configDir: "/c",
        sessionsDir: "/s",
        model: "minimax/MiniMax-M3",
        mode: "read",
        bashApproval: "escalate",
      },
    });
  });

  test("--help wins over --version, and both win over a command", () => {
    expect(parseCli(["--version", "--help"])).toEqual({ kind: "help" });
    expect(parseCli(["acp", "--version"])).toEqual({ kind: "version" });
  });

  test("an unknown option or command is a usage error", () => {
    expect(parseCli(["--nope"])).toMatchObject({ kind: "usage-error" });
    expect(parseCli(["serve"])).toEqual({ kind: "usage-error", message: "unknown command: serve" });
    expect(parseCli(["acp", "extra"])).toEqual({ kind: "usage-error", message: "unknown command: acp extra" });
  });

  test("a string option without a value is a usage error", () => {
    expect(parseCli(["--model"])).toMatchObject({ kind: "usage-error" });
  });

  test("--mcp-connect-timeout is a flag", () => {
    expect(parseCli(["acp", "--mcp-connect-timeout", "45"])).toEqual({
      kind: "acp",
      flags: { mcpConnectTimeout: "45" },
    });
  });

  test("USAGE names every option and the env prefix", () => {
    for (const option of ["--config-dir", "--sessions-dir", "--model", "--mode", "--bash-approval", "--version"]) {
      expect(USAGE).toContain(option);
    }
    expect(USAGE).toContain("NAX_AGENT_");
  });
});

describe("login (S5-4)", () => {
  test("login <provider>", () => {
    expect(parseCli(["login", "anthropic"])).toEqual({ kind: "login", provider: "anthropic", flags: {} });
  });

  test("the editor appends login to its server invocation (Review Focus 1, M-34)", () => {
    expect(parseCli(["acp", "--model", "x/y", "login", "anthropic"])).toEqual({
      kind: "login",
      provider: "anthropic",
      flags: { model: "x/y" },
    });
  });

  test("--method is forwarded when valid", () => {
    expect(parseCli(["login", "openrouter", "--method", "oauth"])).toMatchObject({ method: "oauth" });
    expect(parseCli(["login", "openrouter", "--method", "sso"])).toEqual({
      kind: "usage-error",
      message: 'invalid --method "sso"; expected api-key or oauth',
    });
  });

  test("login needs exactly one provider", () => {
    expect(parseCli(["login"]).kind).toBe("usage-error");
    expect(parseCli(["login", "a", "b"]).kind).toBe("usage-error");
  });

  test("--method without login is a usage error", () => {
    expect(parseCli(["--method", "oauth"])).toEqual({
      kind: "usage-error",
      message: "--method is only valid with login",
    });
  });

  test("unknown words still report the whole command", () => {
    expect(parseCli(["serve"])).toEqual({ kind: "usage-error", message: "unknown command: serve" });
  });
});

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

  test("USAGE names every option and the env prefix", () => {
    for (const option of ["--config-dir", "--sessions-dir", "--model", "--mode", "--bash-approval", "--version"]) {
      expect(USAGE).toContain(option);
    }
    expect(USAGE).toContain("NAX_AGENT_");
  });
});

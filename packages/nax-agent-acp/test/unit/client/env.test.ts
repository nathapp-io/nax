import { describe, expect, test } from "bun:test";
import { buildAgentEnv, secretValues } from "#src/client/env";

const SOURCE = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  USER: "u",
  SHELL: "/bin/zsh",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  LC_CTYPE: "UTF-8",
  TERM: "xterm",
  ANTHROPIC_API_KEY: "sk-ant-test-0123456789",
  AWS_SECRET_ACCESS_KEY: "aws-secret-value",
  GITHUB_TOKEN: "ghp_value",
  NODE_OPTIONS: "--inspect",
  UNSET: undefined,
};

describe("buildAgentEnv (spec §6.2)", () => {
  test("the allowlist keeps the base keys, LC_*, and the agent's auth variables only", () => {
    expect(buildAgentEnv({ source: SOURCE, inheritEnv: false, authEnv: ["ANTHROPIC_API_KEY"], extra: {} })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TERM: "xterm",
      ANTHROPIC_API_KEY: "sk-ant-test-0123456789",
    });
  });

  test("env is added and wins over the source", () => {
    const env = buildAgentEnv({ source: SOURCE, inheritEnv: false, authEnv: [], extra: { PATH: "/opt/bin", X: "1" } });
    expect(env.PATH).toBe("/opt/bin");
    expect(env.X).toBe("1");
  });

  test("inheritEnv passes the whole source, minus unset values, plus env", () => {
    const env = buildAgentEnv({ source: SOURCE, inheritEnv: true, authEnv: [], extra: { X: "1" } });
    expect(env.GITHUB_TOKEN).toBe("ghp_value");
    expect(env.NODE_OPTIONS).toBe("--inspect");
    expect("UNSET" in env).toBe(false);
    expect(env.X).toBe("1");
  });
});

describe("secretValues (D-g)", () => {
  test("values of KEY, TOKEN, SECRET and PASSWORD keys, any case, non-empty only", () => {
    expect(
      secretValues({
        ANTHROPIC_API_KEY: "a-value",
        my_token: "t-value",
        DbPassword: "p-value",
        CLIENT_SECRET: "",
        PATH: "/usr/bin",
      }),
    ).toEqual(["a-value", "t-value", "p-value"]);
  });
});

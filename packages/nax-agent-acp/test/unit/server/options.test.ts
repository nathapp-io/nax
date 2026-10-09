import { describe, expect, test } from "bun:test";
import type { CliFlags } from "#src/server/cli";
import { EMPTY_NAX_CONFIG, type NaxConfigSubset } from "#src/server/nax-config";
import { type Env, resolveConfigDir, resolveServerOptions } from "#src/server/options";

const FILE: NaxConfigSubset = {
  ...EMPTY_NAX_CONFIG,
  tiers: [
    { tier: "fast", model: "a/fast" },
    { tier: "balanced", model: "a/balanced", contextWindow: 1000 },
  ],
  agentServer: { defaultMode: "full", bashApproval: "escalate", sessionsDir: "/file-sessions" },
};

function resolveWith(input: { flags?: CliFlags; env?: Env; config?: number }) {
  return resolveServerOptions({
    flags: input.flags ?? {},
    env: input.env ?? {},
    file: {
      ...EMPTY_NAX_CONFIG,
      agentServer: input.config === undefined ? {} : { mcpConnectTimeoutSeconds: input.config },
    },
    configDir: "/cfg",
  });
}

function ok(result: ReturnType<typeof resolveWith>) {
  if (!result.ok) throw new Error(result.message);
  return result.options;
}

describe("resolveConfigDir", () => {
  test("flag > NAX_AGENT_CONFIG_DIR > NAX_GLOBAL_CONFIG_DIR > ~/.nax", () => {
    const env = { NAX_AGENT_CONFIG_DIR: "/agent", NAX_GLOBAL_CONFIG_DIR: "/global" };
    expect(resolveConfigDir({ configDir: "/flag" }, env, "/home/u")).toBe("/flag");
    expect(resolveConfigDir({}, env, "/home/u")).toBe("/agent");
    expect(resolveConfigDir({}, { NAX_GLOBAL_CONFIG_DIR: "/global" }, "/home/u")).toBe("/global");
    expect(resolveConfigDir({}, {}, "/home/u")).toBe("/home/u/.nax");
  });
});

describe("resolveServerOptions", () => {
  test("built-in defaults when nothing is set", () => {
    expect(resolveServerOptions({ flags: {}, env: {}, file: EMPTY_NAX_CONFIG, configDir: "/cfg" })).toEqual({
      ok: true,
      options: {
        configDir: "/cfg",
        sessionsDir: "/cfg/.agent-server/sessions",
        defaultMode: "ask",
        bashApproval: "gated",
        tiers: [],
        catalogOverrides: [],
        mcpConnectTimeoutSeconds: 30,
      },
    });
  });

  test("the file overrides the defaults; the balanced tier is the default model", () => {
    const result = resolveServerOptions({ flags: {}, env: {}, file: FILE, configDir: "/cfg" });
    expect(result).toMatchObject({
      ok: true,
      options: {
        sessionsDir: "/file-sessions",
        defaultModel: "a/balanced",
        defaultMode: "full",
        bashApproval: "escalate",
        mcpConnectTimeoutSeconds: 30,
      },
    });
  });

  test("env overrides the file; a flag overrides env", () => {
    const env = {
      NAX_AGENT_MODEL: "env/model",
      NAX_AGENT_MODE: "read",
      NAX_AGENT_BASH_APPROVAL: "raw",
      NAX_AGENT_SESSIONS_DIR: "/env-sessions",
    };
    expect(resolveServerOptions({ flags: {}, env, file: FILE, configDir: "/cfg" })).toMatchObject({
      ok: true,
      options: { defaultModel: "env/model", defaultMode: "read", bashApproval: "raw", sessionsDir: "/env-sessions" },
    });
    const flags = { model: "flag/model", mode: "none", bashApproval: "gated", sessionsDir: "/flag-sessions" };
    expect(resolveServerOptions({ flags, env, file: FILE, configDir: "/cfg" })).toMatchObject({
      ok: true,
      options: {
        defaultModel: "flag/model",
        defaultMode: "none",
        bashApproval: "gated",
        sessionsDir: "/flag-sessions",
      },
    });
  });

  test("an unknown mode or bash approval is an error naming the source", () => {
    expect(resolveServerOptions({ flags: { mode: "yolo" }, env: {}, file: FILE, configDir: "/c" })).toEqual({
      ok: false,
      message: 'invalid mode "yolo" (from --mode); expected one of none, read, ask, full',
    });
    expect(
      resolveServerOptions({ flags: {}, env: { NAX_AGENT_BASH_APPROVAL: "x" }, file: FILE, configDir: "/c" }),
    ).toEqual({
      ok: false,
      message: 'invalid bash approval "x" (from NAX_AGENT_BASH_APPROVAL); expected one of gated, escalate, raw',
    });
  });

  test("mode ask requires gated bash approval (raw and escalate are refused up front)", () => {
    for (const bashApproval of ["raw", "escalate"]) {
      expect(
        resolveServerOptions({ flags: { mode: "ask", bashApproval }, env: {}, file: FILE, configDir: "/c" }),
      ).toEqual({
        ok: false,
        message: `bash approval "${bashApproval}" cannot be used with mode "ask"; ask requires gated`,
      });
    }
  });

  test("no default model at all is allowed at startup (session/new reports it)", () => {
    const result = resolveServerOptions({ flags: {}, env: {}, file: EMPTY_NAX_CONFIG, configDir: "/c" });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.options.defaultModel : "not-ok").toBeUndefined();
  });
});

describe("mcpConnectTimeoutSeconds", () => {
  test("defaults to 30", () => {
    expect(ok(resolveWith({})).mcpConnectTimeoutSeconds).toBe(30);
  });

  test("flag > env > config", () => {
    expect(
      ok(resolveWith({ flags: { mcpConnectTimeout: "10" }, env: { NAX_AGENT_MCP_CONNECT_TIMEOUT: "20" }, config: 40 }))
        .mcpConnectTimeoutSeconds,
    ).toBe(10);
    expect(ok(resolveWith({ env: { NAX_AGENT_MCP_CONNECT_TIMEOUT: "20" }, config: 40 })).mcpConnectTimeoutSeconds).toBe(
      20,
    );
    expect(ok(resolveWith({ config: 40 })).mcpConnectTimeoutSeconds).toBe(40);
  });

  test.each(["0", "301", "1.5", "abc"])("rejects %s", (value) => {
    const result = resolveWith({ flags: { mcpConnectTimeout: value } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("mcp connect timeout");
  });
});

import { describe, expect, test } from "bun:test";
import { acpEnvSettings, withAcpEnv } from "@/agents/shared/acp-env";
import { acpShellSandboxSettings, withAcpShellSandboxEnv } from "@/agents/shared/acp-shell-sandbox-env";
import { DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG, NaxConfigSchema } from "@/config";

const defaults = {
  mode: "auto" as const,
  pi: { extensions: "user" as const },
  opencode: { projectConfig: "disable" as const },
  cursor: { onUnwrapped: "rules" as const },
};
const carrier = JSON.stringify({ pi: defaults.pi, opencode: defaults.opencode, cursor: defaults.cursor });
const def: { provider: string; model: string; env: Record<string, string> } = {
  provider: "p",
  model: "m",
  env: { A: "1" },
};

describe("US-006 shell sandbox settings and env", () => {
  test("AC-1: the shell sandbox defaults on at every config depth", () => {
    for (const input of [{}, { agent: {} }, { agent: { acp: {} } }, { agent: { acp: { shellSandbox: {} } } }]) {
      expect(NaxConfigSchema.parse(input).agent?.acp?.shellSandbox).toEqual(defaults);
    }
  });

  test("AC-2: invalid mode reports the mode path", () => {
    const result = NaxConfigSchema.safeParse({ agent: { acp: { shellSandbox: { mode: "sometimes" } } } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.at(-1) === "mode")).toBe(true);
  });

  test("AC-3: settings use the exported default and fill nested partial settings", () => {
    expect(acpShellSandboxSettings(undefined)).toEqual(DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG);
    expect(acpShellSandboxSettings({ agent: { acp: { shellSandbox: { pi: { extensions: "none" } } } } })).toEqual({
      ...defaults,
      pi: { extensions: "none" },
    });
  });

  test.each(["pi", "cursor", "opencode"])("AC-4: %s receives a new def without mutation", (agent) => {
    const out = withAcpShellSandboxEnv(def, agent, defaults);
    expect(out).not.toBe(def);
    expect(out.env).toEqual({ A: "1", NAX_ACP_SHELL_SANDBOX: carrier });
    expect(def.env).toEqual({ A: "1" });
  });

  test("AC-5: claude gets the input itself", () => {
    expect(withAcpShellSandboxEnv(def, "claude", defaults)).toBe(def);
  });
  test("AC-6: codex is checked before reading settings", () => {
    const unreadableSettings = new Proxy(defaults, {
      get() {
        throw new Error("settings must not be read for codex");
      },
    });
    expect(withAcpShellSandboxEnv(def, "codex", unreadableSettings)).toBe(def);
  });
  test("AC-7: off leaves cursor untouched", () => {
    expect(withAcpShellSandboxEnv(def, "cursor", { ...defaults, mode: "off" })).toBe(def);
  });
  test("AC-8: composed opencode env carries the sandbox settings", () => {
    expect(withAcpEnv(def, "opencode", acpEnvSettings(undefined)).env.NAX_ACP_SHELL_SANDBOX).toBe(carrier);
  });
});

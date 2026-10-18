/**
 * acp-env (US-002, opencode-acp-read-only) — the one seam that composes every
 * ACP launch env injection, so a caller can no longer pick up one agent's
 * variable set and silently drop another's.
 *
 * Every deps seam is stubbed: `withAcpEnv` delegates to `withCodexAcpEnv`,
 * `withOpencodeAcpEnv` and `withGeminiAcpEnv`, and none of them may touch this
 * developer's real `~/.nax/acp/` or `~/.gemini` in a test.
 */

import { describe, expect, test } from "bun:test";
import { stubCodexAcpEnvDeps, stubGeminiAcpEnvDeps, stubOpencodeAcpEnvDeps, withDepsRestore } from "@test/helpers";
import { acpEnvSettings, withAcpEnv } from "@/agents/shared/acp-env";
import { _codexAcpEnvDeps } from "@/agents/shared/codex-acp-env";
import { _geminiAcpEnvDeps, isolatedGeminiHomeDir } from "@/agents/shared/gemini-acp-env";
import { _opencodeAcpEnvDeps, isolatedOpencodeConfigDir } from "@/agents/shared/opencode-acp-env";
import { DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG } from "@/config";

withDepsRestore(_codexAcpEnvDeps);
withDepsRestore(_opencodeAcpEnvDeps);
withDepsRestore(_geminiAcpEnvDeps);

/** A def shaped like the model defs `selectModel` / `complete()` hand the adapter. */
function makeDef(env: Record<string, string> = { A: "1" }): {
  provider: string;
  model: string;
  env: Record<string, string>;
} {
  return { provider: "p", model: "m", env };
}

describe("acpEnvSettings", () => {
  test("AC-25: both configured blocks are returned verbatim", () => {
    expect(
      acpEnvSettings({
        agent: {
          acp: {
            codex: { isolateHome: false, fullMode: "agent-full-access" },
            opencode: { isolateConfig: true },
            gemini: { isolateHome: true },
          },
        },
      }),
    ).toEqual({
      codex: { isolateHome: false, fullMode: "agent-full-access" },
      opencode: { isolateConfig: true },
      gemini: { isolateHome: true },
      shellSandbox: DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG,
    });
  });

  test("AC-26: undefined config yields both schema defaults", () => {
    expect(acpEnvSettings(undefined)).toEqual({
      codex: { isolateHome: false, fullMode: "workspace-write" },
      opencode: { isolateConfig: false },
      gemini: { isolateHome: false },
      shellSandbox: DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG,
    });
  });

  test("AC-32: a configured gemini block is returned verbatim", () => {
    expect(acpEnvSettings({ agent: { acp: { gemini: { isolateHome: true } } } }).gemini).toEqual({
      isolateHome: true,
    });
  });

  test("AC-33: undefined config yields the gemini schema default", () => {
    expect(acpEnvSettings(undefined).gemini).toEqual({ isolateHome: false });
  });
});

describe("withAcpEnv", () => {
  test("AC-27/AC-28: a codex def gets INITIAL_AGENT_MODE and no OPENCODE_CONFIG_DIR", () => {
    const codexDeps = stubCodexAcpEnvDeps();
    const opencodeDeps = stubOpencodeAcpEnvDeps();
    stubGeminiAcpEnvDeps();

    const out = withAcpEnv(makeDef(), "codex", {
      codex: { isolateHome: false, fullMode: "workspace-write" },
      opencode: { isolateConfig: true },
      gemini: { isolateHome: false },
      shellSandbox: { ...DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG, mode: "off" },
    });

    expect(out.env.INITIAL_AGENT_MODE).toBe("workspace-write");
    expect(out.env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(codexDeps.mkdir).not.toHaveBeenCalled();
    expect(opencodeDeps.mkdir).not.toHaveBeenCalled();
  });

  test("AC-29/AC-30/AC-31: an opencode def gets OPENCODE_CONFIG_DIR and no codex keys", () => {
    stubCodexAcpEnvDeps();
    stubOpencodeAcpEnvDeps();
    stubGeminiAcpEnvDeps();

    const out = withAcpEnv(makeDef(), "opencode", {
      codex: { isolateHome: true, fullMode: "agent-full-access" },
      opencode: { isolateConfig: true },
      gemini: { isolateHome: false },
      shellSandbox: { ...DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG, mode: "off" },
    });

    expect(out.env.OPENCODE_CONFIG_DIR).toBe(isolatedOpencodeConfigDir());
    expect(out.env.INITIAL_AGENT_MODE).toBeUndefined();
    expect(out.env.CODEX_HOME).toBeUndefined();
  });

  // US-002 (gemini-acp-read-only): the same settings object carries the gemini
  // block, so neither caller needs a fourth parameter for it.
  test("AC-34/AC-35: a gemini def gets GEMINI_CLI_HOME and no other agent's keys", () => {
    stubCodexAcpEnvDeps();
    stubOpencodeAcpEnvDeps();
    stubGeminiAcpEnvDeps();

    const out = withAcpEnv(makeDef(), "gemini", {
      codex: { isolateHome: true, fullMode: "agent-full-access" },
      opencode: { isolateConfig: true },
      gemini: { isolateHome: true },
      shellSandbox: { ...DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG, mode: "off" },
    });

    expect(out.env.GEMINI_CLI_HOME).toBe(isolatedGeminiHomeDir());
    expect(out.env.INITIAL_AGENT_MODE).toBeUndefined();
    expect(out.env.CODEX_HOME).toBeUndefined();
    expect(out.env.OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  test("AC-36/AC-37: a codex def keeps INITIAL_AGENT_MODE and gains no GEMINI_CLI_HOME", () => {
    stubCodexAcpEnvDeps();
    stubOpencodeAcpEnvDeps();
    const geminiDeps = stubGeminiAcpEnvDeps();

    const out = withAcpEnv(makeDef(), "codex", {
      codex: { isolateHome: false, fullMode: "workspace-write" },
      opencode: { isolateConfig: false },
      gemini: { isolateHome: true },
      shellSandbox: { ...DEFAULT_AGENT_ACP_SHELL_SANDBOX_CONFIG, mode: "off" },
    });

    expect(out.env.INITIAL_AGENT_MODE).toBe("workspace-write");
    expect("GEMINI_CLI_HOME" in out.env).toBe(false);
    expect(geminiDeps.mkdir).not.toHaveBeenCalled();
  });
});

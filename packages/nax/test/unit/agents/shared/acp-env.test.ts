/**
 * acp-env (US-002, opencode-acp-read-only) — the one seam that composes every
 * ACP launch env injection, so a caller can no longer pick up one agent's
 * variable set and silently drop another's.
 *
 * Both deps seams are stubbed: `withAcpEnv` delegates to `withCodexAcpEnv` and
 * `withOpencodeAcpEnv`, and neither may touch this developer's real
 * `~/.nax/acp/` in a test.
 */

import { describe, expect, test } from "bun:test";
import { stubCodexAcpEnvDeps, stubOpencodeAcpEnvDeps, withDepsRestore } from "@test/helpers";
import { acpEnvSettings, withAcpEnv } from "@/agents/shared/acp-env";
import { _codexAcpEnvDeps } from "@/agents/shared/codex-acp-env";
import { _opencodeAcpEnvDeps, isolatedOpencodeConfigDir } from "@/agents/shared/opencode-acp-env";

withDepsRestore(_codexAcpEnvDeps);
withDepsRestore(_opencodeAcpEnvDeps);

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
          acp: { codex: { isolateHome: false, fullMode: "agent-full-access" }, opencode: { isolateConfig: true } },
        },
      }),
    ).toEqual({
      codex: { isolateHome: false, fullMode: "agent-full-access" },
      opencode: { isolateConfig: true },
    });
  });

  test("AC-26: undefined config yields both schema defaults", () => {
    expect(acpEnvSettings(undefined)).toEqual({
      codex: { isolateHome: false, fullMode: "workspace-write" },
      opencode: { isolateConfig: false },
    });
  });
});

describe("withAcpEnv", () => {
  test("AC-27/AC-28: a codex def gets INITIAL_AGENT_MODE and no OPENCODE_CONFIG_DIR", () => {
    const codexDeps = stubCodexAcpEnvDeps();
    const opencodeDeps = stubOpencodeAcpEnvDeps();

    const out = withAcpEnv(makeDef(), "codex", {
      codex: { isolateHome: false, fullMode: "workspace-write" },
      opencode: { isolateConfig: true },
    });

    expect(out.env.INITIAL_AGENT_MODE).toBe("workspace-write");
    expect(out.env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(codexDeps.mkdir).not.toHaveBeenCalled();
    expect(opencodeDeps.mkdir).not.toHaveBeenCalled();
  });

  test("AC-29/AC-30/AC-31: an opencode def gets OPENCODE_CONFIG_DIR and no codex keys", () => {
    stubCodexAcpEnvDeps();
    stubOpencodeAcpEnvDeps();

    const out = withAcpEnv(makeDef(), "opencode", {
      codex: { isolateHome: true, fullMode: "agent-full-access" },
      opencode: { isolateConfig: true },
    });

    expect(out.env.OPENCODE_CONFIG_DIR).toBe(isolatedOpencodeConfigDir());
    expect(out.env.INITIAL_AGENT_MODE).toBeUndefined();
    expect(out.env.CODEX_HOME).toBeUndefined();
  });
});

/**
 * `nax agents` with agent.acp.transport "sdk" (S4b spec §9): install status comes
 * from the ACP launcher (launchCandidateKind), not from `which acpx`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { makeNaxConfig, makeTempDir } from "@test/helpers";
import { _acpSdkDeps } from "@/agents/acp-sdk";
import { _cliAgentsDeps, agentsListCommand } from "@/cli/agents";
import type { NaxConfig } from "@/config";

const SDK_CONFIG: NaxConfig = makeNaxConfig({ agent: { acp: { transport: "sdk" } } });

describe("agentsListCommand on the sdk transport", () => {
  let testDir: string;
  const REAL_SDK = { ..._acpSdkDeps };
  let origGetAgentVersion: typeof _cliAgentsDeps.getAgentVersion;

  beforeAll(() => {
    testDir = makeTempDir("nax-agents-sdk-test-");
  });
  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    origGetAgentVersion = _cliAgentsDeps.getAgentVersion;
    _cliAgentsDeps.getAgentVersion = async () => "1.0.0";
    _acpSdkDeps.launchCandidateKind = (agent) => (agent === "claude" ? "local" : undefined);
  });
  afterEach(() => {
    _cliAgentsDeps.getAgentVersion = origGetAgentVersion;
    Object.assign(_acpSdkDeps, REAL_SDK);
  });

  async function listOutput(config: NaxConfig): Promise<string> {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += `${message}\n`;
    };
    try {
      await agentsListCommand(config, testDir);
      return output;
    } finally {
      console.log = originalLog;
    }
  }

  test("claude shows installed through its ACP launcher; the others do not", async () => {
    const output = await listOutput(SDK_CONFIG);
    const claudeLine = output.split("\n").find((line) => /claude/i.test(line)) ?? "";
    expect(claudeLine.toLowerCase()).toContain("installed");
    const codexLine = output.split("\n").find((line) => /codex/i.test(line)) ?? "";
    expect(codexLine.toLowerCase()).not.toMatch(/\binstalled\b/);
  });

  test("lists the same agents as the acpx transport", async () => {
    const output = await listOutput(SDK_CONFIG);
    for (const name of ["claude", "codex", "opencode", "gemini", "pi"]) expect(output.toLowerCase()).toContain(name);
  });
});

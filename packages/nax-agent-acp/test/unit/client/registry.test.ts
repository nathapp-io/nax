import { describe, expect, test } from "bun:test";
import {
  ACP_AGENT_NAMES,
  type AcpAgentName,
  isAcpAgentName,
  type LaunchCandidate,
  registryEntry,
} from "#src/client/registry";

describe("ACP agent registry (S4 spec §6.10)", () => {
  test("registers exactly the five agents", () => {
    expect([...ACP_AGENT_NAMES]).toEqual(["claude", "codex", "gemini", "opencode", "pi"]);
  });

  test("claude: local adapter first, pinned npx fallback, read-only enforcement, default mode, pre-approval, auth env", () => {
    expect(registryEntry("claude")).toEqual({
      name: "claude",
      launch: [
        { command: "claude-agent-acp", args: [] },
        { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@~0.85.1"] },
      ],
      readOnly: {
        mode: { configId: "mode", value: "default" },
        disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "EnterPlanMode"],
        sessionOptions: { settingSources: [], allowDangerouslySkipPermissions: false },
      },
      defaultMode: { configId: "mode", value: "default" },
      preApproval: "claudeCode.allowedTools",
      authEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    });
  });

  test.each<[AcpAgentName, LaunchCandidate[], string[]]>([
    [
      "codex",
      [
        { command: "codex-acp", args: [] },
        { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@~2.1.1"] },
      ],
      ["OPENAI_API_KEY"],
    ],
    ["gemini", [{ command: "gemini", args: ["--acp"] }], ["GEMINI_API_KEY"]],
    ["opencode", [{ command: "opencode", args: ["acp"] }], []],
    [
      "pi",
      [
        { command: "pi-acp", args: [] },
        { command: "npx", args: ["-y", "pi-acp@0.0.34"] },
      ],
      [],
    ],
  ])("%s: launch candidates and auth env; no read-only enforcement, no pre-approval", (name, launch, authEnv) => {
    expect(registryEntry(name)).toEqual({
      name,
      launch,
      readOnly: undefined,
      defaultMode: undefined,
      preApproval: undefined,
      authEnv,
    });
  });

  test("pi's npx fallback pins an exact version (a tilde does not pin 0.0.x)", () => {
    expect(registryEntry("pi")?.launch.at(-1)?.args.at(-1)).toBe("pi-acp@0.0.34");
  });

  test.each(["__proto__", "toString", "constructor", "hasOwnProperty", "Claude", "", "custom"])(
    "an unregistered or prototype name %j has no entry",
    (name) => {
      expect(registryEntry(name)).toBeUndefined();
      expect(isAcpAgentName(name)).toBe(false);
    },
  );

  test("entries are deeply frozen", () => {
    const entry = registryEntry("claude");
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.launch)).toBe(true);
    expect(Object.isFrozen(entry?.launch[1]?.args)).toBe(true);
    expect(Object.isFrozen(entry?.readOnly)).toBe(true);
    expect(Object.isFrozen(entry?.readOnly?.mode)).toBe(true);
    expect(Object.isFrozen(entry?.readOnly?.disallowedTools)).toBe(true);
    expect(Object.isFrozen(entry?.readOnly?.sessionOptions)).toBe(true);
    expect(Object.isFrozen(entry?.readOnly?.sessionOptions.settingSources)).toBe(true);
    expect(Object.isFrozen(entry?.authEnv)).toBe(true);
    expect(Object.isFrozen(ACP_AGENT_NAMES)).toBe(true);
  });

  test("only an agent with a pre-approval channel declares read-only enforcement", () => {
    for (const name of ACP_AGENT_NAMES) {
      const entry = registryEntry(name);
      if (entry?.readOnly !== undefined) expect(entry.preApproval).toBeDefined();
    }
  });
});

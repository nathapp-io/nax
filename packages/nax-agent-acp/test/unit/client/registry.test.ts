import { describe, expect, test } from "bun:test";
import {
  ACP_AGENT_NAMES,
  isAcpAgentName,
  OPENCODE_NONE_CONFIG,
  OPENCODE_READ_CONFIG,
  OPENCODE_REVIEW_CONFIG,
  registryEntry,
} from "#src/client/registry";

describe("ACP agent registry (S4 spec §6.10)", () => {
  test("registers exactly the six agents, cursor after codex", () => {
    expect([...ACP_AGENT_NAMES]).toEqual(["claude", "codex", "cursor", "gemini", "opencode", "pi"]);
  });

  test("cursor: launch candidates and auth env; read-only mode ask, its permission config as policy, no default mode, no pre-approval", () => {
    expect(registryEntry("cursor")).toEqual({
      name: "cursor",
      launch: [{ command: "cursor-agent", args: ["acp"] }],
      readOnly: {
        mode: { configId: "mode", value: "ask" },
        reviewShellMode: { configId: "mode", value: "agent" },
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {},
        policy: "cursor",
      },
      defaultMode: undefined,
      preApproval: undefined,
      authEnv: ["CURSOR_API_KEY"],
    });
  });

  test("cursor: none, read and review are enforced by its ask mode and its permission config", () => {
    expect(registryEntry("cursor")?.readOnly).toEqual({
      mode: { configId: "mode", value: "ask" },
      reviewShellMode: { configId: "mode", value: "agent" },
      disallowedTools: [],
      sessionOptions: {},
      launchEnv: {},
      policy: "cursor",
    });
  });

  test("cursor declares no default mode and no pre-approval channel", () => {
    expect(registryEntry("cursor")?.defaultMode).toBeUndefined();
    expect(registryEntry("cursor")?.preApproval).toBeUndefined();
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
        launchEnv: {},
        policy: undefined,
      },
      defaultMode: { configId: "mode", value: "default" },
      preApproval: "claudeCode.allowedTools",
      authEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    });
  });

  test("pi: launch candidates and auth env; read-only by its own tool allowlist and shell gate (US-004)", () => {
    expect(registryEntry("pi")).toEqual({
      name: "pi",
      launch: [
        { command: "pi-acp", args: [] },
        { command: "npx", args: ["-y", "pi-acp@0.0.34"] },
      ],
      readOnly: {
        mode: undefined,
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {},
        policy: "pi",
      },
      defaultMode: undefined,
      preApproval: undefined,
      authEnv: [],
    });
  });

  test("gemini: launch candidates and auth env", () => {
    expect(registryEntry("gemini")).toEqual({
      name: "gemini",
      launch: [{ command: "gemini", args: ["--acp"] }],
      readOnly: {
        mode: { configId: "mode", value: "plan" },
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {},
        policy: undefined,
      },
      defaultMode: undefined,
      preApproval: undefined,
      authEnv: ["GEMINI_API_KEY"],
    });
  });

  test("gemini: none, read and review are enforced by its plan mode", () => {
    expect(registryEntry("gemini")?.readOnly).toEqual({
      mode: { configId: "mode", value: "plan" },
      disallowedTools: [],
      sessionOptions: {},
      launchEnv: {},
      policy: undefined,
    });
  });

  test("gemini declares no default mode and no pre-approval channel", () => {
    expect(registryEntry("gemini")?.defaultMode).toBeUndefined();
    expect(registryEntry("gemini")?.preApproval).toBeUndefined();
  });

  test("codex: launch candidates and auth env; read-only mode enforcement, no default mode, no pre-approval (nax#2372)", () => {
    expect(registryEntry("codex")).toEqual({
      name: "codex",
      launch: [
        { command: "codex-acp", args: [] },
        { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@~2.1.1"] },
      ],
      readOnly: {
        mode: { configId: "mode", value: "read-only" },
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {},
        policy: undefined,
      },
      defaultMode: undefined,
      preApproval: undefined,
      authEnv: ["OPENAI_API_KEY"],
    });
  });

  test("opencode: launch candidates and auth env; read-only enforcement by injected permission config", () => {
    expect(registryEntry("opencode")).toEqual({
      name: "opencode",
      launch: [{ command: "opencode", args: ["acp"] }],
      readOnly: {
        mode: undefined,
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {
          none: { OPENCODE_CONFIG_CONTENT: OPENCODE_NONE_CONFIG },
          read: { OPENCODE_CONFIG_CONTENT: OPENCODE_READ_CONFIG },
          review: { OPENCODE_CONFIG_CONTENT: OPENCODE_REVIEW_CONFIG },
        },
        policy: "opencode",
      },
      defaultMode: undefined,
      preApproval: undefined,
      authEnv: [],
    });
  });

  test("opencode declares no default mode and no pre-approval channel", () => {
    expect(registryEntry("opencode")?.defaultMode).toBeUndefined();
    expect(registryEntry("opencode")?.preApproval).toBeUndefined();
  });

  test("the agents whose read-only profile is built from the rules name a policy translator (US-002, US-004)", () => {
    expect(registryEntry("opencode")?.readOnly?.policy).toBe("opencode");
    expect(registryEntry("cursor")?.readOnly?.policy).toBe("cursor");
    expect(registryEntry("pi")?.readOnly?.policy).toBe("pi");
    for (const name of ["claude", "codex", "gemini"] as const) {
      expect(registryEntry(name)?.readOnly?.policy).toBeUndefined();
    }
  });

  test("opencode: none denies every tool", () => {
    expect(JSON.parse(OPENCODE_NONE_CONFIG)).toEqual({ permission: { "*": "deny" } });
  });

  test("opencode: read allows the read tools after the catch-all deny, in that order (last match wins)", () => {
    expect(Object.keys(JSON.parse(OPENCODE_READ_CONFIG).permission)).toEqual(["*", "read", "glob", "grep", "list"]);
    expect(JSON.parse(OPENCODE_READ_CONFIG).permission).toEqual({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
    });
  });

  test("opencode: review also asks nax about shell commands, last", () => {
    expect(Object.keys(JSON.parse(OPENCODE_REVIEW_CONFIG).permission)).toEqual([
      "*",
      "read",
      "glob",
      "grep",
      "list",
      "bash",
    ]);
    expect(JSON.parse(OPENCODE_REVIEW_CONFIG).permission).toEqual({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "ask",
    });
  });

  test("claude and codex add no launch env for a read-only profile", () => {
    expect(registryEntry("claude")?.readOnly?.launchEnv).toEqual({});
    expect(registryEntry("codex")?.readOnly?.launchEnv).toEqual({});
  });

  test("opencode's launch env is frozen, down to each profile's record", () => {
    const launchEnv = registryEntry("opencode")?.readOnly?.launchEnv;
    expect(Object.isFrozen(launchEnv)).toBe(true);
    expect(Object.isFrozen(launchEnv?.read)).toBe(true);
    expect(Object.isFrozen(launchEnv?.none)).toBe(true);
    expect(Object.isFrozen(launchEnv?.review)).toBe(true);
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

  test("every entry with read-only enforcement sets a mode, a launch env for none, read and review, or a policy", () => {
    for (const name of ACP_AGENT_NAMES) {
      const readOnly = registryEntry(name)?.readOnly;
      if (readOnly === undefined) continue;
      if (readOnly.policy !== undefined) continue;
      if (readOnly.mode !== undefined) {
        expect(readOnly.mode.configId).not.toBe("");
        expect(readOnly.mode.value).not.toBe("");
        continue;
      }
      for (const profile of ["none", "read", "review"] as const) {
        expect(Object.keys(readOnly.launchEnv[profile] ?? {})).not.toHaveLength(0);
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  effortOptionId,
  launchEnvFor,
  modeFor,
  modelOptionId,
  offersValue,
  readOnlyFor,
  reviewDecidesShell,
  selectValues,
  unmetRequirement,
} from "#src/client/capabilities";
import {
  OPENCODE_NONE_CONFIG,
  OPENCODE_READ_CONFIG,
  OPENCODE_REVIEW_CONFIG,
  registryEntry,
} from "#src/client/registry";
import type { AcpPermissionRules } from "#src/client/rule-policy";

const CLAUDE = registryEntry("claude");

const FULL_INIT: InitializeResponse = {
  protocolVersion: 1,
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true },
    sessionCapabilities: { resume: {}, close: {} },
  },
};

describe("buildCapabilityRecord (spec §6.3 step 2)", () => {
  test.each([true, false, undefined])("image capability %p defaults to false", (image) => {
    const agentCapabilities = image === undefined ? {} : { promptCapabilities: { image } };
    expect(buildCapabilityRecord({ protocolVersion: 1, agentCapabilities }, undefined)).toHaveProperty(
      "image",
      image === true,
    );
  });

  test("initialize plus registry data", () => {
    expect(buildCapabilityRecord(FULL_INIT, CLAUDE)).toEqual({
      protocolVersion: 1,
      agentName: "claude-agent-acp",
      agentVersion: "0.85.1",
      loadSession: true,
      resume: true,
      close: true,
      mcpHttp: true,
      image: false,
      readOnlyMode: true,
      preApproval: true,
      ownToolCalls: false,
    });
  });

  test("an empty initialize and a custom agent: everything false", () => {
    expect(buildCapabilityRecord({ protocolVersion: 1 }, undefined)).toEqual({
      protocolVersion: 1,
      loadSession: false,
      resume: false,
      close: false,
      mcpHttp: false,
      image: false,
      readOnlyMode: false,
      preApproval: false,
      ownToolCalls: false,
    });
  });

  test("a capability is an object; a boolean in its place does not count (hostile agent)", () => {
    const init = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true, resume: null } } };
    // The agent's JSON is untrusted and may not match the schema; parse it as unknown first.
    const record = buildCapabilityRecord(JSON.parse(JSON.stringify(init)), undefined);
    expect(record.close).toBe(false);
    expect(record.resume).toBe(false);
  });

  test("agent labels are control-stripped and capped at 200 characters (D-l)", () => {
    const record = buildCapabilityRecord(
      { protocolVersion: 1, agentInfo: { name: `evil\u001b[2J${"n".repeat(300)}`, version: "1\u0000.0" } },
      undefined,
    );
    expect(record.agentName).toBe(`evil[2J${"n".repeat(193)}`);
    expect(record.agentVersion).toBe("1.0");
  });

  test("the record is frozen and JSON-safe", () => {
    const record = buildCapabilityRecord(FULL_INIT, CLAUDE);
    expect(Object.isFrozen(record)).toBe(true);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

const claudeRecord: CapabilityRecord = buildCapabilityRecord(FULL_INIT, CLAUDE);
const customRecord: CapabilityRecord = buildCapabilityRecord({ protocolVersion: 1 }, undefined);

describe("unmetRequirement (spec §6.3 step 2, §6.4 enforceability)", () => {
  test.each([
    ["none", 0, false],
    ["read", 0, false],
    ["ask", 0, false],
    ["full", 2, true],
  ] as const)("claude meets profile %p, %p tools, resume %p", (profile, toolCount, resume) => {
    expect(unmetRequirement(claudeRecord, { profile, toolCount, resume })).toBeUndefined();
  });

  test("none/read need a read-only mode: custom agents fail closed", () => {
    expect(unmetRequirement(customRecord, { profile: "read", toolCount: 0, resume: false })?.capability).toBe(
      "profile",
    );
    expect(unmetRequirement(customRecord, { profile: "none", toolCount: 0, resume: false })?.capability).toBe(
      "profile",
    );
    expect(unmetRequirement(customRecord, { profile: "ask", toolCount: 0, resume: false })).toBeUndefined();
  });

  test("tools need HTTP MCP and pre-approval or a known MCP call identity", () => {
    const httpOnly = { ...customRecord, mcpHttp: true };
    expect(unmetRequirement(httpOnly, { profile: "full", toolCount: 1, resume: false })?.capability).toBe("tools");
  });

  test("AC-7: HTTP MCP and the cursor entry: ownToolCalls is true", () => {
    expect(buildCapabilityRecord(FULL_INIT, registryEntry("cursor")).ownToolCalls).toBe(true);
  });

  test("AC-8: HTTP MCP and the gemini entry: ownToolCalls is false", () => {
    expect(buildCapabilityRecord(FULL_INIT, registryEntry("gemini")).ownToolCalls).toBe(false);
  });

  const FULL_ONE_TOOL = { profile: "full", toolCount: 1, resume: false } as const;

  test("AC-9: HTTP MCP, no pre-approval, own tool calls: tools are met", () => {
    const own = { ...customRecord, mcpHttp: true, preApproval: false, ownToolCalls: true };
    expect(unmetRequirement(own, FULL_ONE_TOOL)).toBeUndefined();
  });

  test("AC-10: own tool calls without HTTP MCP: tools are unmet", () => {
    const own = { ...customRecord, mcpHttp: false, preApproval: false, ownToolCalls: true };
    expect(unmetRequirement(own, FULL_ONE_TOOL)).toMatchObject({
      capability: "tools",
      reason: "embedder tools need HTTP MCP support and adapter pre-approval or a known MCP call identity",
    });
  });

  test("AC-11: HTTP MCP with neither pre-approval nor own tool calls: tools are unmet", () => {
    const neither = { ...customRecord, mcpHttp: true, preApproval: false, ownToolCalls: false };
    expect(unmetRequirement(neither, FULL_ONE_TOOL)?.capability).toBe("tools");
  });

  test("resume needs session/resume or loadSession", () => {
    expect(unmetRequirement(customRecord, { profile: "full", toolCount: 0, resume: true })?.capability).toBe("resume");
    const loads = { ...customRecord, loadSession: true };
    expect(unmetRequirement(loads, { profile: "full", toolCount: 0, resume: true })).toBeUndefined();
  });
});

const OPTIONS: SessionConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [{ group: "anthropic", name: "Anthropic", options: [{ value: "sonnet", name: "Sonnet" }] }],
  },
  { id: "verbose", name: "Verbose", type: "boolean", currentValue: false },
];

describe("config options", () => {
  test("selectValues flattens groups; a boolean option offers none", () => {
    const [mode, model, verbose] = OPTIONS;
    if (mode === undefined || model === undefined || verbose === undefined) throw new Error("fixture");
    expect(selectValues(mode)).toEqual(["default", "plan"]);
    expect(selectValues(model)).toEqual(["sonnet"]);
    expect(selectValues(verbose)).toEqual([]);
  });

  test("offersValue and modelOptionId", () => {
    expect(offersValue(OPTIONS, "mode", "plan")).toBe(true);
    expect(offersValue(OPTIONS, "mode", "yolo")).toBe(false);
    expect(offersValue(OPTIONS, "missing", "plan")).toBe(false);
    expect(modelOptionId(OPTIONS, "sonnet")).toBe("model");
    expect(modelOptionId(OPTIONS, "opus")).toBeUndefined();
  });

  test("modeFor and readOnlyFor: default mode for every Claude profile; nothing for agents without enforcement", () => {
    expect(modeFor("read", CLAUDE)).toEqual({ configId: "mode", value: "default" });
    expect(modeFor("none", CLAUDE)).toEqual({ configId: "mode", value: "default" });
    expect(modeFor("full", CLAUDE)).toEqual({ configId: "mode", value: "default" });
    expect(readOnlyFor("read", CLAUDE)).toBe(CLAUDE?.readOnly);
    expect(readOnlyFor("ask", CLAUDE)).toBeUndefined();
    expect(modeFor("ask", registryEntry("codex"))).toBeUndefined();
    // A custom agent has no registry entry: no enforcement, and nothing to resolve (US-004).
    expect(readOnlyFor("none", undefined)).toBeUndefined();
    expect(modeFor("full", undefined)).toBeUndefined();
  });

  test("review is read-only enforced like read on Claude (nax#2500)", () => {
    expect(readOnlyFor("review", CLAUDE)).toBe(CLAUDE?.readOnly);
    expect(modeFor("review", CLAUDE)).toEqual({ configId: "mode", value: "default" });
    expect(unmetRequirement(customRecord, { profile: "review", toolCount: 0, resume: false })?.capability).toBe(
      "profile",
    );
  });
});

describe("codex read-only profiles through its own mode (nax#2372)", () => {
  const CODEX = registryEntry("codex");
  const READ_ONLY = { configId: "mode", value: "read-only" };
  /** An initialize response with no MCP capabilities (codex never delivers embedder tools). */
  const BARE_INIT: InitializeResponse = { protocolVersion: 1 };
  const codexRecord: CapabilityRecord = buildCapabilityRecord(BARE_INIT, CODEX);

  test.each(["read", "none", "review"] as const)("modeFor(%p) is codex's read-only mode", (profile) => {
    expect(modeFor(profile, CODEX)).toEqual(READ_ONLY);
  });

  test.each(["full", "ask"] as const)("modeFor(%p) leaves codex's launch mode alone", (profile) => {
    expect(modeFor(profile, CODEX)).toBeUndefined();
  });

  test.each(["read", "review"] as const)("no unmet requirement for profile %p", (profile) => {
    expect(unmetRequirement(codexRecord, { profile, toolCount: 0, resume: false })).toBeUndefined();
  });
});

describe("gemini read-only profiles through its plan mode (nax#2372)", () => {
  const GEMINI = registryEntry("gemini");
  const PLAN = { configId: "mode", value: "plan" };
  /** An initialize response with no MCP capabilities (gemini never delivers embedder tools). */
  const BARE_INIT: InitializeResponse = { protocolVersion: 1 };
  const geminiRecord: CapabilityRecord = buildCapabilityRecord(BARE_INIT, GEMINI);

  test.each(["read", "none", "review"] as const)("modeFor(%p) is gemini's plan mode", (profile) => {
    expect(modeFor(profile, GEMINI)).toEqual(PLAN);
  });

  test("modeFor(full) leaves gemini's launch mode alone", () => {
    expect(modeFor("full", GEMINI)).toBeUndefined();
  });

  test.each(["read", "review"] as const)("no unmet requirement for profile %p", (profile) => {
    expect(unmetRequirement(geminiRecord, { profile, toolCount: 0, resume: false })).toBeUndefined();
  });
});

describe("opencode read-only profiles through an injected launch env (nax#2372)", () => {
  const OPENCODE = registryEntry("opencode");
  const RECORDS = {
    none: { OPENCODE_CONFIG_CONTENT: OPENCODE_NONE_CONFIG },
    read: { OPENCODE_CONFIG_CONTENT: OPENCODE_READ_CONFIG },
    review: { OPENCODE_CONFIG_CONTENT: OPENCODE_REVIEW_CONFIG },
  } as const;

  test.each(["none", "read", "review"] as const)("launchEnvFor(%p) is the profile's permission config", (profile) => {
    expect(launchEnvFor(profile, OPENCODE)).toEqual(RECORDS[profile]);
  });

  test.each(["none", "read", "review"] as const)("modeFor(%p) is undefined: opencode needs no mode", (profile) => {
    expect(modeFor(profile, OPENCODE)).toBeUndefined();
  });

  test("launchEnvFor adds nothing for full, ask, an agent without enforcement or no entry at all", () => {
    expect(launchEnvFor("full", OPENCODE)).toEqual({});
    expect(launchEnvFor("ask", OPENCODE)).toEqual({});
    expect(launchEnvFor("read", registryEntry("claude"))).toEqual({});
    expect(launchEnvFor("read", registryEntry("gemini"))).toEqual({});
    expect(launchEnvFor("read", undefined)).toEqual({});
  });

  test("readOnlyFor still hands the enforcement to the pre-approval channel under review", () => {
    expect(readOnlyFor("review", OPENCODE)).toBe(OPENCODE?.readOnly);
  });

  /** An initialize response with no MCP capabilities (opencode never delivers embedder tools). */
  const BARE_INIT: InitializeResponse = { protocolVersion: 1 };
  const opencodeRecord: CapabilityRecord = buildCapabilityRecord(BARE_INIT, OPENCODE);

  test.each(["read", "review"] as const)("no unmet requirement for profile %p", (profile) => {
    expect(unmetRequirement(opencodeRecord, { profile, toolCount: 0, resume: false })).toBeUndefined();
  });

  test("embedder tools are still refused: opencode has no pre-approval channel", () => {
    expect(unmetRequirement(opencodeRecord, { profile: "read", toolCount: 1, resume: false })?.capability).toBe(
      "tools",
    );
  });
});

function select(id: string, category: string | undefined, values: readonly string[]): SessionConfigOption {
  return {
    id,
    name: id,
    ...(category === undefined ? {} : { category }),
    type: "select",
    currentValue: values[0] ?? "",
    options: values.map((value) => ({ value, name: value })),
  };
}

describe("effortOptionId (S4b spec §6.7, §8)", () => {
  test("category thought_level wins when it offers the value", () => {
    const options = [select("effort", undefined, ["high"]), select("thinking", "thought_level", ["low", "high"])];
    expect(effortOptionId(options, "claude", "high")).toBe("thinking");
  });

  test("falls back to the agent's id when no thought_level option offers the value", () => {
    expect(effortOptionId([select("reasoning_effort", undefined, ["low", "high"])], "codex", "high")).toBe(
      "reasoning_effort",
    );
    expect(effortOptionId([select("effort", undefined, ["high"])], "claude", "high")).toBe("effort");
  });

  test("undefined when the value is not offered, the agent has no fallback, or there are no options", () => {
    expect(effortOptionId([select("effort", "thought_level", ["low"])], "claude", "high")).toBeUndefined();
    expect(effortOptionId([select("effort", undefined, ["high"])], "gemini", "high")).toBeUndefined();
    expect(effortOptionId([], "claude", "high")).toBeUndefined();
  });

  test("an inherited object key is not an agent fallback", () => {
    expect(effortOptionId([select("toString", undefined, ["high"])], "toString", "high")).toBeUndefined();
  });
});

describe("Cursor review with operator Bash rules runs in agent mode (nax#2592)", () => {
  const CURSOR = registryEntry("cursor");
  const ASK = { configId: "mode", value: "ask" };
  const AGENT = { configId: "mode", value: "agent" };
  const rules = (over: Partial<AcpPermissionRules>): AcpPermissionRules => ({ allow: [], deny: [], ask: [], ...over });
  const BASH_ALLOW = rules({ allow: [{ tool: "Bash", patterns: ["echo *"] }] });

  test("review with a Bash allow rule: agent mode, so the model asks nax instead of refusing to try", () => {
    expect(modeFor("review", CURSOR, BASH_ALLOW)).toEqual(AGENT);
    expect(reviewDecidesShell("review", BASH_ALLOW)).toBe(true);
  });

  test.each<[string, AcpPermissionRules | undefined]>([
    ["no rules", undefined],
    ["only a Bash deny", rules({ deny: [{ tool: "Bash", patterns: ["rm *"] }] })],
    ["only a Bash ask", rules({ ask: [{ tool: "Bash", patterns: ["git *"] }] })],
    ["a Read allow", rules({ allow: [{ tool: "Read", patterns: ["*"] }] })],
  ])("review with %s keeps ask mode", (_, given) => {
    expect(modeFor("review", CURSOR, given)).toEqual(ASK);
  });

  test.each(["none", "read"] as const)("%p keeps ask mode even with a Bash allow rule", (profile) => {
    expect(modeFor(profile, CURSOR, BASH_ALLOW)).toEqual(ASK);
    expect(reviewDecidesShell(profile, BASH_ALLOW)).toBe(false);
  });

  test("full sets no mode, and an agent without reviewShellMode keeps its read-only mode", () => {
    expect(modeFor("full", CURSOR, BASH_ALLOW)).toBeUndefined();
    expect(modeFor("review", registryEntry("gemini"), BASH_ALLOW)).toEqual({ configId: "mode", value: "plan" });
  });
});

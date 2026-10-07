import { describe, expect, test } from "bun:test";
import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  buildCapabilityRecord,
  type CapabilityRecord,
  modeFor,
  modelOptionId,
  offersValue,
  readOnlyFor,
  selectValues,
  unmetRequirement,
} from "#src/client/capabilities";
import { registryEntry } from "#src/client/registry";

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
  test("initialize plus registry data", () => {
    expect(buildCapabilityRecord(FULL_INIT, CLAUDE)).toEqual({
      protocolVersion: 1,
      agentName: "claude-agent-acp",
      agentVersion: "0.85.1",
      loadSession: true,
      resume: true,
      close: true,
      mcpHttp: true,
      readOnlyMode: true,
      preApproval: true,
    });
  });

  test("an empty initialize and a custom agent: everything false", () => {
    expect(buildCapabilityRecord({ protocolVersion: 1 }, undefined)).toEqual({
      protocolVersion: 1,
      loadSession: false,
      resume: false,
      close: false,
      mcpHttp: false,
      readOnlyMode: false,
      preApproval: false,
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

  test("tools need HTTP MCP and pre-approval", () => {
    const httpOnly = { ...customRecord, mcpHttp: true };
    expect(unmetRequirement(httpOnly, { profile: "full", toolCount: 1, resume: false })?.capability).toBe("tools");
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
    expect(readOnlyFor("none", registryEntry("codex"))).toBeUndefined();
    expect(modeFor("full", undefined)).toBeUndefined();
  });
});

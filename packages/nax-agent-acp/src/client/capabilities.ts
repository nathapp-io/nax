/**
 * What an ACP agent can do (S4 spec §6.3 step 2, §6.4, §6.10): the capability
 * record from initialize plus registry data, and the requirement checks that run
 * before any prompt. The record is authoritative at runtime and only narrows what
 * the registry allows; custom agents have no registry data and fail closed. It is
 * reported as AgentSession.backend.capabilities, so it stays JSON-safe.
 */
import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import type { AgentRegistryEntry, ModeSetting } from "#src/client/registry";

const LABEL_MAX_CHARS = 200;

export type CapabilityRecord = {
  readonly protocolVersion: number;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly loadSession: boolean;
  readonly resume: boolean;
  readonly close: boolean;
  readonly mcpHttp: boolean;
  /** The registry has a read-only mode for profiles none/read. */
  readonly readOnlyMode: boolean;
  /** The registry knows how to pre-approve embedder tools at the adapter (R12). */
  readonly preApproval: boolean;
};

export interface Requirements {
  readonly profile: AgentSessionProfile;
  readonly toolCount: number;
  readonly resume: boolean;
}

export interface UnmetRequirement {
  readonly capability: "profile" | "tools" | "resume";
  readonly reason: string;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Agent-supplied labels are display data: control characters stripped, capped (D-l). */
function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\p{Cc}/gu, "").slice(0, LABEL_MAX_CHARS);
  return clean === "" ? undefined : clean;
}

export function buildCapabilityRecord(
  init: InitializeResponse,
  entry: AgentRegistryEntry | undefined,
): CapabilityRecord {
  const caps = init.agentCapabilities ?? {};
  const name = label(init.agentInfo?.name);
  const version = label(init.agentInfo?.version);
  return Object.freeze({
    protocolVersion: init.protocolVersion,
    ...(name === undefined ? {} : { agentName: name }),
    ...(version === undefined ? {} : { agentVersion: version }),
    loadSession: caps.loadSession === true,
    resume: isObject(caps.sessionCapabilities?.resume),
    close: isObject(caps.sessionCapabilities?.close),
    mcpHttp: caps.mcpCapabilities?.http === true,
    readOnlyMode: entry?.readOnlyMode !== undefined,
    preApproval: entry?.preApproval !== undefined,
  });
}

/** The first requirement this agent cannot meet, or undefined. The model is checked after session/new. */
export function unmetRequirement(record: CapabilityRecord, req: Requirements): UnmetRequirement | undefined {
  if ((req.profile === "none" || req.profile === "read") && !record.readOnlyMode) {
    return {
      capability: "profile",
      reason: `profile "${req.profile}" needs a read-only agent mode; this agent has none`,
    };
  }
  if (req.toolCount > 0 && !(record.mcpHttp && record.preApproval)) {
    return { capability: "tools", reason: "embedder tools need HTTP MCP support and adapter pre-approval" };
  }
  if (req.resume && !(record.resume || record.loadSession)) {
    return { capability: "resume", reason: "the agent supports neither session/resume nor session/load" };
  }
  return undefined;
}

/** The value ids a select option offers, groups flattened; none for a boolean option. */
export function selectValues(option: SessionConfigOption): readonly string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => ("group" in entry ? entry.options.map((o) => o.value) : [entry.value]));
}

export function offersValue(options: readonly SessionConfigOption[], configId: string, value: string): boolean {
  return options.some((option) => option.id === configId && selectValues(option).includes(value));
}

/** The id of the agent's model option (category "model") that offers `model`. */
export function modelOptionId(options: readonly SessionConfigOption[], model: string): string | undefined {
  return options.find((option) => option.category === "model" && selectValues(option).includes(model))?.id;
}

/** The mode a profile selects (§6.4 layer 1): read-only for none/read, the default mode otherwise. */
export function modeFor(profile: AgentSessionProfile, entry: AgentRegistryEntry | undefined): ModeSetting | undefined {
  return profile === "none" || profile === "read" ? entry?.readOnlyMode : entry?.defaultMode;
}

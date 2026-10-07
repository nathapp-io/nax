/**
 * What an ACP agent can do (S4 spec §6.3 step 2, §6.4, §6.10): the capability
 * record from initialize plus registry data, and the requirement checks that run
 * before any prompt. The record is authoritative at runtime and only narrows what
 * the registry allows; custom agents have no registry data and fail closed. It is
 * reported as AgentSession.backend.capabilities, so it stays JSON-safe.
 */
import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import type { AgentRegistryEntry, ModeSetting, ReadOnlyEnforcement } from "#src/client/registry";

const LABEL_MAX_CHARS = 200;

export type CapabilityRecord = {
  readonly protocolVersion: number;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly loadSession: boolean;
  readonly resume: boolean;
  readonly close: boolean;
  readonly mcpHttp: boolean;
  /** The registry can enforce profiles none/read on this agent. */
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
    readOnlyMode: entry?.readOnly !== undefined,
    preApproval: entry?.preApproval !== undefined,
  });
}

const isReadOnlyProfile = (profile: AgentSessionProfile): boolean => profile === "none" || profile === "read";

/** The first requirement this agent cannot meet, or undefined. The model is checked after session/new. */
export function unmetRequirement(record: CapabilityRecord, req: Requirements): UnmetRequirement | undefined {
  if (isReadOnlyProfile(req.profile) && !record.readOnlyMode) {
    return {
      capability: "profile",
      reason: `profile "${req.profile}" needs read-only enforcement; this agent has none`,
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

/** Per-agent effort option ids, tried when no option has category "thought_level" (nax's EFFORT_OPTION_BY_AGENT). */
export const EFFORT_FALLBACK_IDS: Readonly<Record<string, string>> = Object.freeze({
  claude: "effort",
  codex: "reasoning_effort",
  opencode: "effort",
  pi: "thought_level",
});

/** The option that sets `effort`: a "thought_level" option offering it, else the agent's fallback id offering it. */
export function effortOptionId(
  options: readonly SessionConfigOption[],
  agentName: string,
  effort: string,
): string | undefined {
  const offering = options.filter((option) => selectValues(option).includes(effort));
  const byCategory = offering.find((option) => option.category === "thought_level");
  if (byCategory !== undefined) return byCategory.id;
  const fallback = Object.hasOwn(EFFORT_FALLBACK_IDS, agentName) ? EFFORT_FALLBACK_IDS[agentName] : undefined;
  return fallback === undefined ? undefined : offering.find((option) => option.id === fallback)?.id;
}

/** The read-only enforcement a profile uses: the entry's for none/read, none otherwise. */
export function readOnlyFor(
  profile: AgentSessionProfile,
  entry: AgentRegistryEntry | undefined,
): ReadOnlyEnforcement | undefined {
  return isReadOnlyProfile(profile) ? entry?.readOnly : undefined;
}

/** The mode a profile selects (§6.4 layer 1): the read-only entry's for none/read, the default mode otherwise. */
export function modeFor(profile: AgentSessionProfile, entry: AgentRegistryEntry | undefined): ModeSetting | undefined {
  return isReadOnlyProfile(profile) ? entry?.readOnly?.mode : entry?.defaultMode;
}

/**
 * What an ACP session exposes about its settings (S5 spec §5.2, §5.3): the four
 * modes (S3 profiles), and two select config options, the model (the configured
 * tiers plus the current model) and the bash approval mode. Changes are
 * validated here; applying them is the registry's close-and-reopen (§3.3).
 */
import type { SessionConfigOption, SessionMode, SessionModeState } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import { invalidParams } from "#src/server/errors";
import { BASH_APPROVALS, type BashApproval, MODES, type TierModel } from "#src/server/nax-config";

export interface SessionSettings {
  readonly mode: AgentSessionProfile;
  readonly model: string;
  readonly bashApproval: BashApproval;
}

export const MODEL_OPTION = "model";
export const BASH_OPTION = "bashApproval";

export const SESSION_MODES: readonly SessionMode[] = [
  { id: "none", name: "Chat", description: "Chat only: no workspace tools." },
  { id: "read", name: "Read only", description: "Reads and searches the workspace; changes nothing." },
  { id: "ask", name: "Ask", description: "Asks before every edit and command." },
  { id: "full", name: "Full access", description: "Edits files and runs commands without asking, inside the sandbox." },
];

const BASH_CHOICES: readonly { value: BashApproval; name: string; description: string }[] = [
  {
    value: "gated",
    name: "Gated",
    description: "Commands are checked against the rules; one the checks cannot judge is refused.",
  },
  {
    value: "escalate",
    name: "Escalate",
    description: "Like gated, but a command the checks cannot judge asks you instead.",
  },
  {
    value: "raw",
    name: "Raw",
    description: "Commands run as written, without per-command checks (mode Full only).",
  },
];

export function sameSettings(a: SessionSettings, b: SessionSettings): boolean {
  return a.mode === b.mode && a.model === b.model && a.bashApproval === b.bashApproval;
}

export function modeState(settings: SessionSettings): SessionModeState {
  return { currentModeId: settings.mode, availableModes: [...SESSION_MODES] };
}

export function modelChoices(
  settings: SessionSettings,
  tiers: readonly TierModel[],
): readonly { value: string; name: string; description: string }[] {
  const seen = new Set<string>();
  const choices: { value: string; name: string; description: string }[] = [];
  for (const tier of tiers) {
    if (seen.has(tier.model)) continue;
    seen.add(tier.model);
    choices.push({ value: tier.model, name: tier.tier, description: tier.model });
  }
  if (!seen.has(settings.model)) {
    choices.push({ value: settings.model, name: settings.model, description: "current model" });
  }
  return choices;
}

export function configOptions(settings: SessionSettings, tiers: readonly TierModel[]): SessionConfigOption[] {
  return [
    {
      id: MODEL_OPTION,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: settings.model,
      options: [...modelChoices(settings, tiers)],
    },
    {
      id: BASH_OPTION,
      name: "Bash approval",
      type: "select",
      currentValue: settings.bashApproval,
      options: [...BASH_CHOICES],
    },
  ];
}

export function applyModeChange(settings: SessionSettings, modeId: string): SessionSettings {
  const mode = MODES.find((m) => m === modeId);
  if (mode === undefined) throw invalidParams(`unknown mode "${modeId}"; expected one of ${MODES.join(", ")}`);
  // Ask runs every command past a person, which needs gated (M-23).
  return { ...settings, mode, bashApproval: mode === "ask" ? "gated" : settings.bashApproval };
}

export function applyConfigChange(
  settings: SessionSettings,
  configId: string,
  value: unknown,
  tiers: readonly TierModel[],
): SessionSettings {
  if (typeof value !== "string") throw invalidParams(`config option "${configId}" takes a string value`);
  if (configId === MODEL_OPTION) {
    const valid = modelChoices(settings, tiers).map((choice) => choice.value);
    if (!valid.includes(value)) throw invalidParams(`unknown model "${value}"; valid models: ${valid.join(", ")}`);
    return { ...settings, model: value };
  }
  if (configId === BASH_OPTION) {
    const bash = BASH_APPROVALS.find((b) => b === value);
    if (bash === undefined)
      throw invalidParams(`unknown bash approval "${value}"; expected one of ${BASH_APPROVALS.join(", ")}`);
    if (settings.mode === "ask" && bash !== "gated") {
      throw invalidParams('mode "ask" requires bash approval "gated"');
    }
    return { ...settings, bashApproval: bash };
  }
  throw invalidParams(`unknown config option "${configId}"`);
}

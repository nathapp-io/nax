/**
 * ACP chat model strings.
 *
 * An ACP brain is named `acp:<agent>` or `acp:<agent>/<model>`, optionally
 * followed by nax's effort suffix `[<effort>]`. The `acp:` prefix cannot
 * collide with a native `<provider>/<model>` string.
 */
import { parseModelSpec } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import { EFFORT_LEVELS, type EffortLevel } from "../chat-effort";

export const ACP_CHAT_AGENTS = ["claude", "codex", "cursor"] as const;
export type AcpChatAgent = (typeof ACP_CHAT_AGENTS)[number];

export interface ChatAcpModel {
  readonly agent: AcpChatAgent;
  readonly model?: string;
  readonly effort?: string;
}

/** What a `!` command on an ACP brain returns. */
export const ACP_RUN_COMMAND_UNSUPPORTED =
  "! commands run on nax's own models only; the agent runs commands with its own tools";

const ACP_PREFIX = "acp:";
const AGENT_LABELS: Readonly<Record<AcpChatAgent, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};
/** One trailing `[...]` group whose body holds no bracket. */
const TRAILING_GROUP = /\[[^[\]]*\]$/;

export function isChatAcpModel(model: string): boolean {
  return model.startsWith(ACP_PREFIX);
}

function isAcpChatAgent(text: string): text is AcpChatAgent {
  return ACP_CHAT_AGENTS.some((agent) => agent === text);
}

function hasBracket(text: string): boolean {
  return text.includes("[") || text.includes("]");
}

function invalid(model: string, reason: string): NaxError {
  return new NaxError(`[chat] invalid ACP model "${model}": ${reason}`, "CHAT_ACP_MODEL_INVALID", {
    stage: "chat",
    model,
  });
}

/** Parse an `acp:` model string; `undefined` for a native string, a throw for a malformed `acp:` one. */
export function parseChatAcpModel(model: string): ChatAcpModel | undefined {
  if (!isChatAcpModel(model)) return undefined;
  const { model: body, effort } = parseModelSpec(model.slice(ACP_PREFIX.length));
  const slash = body.indexOf("/");
  const agent = slash === -1 ? body : body.slice(0, slash);
  if (!isAcpChatAgent(agent)) {
    throw invalid(model, `the agent must be one of ${ACP_CHAT_AGENTS.join(", ")}`);
  }
  const named = slash === -1 ? undefined : body.slice(slash + 1);
  if (named === "") throw invalid(model, 'the model after "/" is empty');
  if (named !== undefined && hasBracket(named)) throw invalid(model, 'the model must not contain "[" or "]"');
  return {
    agent,
    ...(named !== undefined ? { model: named } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

export function acpAgentLabel(agent: AcpChatAgent): string {
  return AGENT_LABELS[agent];
}

function parsedOrUndefined(model: string): ChatAcpModel | undefined {
  try {
    return parseChatAcpModel(model);
  } catch {
    // Labels are drawn at render time from stored metadata; a malformed string is shown as it is.
    return undefined;
  }
}

/** `<agent label>`, then ` · <model>`, then `[<effort>]`. Never throws: malformed input is its own label. */
export function acpModelLabel(model: string): string {
  const parsed = parsedOrUndefined(model);
  if (!parsed) return model;
  const named = parsed.model !== undefined ? ` · ${parsed.model}` : "";
  const effort = parsed.effort !== undefined ? `[${parsed.effort}]` : "";
  return `${acpAgentLabel(parsed.agent)}${named}${effort}`;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Cursor ids carry their settings: drop one trailing group and keep only names the backend can resolve uniquely. */
function cursorBareNames(offered: readonly string[]): string[] {
  const owners = new Map<string, number>();
  for (const id of distinct(offered)) {
    const bare = id.replace(TRAILING_GROUP, "");
    owners.set(bare, (owners.get(bare) ?? 0) + 1);
  }
  return [...owners].filter(([bare, count]) => count === 1 && bare !== "" && !hasBracket(bare)).map(([bare]) => bare);
}

/** Picker rows (`acp:<agent>/<model>`) for the offered model ids, in offer order, duplicates removed. */
export function acpModelRows(agent: AcpChatAgent, offeredModels: readonly string[]): readonly string[] {
  const names =
    agent === "cursor"
      ? cursorBareNames(offeredModels)
      : distinct(offeredModels).filter((id) => id !== "" && !hasBracket(id));
  return names.map((name) => `${ACP_PREFIX}${agent}/${name}`);
}

/** The default plus the recognised offered levels, in canonical order. */
export function acpEffortLevels(offeredEfforts: readonly string[]): readonly EffortLevel[] {
  return EFFORT_LEVELS.filter((level) => level === "default" || offeredEfforts.includes(level));
}

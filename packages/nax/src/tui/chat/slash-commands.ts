import { join } from "node:path";
import {
  acpAgentLabel,
  type ChatAcpModel,
  type ChatHost,
  EFFORT_LEVELS,
  formatAgentsListing,
  formatMcpListing,
  isEffortLevel,
  parseChatAcpModel,
  sessionTitleText,
  withEffort,
} from "@/chat";
import { featureDir } from "@/config";
import { NaxError } from "@/errors";
import { buildChatFeatureMessage, buildSkillInvocationMessage } from "@/prompts";
import { buildResourceCatalog, formatPluginsListing, formatSkillsListing } from "@/resources";

/** The no-argument commands whose argument is chosen in a picker rather than typed. */
export type PickerKind = "model" | "resume" | "mode" | "effort" | "jobs";

export type SlashOutcome =
  | { kind: "send"; message: string }
  | { kind: "command"; name: string; template: string; rest: string }
  /** `/model`, `/resume`, `/mode` and `/effort` without arguments, and `/jobs`, open the named picker. */
  | { kind: "picker"; picker: PickerKind };

export interface SlashCommand {
  name: string;
  args: string[];
  rest: string;
}

export const _slashCommandDeps = {
  async readText(path: string): Promise<string | undefined> {
    try {
      return await Bun.file(path).text();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  },
};
/** The built-ins in the order `/help` and the slash menu list them. */
export const COMMANDS = [
  "help",
  "mode",
  "model",
  "effort",
  "sessions",
  "resume",
  "clear",
  "cost",
  "feature",
  "skills",
  "plugins",
  "mcp",
  "agents",
  "jobs",
  "quit",
] as const;

export type SlashCommandName = (typeof COMMANDS)[number];

/** What each built-in does: the help text and the slash menu's second column. */
export const COMMAND_DESCRIPTIONS = {
  help: "Show commands and skills",
  mode: "Switch permission mode",
  model: "Switch model",
  effort: "Switch reasoning effort",
  sessions: "List saved sessions",
  resume: "Resume a saved session",
  clear: "Clear the conversation",
  cost: "Show session cost",
  feature: "Load a feature spec into the conversation",
  skills: "List skills",
  plugins: "List plugins and what they provide",
  mcp: "List MCP servers",
  agents: "List agents",
  jobs: "Show nax jobs and background tasks",
  quit: "Quit nax chat",
} satisfies Record<SlashCommandName, string>;

/**
 * The listing a command's shown text becomes, by command name. A command here shows one
 * listing entry per run; every other command's text becomes a notice entry instead.
 */
export const LISTING_TITLES: ReadonlyMap<string, string> = new Map([
  ["help", "Commands"],
  ["skills", "Skills"],
  ["plugins", "Plugins"],
  ["mcp", "MCP servers"],
  ["agents", "Agents"],
  ["sessions", "Sessions"],
  ["cost", "Cost"],
]);

export function parseSlashCommand(text: string): SlashCommand | null {
  if (!text.startsWith("/")) return null;
  const name = text.slice(1).match(/^\S*/)?.[0] ?? "";
  const rest = text.slice(name.length + 1);
  return { name, args: rest.trim() ? rest.trim().split(/\s+/) : [], rest };
}

async function featureMessage(
  command: SlashCommand,
  host: ChatHost,
  show: (text: string) => void,
): Promise<string | undefined> {
  const feature = command.args[0];
  if (!feature) {
    show("usage: /feature <name> [message]");
    return;
  }
  const dir = featureDir(host.repoRoot, feature);
  const spec = await _slashCommandDeps.readText(join(dir, "spec.md"));
  if (spec === undefined) {
    show(`no feature ${feature} (looked in ${dir})`);
    return;
  }
  const prd = await _slashCommandDeps.readText(join(dir, "prd.json"));
  const message = command.rest.replace(/^\s*\S+\s?/, "");
  return buildChatFeatureMessage({ feature, spec, prd, message });
}

interface CommandContext {
  host: ChatHost;
  show(text: string): void;
}

/** The ACP brain a model string names, or `undefined` for a native model or a malformed `acp:` string. */
export function acpBrainOfModel(model: string): ChatAcpModel | undefined {
  try {
    return parseChatAcpModel(model);
  } catch {
    // A malformed `acp:` string never opened a session; treat it as native rather than fail a menu draw.
    return undefined;
  }
}

/** The ACP brain the session is on, or `undefined` for a native model or when no session is open yet. */
export function acpBrainOf(host: { readonly current?: ChatHost["current"] }): ChatAcpModel | undefined {
  let model: string | undefined;
  try {
    model = host.current?.().model;
  } catch (error) {
    if (error instanceof NaxError && error.code === "CHAT_SESSION_NOT_OPEN") return undefined;
    throw error;
  }
  return model === undefined ? undefined : acpBrainOfModel(model);
}

/** What each native-only built-in says on an ACP brain, after `/<name> is not available on <agent>: it uses its own `. */
const ACP_OWN_FEATURES: Readonly<Record<string, string>> = {
  skills: "skills",
  mcp: "MCP servers",
  agents: "subagents",
};

function isBuiltin(name: string): boolean {
  return COMMANDS.some((builtin) => builtin === name);
}

/**
 * What an ACP brain does with a slash line before the built-in switch sees it: the native-only
 * built-ins say they are not available, and a line that is not a built-in goes to the agent as typed.
 * `undefined` means the line is an ordinary built-in and runs as on a native brain.
 */
function acpDispatch(
  command: SlashCommand,
  brain: ChatAcpModel,
  show: (text: string) => void,
): { readonly outcome: SlashOutcome | undefined } | undefined {
  if (!isBuiltin(command.name)) return { outcome: { kind: "send", message: `/${command.name}${command.rest}` } };
  const own = ACP_OWN_FEATURES[command.name];
  if (own === undefined) return undefined;
  show(`/${command.name} is not available on ${acpAgentLabel(brain.agent)}: it uses its own ${own}`);
  return { outcome: undefined };
}

function formatHelp(host: ChatHost, brain: ChatAcpModel | undefined): string {
  const builtins = COMMANDS.map((name) => `/${name}  ${COMMAND_DESCRIPTIONS[name]}`);
  if (brain) return builtins.join("\n");
  return [
    ...builtins,
    ...(host.catalog?.commands ?? []).map((entry) => `/${entry.name} - ${entry.description ?? ""}`),
    ...(host.catalog?.skills ?? []).map((entry) => `/${entry.name} - ${entry.description}`),
  ].join("\n");
}

/** `/jobs` opens the jobs picker, ignoring any argument, when the host has jobs or tasks. */
function jobsCommand({ host, show }: CommandContext): SlashOutcome | undefined {
  if (host.jobs || host.tasks) return { kind: "picker", picker: "jobs" };
  show("jobs are not available in this session");
}

function catalogCommand(command: SlashCommand, { host, show }: CommandContext): SlashOutcome | undefined {
  const resource = host.catalog?.findCommand(command.name);
  if (resource) return { kind: "command", name: command.name, template: resource.template, rest: command.rest };
  const skill = host.catalog?.findSkill(command.name);
  if (skill) return { kind: "send", message: buildSkillInvocationMessage({ skill, args: command.rest }) };
  show(`unknown command /${command.name}`);
}

async function effortCommand(command: SlashCommand, { host, show }: CommandContext): Promise<SlashOutcome | undefined> {
  if (command.args.length > 1) {
    show("usage: /effort [level]");
    return;
  }
  const arg = command.args[0];
  if (arg === undefined) return { kind: "picker", picker: "effort" };
  const model = host.current().model;
  const levels = host.effortLevels?.(model) ?? EFFORT_LEVELS;
  const level = arg.toLowerCase();
  if (!isEffortLevel(level)) {
    show(`unknown effort "${arg}"; use one of: ${levels.join(", ")}`);
    return;
  }
  if (!levels.includes(level)) {
    show(`effort "${arg}" is not available for ${model}; use one of: ${levels.join(", ")}`);
    return;
  }
  await host.switchTo({ model: withEffort(model, level) });
}

async function modelCommand(command: SlashCommand, context: CommandContext): Promise<SlashOutcome | undefined> {
  const model = command.args[0];
  if (!model) return { kind: "picker", picker: "model" };
  if (model === "refresh") await refreshModels(context);
  else await context.host.switchTo({ model });
}

async function refreshModels({ host, show }: CommandContext): Promise<void> {
  const results = (await host.refreshAcpModels?.()) ?? [];
  if (results.length === 0) show("no ACP agents to refresh");
  for (const result of results) {
    const detail =
      result.outcome === "learned"
        ? `${result.models} ${result.models === 1 ? "model" : "models"}`
        : result.outcome === "failed"
          ? `failed: ${result.reason}`
          : result.outcome;
    show(`${acpAgentLabel(result.agent)}: ${detail}`);
  }
}

/**
 * Built-ins take precedence; catalog commands remain distinct from explicit skill turns.
 *
 * `/mode`, `/model`, `/resume` and `/effort` answer argument-less calls with a `picker` outcome: the
 * session command is not run here, because the choice it needs has to be made on screen.
 */
export async function runSlashCommand(
  command: SlashCommand,
  { host, show }: CommandContext,
): Promise<SlashOutcome | undefined> {
  const arg = command.args[0];
  const brain = acpBrainOf(host);
  const stepped = brain ? acpDispatch(command, brain, show) : undefined;
  if (stepped) return stepped.outcome;
  switch (command.name) {
    case "help":
      show(formatHelp(host, brain));
      break;
    case "skills":
      show(formatSkillsListing(host.catalog ?? buildResourceCatalog([])));
      break;
    case "plugins":
      show(formatPluginsListing(host.catalog ?? buildResourceCatalog([]), host.naxPlugins ?? []));
      break;
    case "mcp":
      show(formatMcpListing(host.mcp));
      break;
    case "agents":
      show(formatAgentsListing(host.agents?.() ?? []));
      break;
    case "jobs":
      return jobsCommand({ host, show });
    case "mode":
      if (!arg) return { kind: "picker", picker: "mode" };
      if (arg === "full" || arg === "guarded") await host.switchTo({ mode: arg });
      else show(`unknown mode ${arg}; expected full or guarded`);
      break;
    case "model":
      return modelCommand(command, { host, show });
    case "effort":
      return effortCommand(command, { host, show });
    case "sessions":
      for (const row of await host.listSessions()) {
        show(
          `${row.sessionId} ${sessionTitleText(row.title, row.sessionId)}${row.heldByPid === undefined ? "" : ` in use by pid ${row.heldByPid}`}`,
        );
      }
      break;
    case "resume":
      if (!arg) return { kind: "picker", picker: "resume" };
      await host.resume({ id: arg });
      break;
    case "clear":
      await host.clear();
      break;
    case "cost":
      show(`$${(host.current().meta.costUsd ?? 0).toFixed(2)}`);
      break;
    case "feature": {
      const message = await featureMessage(command, host, show);
      return message === undefined ? undefined : { kind: "send", message };
    }
    case "quit":
      // ChatApp owns closing the terminal; never fall through to catalog lookup.
      break;
    default:
      return catalogCommand(command, { host, show });
  }
}

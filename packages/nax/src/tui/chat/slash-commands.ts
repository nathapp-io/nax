import { join } from "node:path";
import { type ChatHost, formatAgentsListing, formatJobsListing, formatMcpListing, sessionTitleText } from "@/chat";
import { featureDir } from "@/config";
import { buildChatFeatureMessage, buildSkillInvocationMessage } from "@/prompts";
import { buildResourceCatalog, formatPluginsListing, formatSkillsListing } from "@/resources";

/** The no-argument commands whose argument is chosen in a picker rather than typed. */
export type PickerKind = "model" | "resume" | "mode";

export type SlashOutcome =
  | { kind: "send"; message: string }
  | { kind: "command"; name: string; template: string; rest: string }
  /** `/model`, `/resume` and `/mode` with no argument: the screen opens the named picker. */
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
  sessions: "List saved sessions",
  resume: "Resume a saved session",
  clear: "Clear the conversation",
  cost: "Show session cost",
  feature: "Load a feature spec into the conversation",
  skills: "List skills",
  plugins: "List plugins and what they provide",
  mcp: "List MCP servers",
  agents: "List agents",
  jobs: "List nax jobs",
  quit: "Quit nax chat",
} satisfies Record<SlashCommandName, string>;

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

function formatHelp(host: ChatHost): string {
  return [
    ...COMMANDS.map((name) => `/${name}  ${COMMAND_DESCRIPTIONS[name]}`),
    ...(host.catalog?.commands ?? []).map((entry) => `/${entry.name} - ${entry.description ?? ""}`),
    ...(host.catalog?.skills ?? []).map((entry) => `/${entry.name} - ${entry.description}`),
  ].join("\n");
}

/** Keep the optional jobs capability's fallback separate from command dispatch. */
function formatSessionJobs(host: ChatHost): string {
  return host.jobs ? formatJobsListing(host.jobs.list()) : "jobs are not available in this session";
}

function catalogCommand(command: SlashCommand, { host, show }: CommandContext): SlashOutcome | undefined {
  const resource = host.catalog?.findCommand(command.name);
  if (resource) return { kind: "command", name: command.name, template: resource.template, rest: command.rest };
  const skill = host.catalog?.findSkill(command.name);
  if (skill) return { kind: "send", message: buildSkillInvocationMessage({ skill, args: command.rest }) };
  show(`unknown command /${command.name}`);
}

/**
 * Built-ins take precedence; catalog commands remain distinct from explicit skill turns.
 *
 * `/mode`, `/model` and `/resume` answer an argument-less call with a `picker` outcome: the
 * session command is not run here, because the choice it needs has to be made on screen.
 */
export async function runSlashCommand(
  command: SlashCommand,
  { host, show }: CommandContext,
): Promise<SlashOutcome | undefined> {
  const arg = command.args[0];
  switch (command.name) {
    case "help":
      show(formatHelp(host));
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
      show(formatSessionJobs(host));
      break;
    case "mode":
      if (!arg) return { kind: "picker", picker: "mode" };
      if (arg === "full" || arg === "guarded") await host.switchTo({ mode: arg });
      else show(`unknown mode ${arg}; expected full or guarded`);
      break;
    case "model":
      if (!arg) return { kind: "picker", picker: "model" };
      await host.switchTo({ model: arg });
      break;
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

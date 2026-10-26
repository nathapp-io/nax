import { join } from "node:path";
import { type ChatHost, formatAgentsListing, formatMcpListing } from "@/chat";
import { featureDir } from "@/config";
import { buildChatFeatureMessage, buildSkillInvocationMessage } from "@/prompts";
import { buildResourceCatalog, formatPluginsListing, formatSkillsListing } from "@/resources";

export type SlashOutcome =
  | { kind: "send"; message: string }
  | { kind: "command"; name: string; template: string; rest: string };

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
const COMMANDS = [
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
  "quit",
];

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
    ...COMMANDS.map((name) => `/${name}`),
    ...(host.catalog?.commands ?? []).map((entry) => `/${entry.name} - ${entry.description ?? ""}`),
    ...(host.catalog?.skills ?? []).map((entry) => `/${entry.name} - ${entry.description}`),
  ].join("\n");
}

function catalogCommand(command: SlashCommand, { host, show }: CommandContext): SlashOutcome | undefined {
  const resource = host.catalog?.findCommand(command.name);
  if (resource) return { kind: "command", name: command.name, template: resource.template, rest: command.rest };
  const skill = host.catalog?.findSkill(command.name);
  if (skill) return { kind: "send", message: buildSkillInvocationMessage({ skill, args: command.rest }) };
  show(`unknown command /${command.name}`);
}

/** Built-ins take precedence; catalog commands remain distinct from explicit skill turns. */
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
    case "mode":
      if (!arg) show(host.current().mode);
      else if (arg === "full" || arg === "guarded") await host.switchTo({ mode: arg });
      else show(`unknown mode ${arg}; expected full or guarded`);
      break;
    case "model":
      if (arg) await host.switchTo({ model: arg });
      else show(host.models.join("\n"));
      break;
    case "sessions":
      for (const row of await host.listSessions()) {
        show(
          `${row.sessionId} ${row.title ?? ""}${row.heldByPid === undefined ? "" : ` in use by pid ${row.heldByPid}`}`,
        );
      }
      break;
    case "resume":
      await host.resume(arg ? { id: arg } : {});
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

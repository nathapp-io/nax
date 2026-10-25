import { join } from "node:path";
import type { ChatHost } from "@/chat";
import { featureDir } from "@/config";
import { buildChatFeatureMessage } from "@/prompts";

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
const COMMANDS = ["help", "mode", "model", "sessions", "resume", "clear", "cost", "feature", "quit"];

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

/** Local commands never send input. Only /feature returns a builder-produced turn. */
export async function runSlashCommand(
  command: SlashCommand,
  { host, show }: CommandContext,
): Promise<string | undefined> {
  const arg = command.args[0];
  switch (command.name) {
    case "help":
      show(COMMANDS.map((name) => `/${name}`).join("\n"));
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
    case "feature":
      return featureMessage(command, host, show);
    default:
      show(`unknown command /${command.name}`);
  }
}

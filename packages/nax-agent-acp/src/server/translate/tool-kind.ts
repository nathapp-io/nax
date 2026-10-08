/**
 * How a native tool call is shown to an ACP client (S5 spec §4.2): its kind, a
 * one-line title and the file it touches. Inputs are model-written, so every
 * field is checked before use and titles are stripped of control characters.
 */
import { resolve } from "node:path";
import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { isRecord, stripControl } from "#src/client/text";

export const TITLE_DETAIL_MAX = 60;

const KIND_BY_TOOL: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ["Read", "read"],
  ["ScratchpadRead", "read"],
  ["ScratchpadList", "read"],
  ["Glob", "search"],
  ["Grep", "search"],
  ["Edit", "edit"],
  ["Write", "edit"],
  ["ScratchpadWrite", "edit"],
  ["Delete", "delete"],
  ["Bash", "execute"],
  ["RunCommand", "execute"],
  ["Git", "execute"],
  ["GitCommit", "execute"],
]);

/** Tools whose `path` is a repository file (scratchpad paths are not). */
const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "Delete"]);

export function toolKind(name: string): ToolKind {
  return KIND_BY_TOOL.get(name) ?? "other";
}

export function inputString(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function oneLine(text: string): string {
  const flat = stripControl(text).replace(/\s+/g, " ").trim();
  return flat.length > TITLE_DETAIL_MAX ? `${flat.slice(0, TITLE_DETAIL_MAX - 3)}...` : flat;
}

export function toolTitle(name: string, input: unknown): string {
  const kind = toolKind(name);
  const path = inputString(input, "path");
  if (path !== undefined && (FILE_TOOLS.has(name) || name.startsWith("Scratchpad"))) return `${name} ${oneLine(path)}`;
  const pattern = inputString(input, "pattern");
  if (pattern !== undefined && kind === "search") return `${name} ${oneLine(pattern)}`;
  const command = inputString(input, "command");
  if (command !== undefined && kind === "execute") return `${name}: ${oneLine(command)}`;
  const subcommand = inputString(input, "subcommand");
  if (name === "Git" && subcommand !== undefined) return `Git ${oneLine(subcommand)}`;
  const message = inputString(input, "message");
  if (name === "GitCommit" && message !== undefined) return `GitCommit: ${oneLine(message.split("\n")[0] ?? "")}`;
  return name;
}

export function resolveToolPath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

export function toolLocations(name: string, input: unknown, cwd: string): ToolCallLocation[] | undefined {
  if (!FILE_TOOLS.has(name)) return undefined;
  const path = inputString(input, "path");
  return path === undefined ? undefined : [{ path: resolveToolPath(cwd, path) }];
}

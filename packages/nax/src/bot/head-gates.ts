/** nax#2838: the gates a PR head's own `.nax/config.json` configures, read without any config layering. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { GATE_ORDER } from "@/finish";

function isConfigured(command: unknown): boolean {
  if (typeof command === "string") return command.trim().length > 0;
  return Array.isArray(command) && command.some((part) => typeof part === "string" && part.trim().length > 0);
}

/**
 * Root gate names (in `GATE_ORDER`) the head's own project file configures. A missing file means none;
 * unreadable or invalid JSON throws so the caller fails closed. It never walks up to a parent project
 * and applies no global or profile layer: those are not the PR head.
 */
export async function readHeadGateNames(worktree: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(join(worktree, ".nax", "config.json"), "utf8");
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null)
    throw new NaxError("[bot-fix] head .nax/config.json is not an object", "BOT_HEAD_CONFIG_INVALID", {
      stage: "bot-fix",
      worktree,
    });
  const quality: unknown = (parsed as { quality?: unknown }).quality;
  const commands: unknown =
    typeof quality === "object" && quality !== null ? (quality as { commands?: unknown }).commands : undefined;
  if (typeof commands !== "object" || commands === null) return [];
  const record = commands as Record<string, unknown>;
  return GATE_ORDER.filter((name) => isConfigured(record[name]));
}

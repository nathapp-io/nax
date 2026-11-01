/**
 * Agent hooks config loader
 *
 * Reads the `agent` section of the global (`~/.nax/hooks.json`) and project
 * (`<repoRoot>/.nax/hooks.json`) hook files. Deliberately separate from
 * `loadHooksConfig`: that one loads the lifecycle `hooks` map and is unchanged.
 *
 * The loader is tolerant by design — a hooks.json is user-edited text, so a
 * malformed file or entry must never stop chat or a run. Each file is read
 * with `Bun.file(...).text()` + `JSON.parse` rather than `loadJsonFile`, which
 * would log a second warning under the `hooks` stage.
 */

import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { z } from "zod";
import { getLogger } from "@/logger";
import {
  AGENT_HOOK_EVENTS,
  type AgentHookEntry,
  type AgentHookEvent,
  type AgentHookSurface,
  type AgentHooksConfig,
} from "./types";

/** Logger stage every agent-hooks record uses. */
const AGENT_HOOKS_STAGE = "agent-hooks";

/** Name of the file read from each config directory. */
const HOOKS_FILE_NAME = "hooks.json";

/**
 * Per-hook deadline used when an entry omits `timeout`. A constant by ruling,
 * not a `NaxConfig` key: it bounds liveness rather than being per-project
 * policy, and a user tunes a hook through its own `timeout`.
 */
const DEFAULT_AGENT_HOOK_TIMEOUT_MS = 30000;
const MIN_AGENT_HOOK_TIMEOUT_MS = 1;
const MAX_AGENT_HOOK_TIMEOUT_MS = 600_000;

/** Surfaces an entry runs on when it omits `scope`. */
const DEFAULT_AGENT_HOOK_SCOPE = ["chat", "run"] as const satisfies readonly AgentHookSurface[];

/** Which hooks.json an entry came from. */
type AgentHookOrigin = AgentHookEntry["origin"];

/** Entries collected from one file, keyed by the events that file mentions. */
type CollectedHooks = Partial<Record<AgentHookEvent, AgentHookEntry[]>>;

/** One file's raw content, distinguishing "absent" from "unreadable/corrupt". */
type HooksFileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "value"; readonly value: unknown };

function compilesAsRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    // An unusable pattern is a load-time skip with a warning, never a crash.
    return false;
  }
}

/**
 * `"*"` means every tool and is checked before any compile; anything else must
 * match the whole tool name, so both the raw value and its `^(?:…)$` form must
 * be valid regular expressions.
 */
function isValidMatcher(matcher: string): boolean {
  if (matcher === "*") return true;
  return compilesAsRegExp(matcher) && compilesAsRegExp(`^(?:${matcher})$`);
}

const AgentHookMatcherSchema = z
  .string()
  .refine(isValidMatcher, { message: "matcher is not a valid regular expression" });

const AgentHookEntrySchema = z.object({
  command: z.string().min(1),
  matcher: AgentHookMatcherSchema.optional(),
  scope: z
    .array(z.enum(["chat", "run"]))
    .min(1)
    .default([...DEFAULT_AGENT_HOOK_SCOPE]),
  timeout: z
    .number()
    .int()
    .min(MIN_AGENT_HOOK_TIMEOUT_MS)
    .max(MAX_AGENT_HOOK_TIMEOUT_MS)
    .default(DEFAULT_AGENT_HOOK_TIMEOUT_MS),
  enabled: z.boolean().default(true),
});

/** True for a plain JSON object — arrays and `null` are not objects here. */
function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentHookEvent(key: string): key is AgentHookEvent {
  return (AGENT_HOOK_EVENTS as readonly string[]).includes(key);
}

async function readHooksFile(path: string): Promise<HooksFileRead> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { kind: "missing" };
  try {
    return { kind: "value", value: JSON.parse(await file.text()) };
  } catch (err) {
    return { kind: "invalid", reason: errorMessage(err) };
  }
}

function warnFileProblem(path: string, reason: string): void {
  getLogger().warn(AGENT_HOOKS_STAGE, `Ignoring agent hooks in ${path}: ${reason}`, { path, reason });
}

function warnUnknownEvent(event: string, path: string): void {
  getLogger().warn(AGENT_HOOKS_STAGE, `Ignoring unknown agent hook event "${event}" in ${path}`, { event, path });
}

function warnEventNotArray(event: AgentHookEvent, origin: AgentHookOrigin, path: string): void {
  getLogger().warn(
    AGENT_HOOKS_STAGE,
    `Ignoring agent hook ${event} from ${origin} hooks.json (${path}): the event's value is not an array`,
    { event, origin, path },
  );
}

function warnInvalidEntry(
  event: AgentHookEvent,
  index: number,
  origin: AgentHookOrigin,
  path: string,
  reason: string,
): void {
  getLogger().warn(
    AGENT_HOOKS_STAGE,
    `Ignoring invalid agent hook ${event}[${index}] from ${origin} hooks.json (${path}): ${reason}`,
    { event, index, origin, path, reason },
  );
}

/** One line naming every failed constraint, for an entry's warning. */
function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(entry)"}: ${issue.message}`).join("; ");
}

/** Whether the project file asks to skip the global file's sections. */
function skipGlobalRequested(read: HooksFileRead): boolean {
  return read.kind === "value" && isObjectValue(read.value) && read.value.skipGlobal === true;
}

function toEntry(raw: z.infer<typeof AgentHookEntrySchema>, origin: AgentHookOrigin): AgentHookEntry {
  return {
    command: raw.command,
    ...(raw.matcher === undefined ? {} : { matcher: raw.matcher }),
    scope: raw.scope,
    timeoutMs: raw.timeout,
    origin,
  };
}

function parseEntries(value: unknown, event: AgentHookEvent, origin: AgentHookOrigin, path: string): AgentHookEntry[] {
  if (!Array.isArray(value)) {
    warnEventNotArray(event, origin, path);
    return [];
  }
  const entries: AgentHookEntry[] = [];
  for (const [index, raw] of value.entries()) {
    const parsed = AgentHookEntrySchema.safeParse(raw);
    if (!parsed.success) {
      warnInvalidEntry(event, index, origin, path, formatIssues(parsed.error));
      continue;
    }
    if (!parsed.data.enabled) continue;
    entries.push(toEntry(parsed.data, origin));
  }
  return entries;
}

/**
 * The file's `agent` section, or undefined when the file contributes none.
 * A malformed file or section contributes no hooks and one warning naming it.
 */
function readAgentSection(read: HooksFileRead, path: string): Record<string, unknown> | undefined {
  if (read.kind === "missing") return undefined;
  if (read.kind === "invalid") {
    warnFileProblem(path, `the file is not valid JSON (${read.reason})`);
    return undefined;
  }
  if (!isObjectValue(read.value)) {
    warnFileProblem(path, "the top-level value is not an object");
    return undefined;
  }
  const agent = read.value.agent;
  if (agent === undefined) return undefined;
  if (!isObjectValue(agent)) {
    warnFileProblem(path, "the agent section is not an object");
    return undefined;
  }
  return agent;
}

/** Collect one file's agent entries. Unknown event keys are ignored with a warning. */
function collectAgentHooks(read: HooksFileRead, origin: AgentHookOrigin, path: string): CollectedHooks {
  const agent = readAgentSection(read, path);
  if (agent === undefined) return {};
  const collected: CollectedHooks = {};
  for (const [key, value] of Object.entries(agent)) {
    if (!isAgentHookEvent(key)) {
      warnUnknownEvent(key, path);
      continue;
    }
    collected[key] = parseEntries(value, key, origin, path);
  }
  return collected;
}

/** Merge one event's entries, global first, into an always-complete config. */
function mergeHooks(globalHooks: CollectedHooks, projectHooks: CollectedHooks): AgentHooksConfig {
  const merged = {} as Record<AgentHookEvent, readonly AgentHookEntry[]>;
  for (const event of AGENT_HOOK_EVENTS) {
    merged[event] = [...(globalHooks[event] ?? []), ...(projectHooks[event] ?? [])];
  }
  return merged;
}

/**
 * Load the `agent` section of the global and project hooks.json files.
 *
 * Global entries run before project entries; `skipGlobal: true` in the project
 * file drops the global file's agent section. Every event is present in the
 * result, with an empty array when neither file contributes hooks.
 *
 * @param projectNaxDir - The project's `.nax` directory (`<repoRoot>/.nax`)
 * @param globalDir - The global nax directory (`~/.nax`), when it should be read
 * @returns Every event's entries, global before project
 */
export async function loadAgentHooksConfig(projectNaxDir: string, globalDir?: string): Promise<AgentHooksConfig> {
  const projectPath = join(projectNaxDir, HOOKS_FILE_NAME);
  const projectRead = await readHooksFile(projectPath);
  const projectHooks = collectAgentHooks(projectRead, "project", projectPath);
  const globalHooks =
    globalDir === undefined || skipGlobalRequested(projectRead) ? {} : await readGlobalHooks(globalDir);
  return mergeHooks(globalHooks, projectHooks);
}

/** Collect the global file's agent entries (its own read, its own warning). */
async function readGlobalHooks(globalDir: string): Promise<CollectedHooks> {
  const globalPath = join(globalDir, HOOKS_FILE_NAME);
  return collectAgentHooks(await readHooksFile(globalPath), "global", globalPath);
}

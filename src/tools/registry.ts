/**
 * Name-to-tool registry, mirroring PULL_TOOL_REGISTRY in the context engine.
 *
 * Open to third-party registration, with two rules that make that safe:
 * built-in names are reserved (a registered "Write" would shadow the gated
 * implementation), and a verb-gated tool must declare the verbs it permits so
 * the policy can never be granted a subcommand the tool itself disallows.
 *
 * Registration is in-process — another nax module or plugin. This is an
 * extension point, not a plugin download path.
 */

import type { JSONSchema } from "@/context/engine";
import { NaxError } from "@/errors";
import type { CodingToolName, ToolScope } from "./types";

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface ToolRunContext {
  /** Absolute, symlink-resolved permitted root. */
  readonly root: string;
  /** Paths the policy already resolved and approved, in pathFields order. */
  readonly resolvedPaths: readonly string[];
  /** Output ceiling in bytes; the tool truncates rather than the caller. */
  readonly maxBytes: number;
}

export interface CodingTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly scope: ToolScope;
  run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>;
}

/** Built-in names may never be re-registered. */
export const RESERVED_TOOL_NAMES: readonly CodingToolName[] = ["Read", "Glob", "Grep", "Write", "Edit", "Git"];

const registry = new Map<string, CodingTool>();

export function registerCodingTool(tool: CodingTool): void {
  if ((RESERVED_TOOL_NAMES as readonly string[]).includes(tool.name) && !internalRegistration) {
    throw new NaxError(
      `Tool name "${tool.name}" is reserved for a nax built-in and cannot be re-registered.`,
      "TOOL_NAME_RESERVED",
      { stage: "tools", tool: tool.name },
    );
  }
  if (registry.has(tool.name)) {
    throw new NaxError(`Tool "${tool.name}" is already registered.`, "TOOL_ALREADY_REGISTERED", {
      stage: "tools",
      tool: tool.name,
    });
  }
  if (tool.scope.verbField !== undefined && tool.scope.allowedVerbs === undefined) {
    throw new NaxError(
      `Tool "${tool.name}" declares verbField but no allowedVerbs; the policy would have no bound to enforce.`,
      "TOOL_SCOPE_INCOMPLETE",
      { stage: "tools", tool: tool.name },
    );
  }
  registry.set(tool.name, tool);
}

let internalRegistration = false;

/** Register a nax built-in, bypassing the reserved-name check by design. */
export function registerBuiltinTool(tool: CodingTool): void {
  internalRegistration = true;
  try {
    registerCodingTool(tool);
  } finally {
    internalRegistration = false;
  }
}

export function getCodingTool(name: string): CodingTool | undefined {
  return registry.get(name);
}

export function listCodingTools(): readonly CodingTool[] {
  return [...registry.values()];
}

/** @internal Test-only: clears registrations between cases. */
export function _resetRegistryForTest(): void {
  registry.clear();
}

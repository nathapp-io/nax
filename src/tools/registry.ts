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
  /**
   * Set only by RunCommand's argv branch (`Exec`), which is the one call
   * shape whose executed argv can differ from what the model requested
   * (normalization scopes it to a workspace member and may append a
   * no-scripts mechanism). Returned here rather than re-derived by the
   * runtime so the ledger records the argv that actually ran. Task 7 reads
   * this to write `executed`/`target` onto the ledger row; this task only
   * defines and returns it.
   */
  readonly audit?: {
    readonly executed: readonly string[];
    readonly target: "repoRoot" | "package";
  };
}

export interface ToolRunContext {
  /** Absolute, symlink-resolved permitted root. */
  readonly root: string;
  /** Paths the policy already resolved and approved, in pathFields order. */
  readonly resolvedPaths: readonly string[];
  /** Output ceiling in bytes; the tool truncates rather than the caller. */
  readonly maxBytes: number;
  /**
   * Largest file this tool may read whole or write. Bounds the work, where
   * maxBytes bounds only what the model is told -- see src/tools/bounded.ts.
   */
  readonly maxFileBytes: number;
}

export interface CodingTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly scope: ToolScope;
  /**
   * True when an `isError` result is a routine part of using this tool rather
   * than a fault worth an operator's attention. Only `RunCommand` sets it: a
   * non-zero exit from a project command is the agent's own red/green loop, and
   * on the acpx transport that loop runs inside the spawned agent where nax
   * never observes it. Such calls are recorded at debug — the JSONL and the
   * audit sink still get them, the console does not. Everything else defaults
   * to false, so a malformed Read or a failed GitCommit stays visible.
   */
  readonly routineErrors?: boolean;
  run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>;
}

/** Built-in names may never be re-registered. */
export const RESERVED_TOOL_NAMES: readonly CodingToolName[] = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Git",
  "GitCommit",
  "RunCommand",
  "RequestCapability",
  "Exec",
];

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

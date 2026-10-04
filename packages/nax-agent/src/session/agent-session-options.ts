/**
 * Validates createAgentSession's options (spec 4.1, 7). zod checks the shape;
 * the result keeps the caller's own objects (zod returns copies, which would
 * detach a class-based tool's methods from `this`).
 */
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { parseNativeModel } from "#src/native/models";
import { ASK_HUMAN_TOOL_NAME } from "#src/native/session/ask-human";
import { RESERVED_TOOL_NAMES } from "#src/tools/registry";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { CreateAgentSessionOptions, EmbedderTool } from "./agent-session-types.ts";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;
export const DEFAULT_TURN_TIMEOUT_SECONDS = 3600;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const STORE_METHODS = ["load", "save", "retainFailed", "delete", "markTurn"] as const;

export interface ResolvedAgentSessionOptions {
  /** The caller's object, unchanged (tool objects keep their `this`). */
  readonly raw: CreateAgentSessionOptions;
  readonly provider: string;
  readonly approvalTimeoutMs: number;
  readonly turnTimeoutSeconds: number;
  readonly bashApproval: BashApprovalMode;
  readonly allowUnsandboxed: boolean;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tools: readonly EmbedderTool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMethods(names: readonly string[]): (value: unknown) => boolean {
  return (value) => isRecord(value) && names.every((name) => typeof value[name] === "function");
}

const isFunction = (value: unknown): boolean => typeof value === "function";

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const EmbedderToolSchema = z.object({
  name: z.string().regex(TOOL_NAME, "must be a letter, then letters, digits, _ or -, at most 64 characters"),
  description: z.string().min(1),
  inputSchema: z.custom<Record<string, unknown>>(isRecord, "must be a JSON Schema object"),
  approval: z.enum(["never", "always"]),
  describe: z.custom(isFunction, "must be a function").optional(),
  run: z.custom(isFunction, "must be a function"),
});

const OptionsSchema = z.strictObject({
  backend: z.literal("native"),
  sessionId: z
    .string()
    .regex(SESSION_ID, "must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit")
    .optional(),
  model: z.string().min(1),
  profile: z.enum(["none", "read", "full"]),
  workdir: z
    .string()
    .refine((dir) => isAbsolute(dir), "must be an absolute path")
    .optional(),
  instructions: z.string().optional(),
  tools: z.array(EmbedderToolSchema).optional(),
  transcriptStore: z.custom(hasMethods(STORE_METHODS), `must implement ${STORE_METHODS.join(", ")}`),
  approvalTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
  bashApproval: z.enum(["raw", "gated", "escalate"]).optional(),
  allowUnsandboxed: z.boolean().optional(),
  credentials: z
    .custom(
      (value) => isRecord(value) && (value.kind === "memory" || value.kind === "exec"),
      "must be a memory or exec source",
    )
    .optional(),
  catalogOverrides: z.array(z.custom(isRecord, "must be a catalog override object")).optional(),
  loopHandlers: z.array(z.custom(isRecord, "must be a loop handler entry")).optional(),
  hostPorts: z
    .strictObject({
      protectedPaths: z
        .custom(
          (value) =>
            isRecord(value) && isStringArray(value.gitExcludePathspecs) && isStringArray(value.gitIgnorePatterns),
          "must be a protected-paths policy with gitExcludePathspecs and gitIgnorePatterns string arrays",
        )
        .optional(),
      commandInterceptor: z.custom(hasMethods(["intercept"]), "must implement intercept").optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  turnTimeoutSeconds: z.number().int().min(1).max(86_400).optional(),
});

function invalid(message: string, context: Record<string, unknown> = {}): AgentSessionError {
  return new AgentSessionError(`Invalid agent session options: ${message}`, "AGENT_SESSION_INVALID_OPTIONS", context);
}

function checkShape(input: unknown): CreateAgentSessionOptions {
  if (isRecord(input) && "mcpServers" in input) {
    throw invalid("mcpServers is reserved for a later release (an MCP client for embedder tools)", {
      path: "mcpServers",
    });
  }
  if (isRecord(input) && isRecord(input.hostPorts) && "runDeclaredCommand" in input.hostPorts) {
    throw invalid("hostPorts.runDeclaredCommand is deferred to a later release", {
      path: "hostPorts.runDeclaredCommand",
    });
  }
  const parsed = OptionsSchema.safeParse(input);
  if (parsed.success) return input as CreateAgentSessionOptions;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "options" : issue.path.join(".");
  throw invalid(`${path}: ${issue?.message ?? "invalid"}`, { path });
}

function checkProfileRules(options: CreateAgentSessionOptions): void {
  if (options.profile !== "none" && options.workdir === undefined) {
    throw invalid(`workdir is required for profile "${options.profile}"`, { path: "workdir" });
  }
  if (options.profile !== "full" && options.bashApproval !== undefined) {
    throw invalid('bashApproval applies to profile "full" only', { path: "bashApproval" });
  }
  if (options.profile !== "full" && options.allowUnsandboxed !== undefined) {
    throw invalid('allowUnsandboxed applies to profile "full" only', { path: "allowUnsandboxed" });
  }
  if (options.allowUnsandboxed === true && (options.bashApproval ?? "gated") !== "gated") {
    throw invalid('allowUnsandboxed requires bashApproval "gated"', { path: "allowUnsandboxed" });
  }
}

function checkToolNames(tools: readonly EmbedderTool[]): void {
  const reserved = new Set<string>([...RESERVED_TOOL_NAMES, ASK_HUMAN_TOOL_NAME]);
  const seen = new Set<string>();
  for (const tool of tools) {
    if (reserved.has(tool.name)) {
      throw new AgentSessionError(
        `Embedder tool name "${tool.name}" is reserved for a built-in tool`,
        "AGENT_SESSION_TOOL_NAME_RESERVED",
        { tool: tool.name },
      );
    }
    if (seen.has(tool.name)) throw invalid(`tools: duplicate tool name "${tool.name}"`, { path: "tools" });
    seen.add(tool.name);
  }
}

function providerOf(model: string): string {
  try {
    return parseNativeModel(model).provider;
  } catch {
    throw invalid(`model: "${model}" is not "provider/model[effort]"`, { path: "model" });
  }
}

export function resolveAgentSessionOptions(input: unknown): ResolvedAgentSessionOptions {
  const options = checkShape(input);
  checkProfileRules(options);
  const tools = options.tools ?? [];
  checkToolNames(tools);
  return {
    raw: options,
    provider: providerOf(options.model),
    approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    turnTimeoutSeconds: options.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS,
    bashApproval: options.bashApproval ?? "gated",
    allowUnsandboxed: options.allowUnsandboxed === true,
    metadata: options.metadata ?? {},
    tools,
  };
}

/**
 * `mcp` config block — external MCP servers the native agent may call tools on.
 *
 * `.strict()` throughout: a typo'd key must fail loudly. A silently stripped
 * `stage:` (for `stages:`) would leave a server attached to nothing, which
 * reads at runtime as "MCP is broken" rather than "the config has a typo".
 *
 * Server ids are PROVIDER ids (src/tools/provider-types.ts): the id is the tool
 * name's namespace, so the two charsets must agree or a config that parses
 * would throw at adaptation time instead.
 */
import { z } from "zod";

/** Mirrors PROVIDER_ID_RE; `__` is additionally excluded below (it is the namespace separator). */
export const MCP_SERVER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Per-call ceiling. Not a measured value: nax's own bounds are GIT_TIMEOUT_MS
 * 10s (src/utils/git.ts) and EXEC_TIMEOUT_MS 300s (src/tools/run-command-exec.ts),
 * and MCP calls span both extremes — a graph search is milliseconds, an index
 * rebuild is minutes. 60s is long enough for any interactive query and short
 * enough that a wedged server does not consume a hop. A server with genuinely
 * long operations raises its own `timeoutMs`.
 */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * PipelineStage (src/config/permissions.ts:18-27) plus `"*"`. Spelled out rather
 * than derived so an unknown stage is a schema error at load, not a server that
 * silently attaches to nothing. There is no `implement` stage.
 */
export const McpStageSchema = z.enum([
  "plan",
  "run",
  "setup",
  "verify",
  "review",
  "rectification",
  "regression",
  "acceptance",
  "complete",
  "*",
]);

export const McpServerSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    stages: z.array(McpStageSchema).default([]),
    /** Omitted => every locked tool is grantable. */
    allowedTools: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().default(MCP_DEFAULT_TIMEOUT_MS),
    /** Kill switch that needs no lock entry and invalidates no lock. */
    enabled: z.boolean().default(true),
  })
  .strict();

const McpServerIdSchema = z
  .string()
  .regex(MCP_SERVER_ID_RE)
  .refine((id) => !id.includes("__"), { message: "server id may not contain '__' (the tool-name separator)" });

export const McpConfigSchema = z
  .object({
    servers: z.record(McpServerIdSchema, McpServerSchema).default({}),
  })
  .strict();

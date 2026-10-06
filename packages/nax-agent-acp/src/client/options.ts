/**
 * acpBackend options (S4 spec §6.2), validated with zod at the factory, so a bad
 * option fails at acpBackend() and never at open. allowUnsandboxed is checked
 * first: anything but `true` is AGENT_SESSION_SANDBOX_UNAVAILABLE (R7).
 */
import { isAbsolute } from "node:path";
import { AgentSessionError } from "@nathapp/nax-agent";
import { z } from "zod";
import { buildAgentEnv, secretValues } from "#src/client/env";
import {
  type AcpAgentName,
  type AgentRegistryEntry,
  isAcpAgentName,
  type LaunchCandidate,
  registryEntry,
} from "#src/client/registry";

export const DEFAULT_CANCEL_GRACE_MS = 10_000;
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;

export type AcpAgentSpec =
  | AcpAgentName
  | { readonly name: string; readonly command: string; readonly args?: readonly string[] };

export interface AcpBackendOptions {
  readonly agent: AcpAgentSpec;
  /** Required: the agent process runs on the host, unsandboxed (R7). */
  readonly allowUnsandboxed: true;
  /** Applied via session/set_config_option (category "model") before open returns. */
  readonly model?: string;
  /** Added to the agent's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default false: the allowlist only. true hands the whole process.env to the agent. */
  readonly inheritEnv?: boolean;
  /** Overrides the registry's launch command (a bare name or an absolute path). */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cancelGraceMs?: number;
  readonly initializeTimeoutMs?: number;
}

export type AcpLaunch =
  | { readonly kind: "explicit"; readonly candidate: LaunchCandidate }
  | { readonly kind: "registry"; readonly candidates: readonly LaunchCandidate[] };

export interface ResolvedAcpOptions {
  /** "acp:<agent name>". */
  readonly kind: string;
  readonly agentName: string;
  /** Undefined for a custom agent: no modes, no pre-approval, no auth variables. */
  readonly entry: AgentRegistryEntry | undefined;
  readonly launch: AcpLaunch;
  readonly model: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  /** Values redacted from every agent excerpt (D-g). */
  readonly secrets: readonly string[];
  readonly cancelGraceMs: number;
  readonly initializeTimeoutMs: number;
}

const noNul = (value: string): boolean => !value.includes("\u0000");
const plain = z.string().refine(noNul, "must not contain NUL");
const command = z
  .string()
  .min(1)
  .refine(noNul, "must not contain NUL")
  .refine((c) => !c.includes("/") || isAbsolute(c), "a command is a bare name or an absolute path");
const customAgent = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9._-]{0,63}$/, "a lowercase name of at most 64 characters")
    .refine((name) => !isAcpAgentName(name), "a custom agent may not reuse a registered name"),
  command,
  args: z.array(plain).optional(),
});
const SCHEMA = z
  .strictObject({
    agent: z.union([z.enum(["claude", "codex", "gemini", "opencode", "pi"]), customAgent]),
    allowUnsandboxed: z.literal(true),
    model: z.string().min(1).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), plain).optional(),
    inheritEnv: z.boolean().optional(),
    command: command.optional(),
    args: z.array(plain).optional(),
    cancelGraceMs: z.number().int().positive().max(600_000).optional(),
    initializeTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.args !== undefined && value.command === undefined) {
      ctx.addIssue({ code: "custom", path: ["args"], message: "args needs command" });
    }
    if (typeof value.agent === "object" && value.command !== undefined) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "a custom agent carries its own command" });
    }
  });

type ParsedOptions = z.output<typeof SCHEMA>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function launchOf(data: ParsedOptions, entry: AgentRegistryEntry | undefined): AcpLaunch {
  if (data.command !== undefined)
    return { kind: "explicit", candidate: { command: data.command, args: data.args ?? [] } };
  if (typeof data.agent === "object") {
    return { kind: "explicit", candidate: { command: data.agent.command, args: data.agent.args ?? [] } };
  }
  return { kind: "registry", candidates: entry?.launch ?? [] };
}

function resolved(data: ParsedOptions, source: Readonly<Record<string, string | undefined>>): ResolvedAcpOptions {
  const agentName = typeof data.agent === "string" ? data.agent : data.agent.name;
  const entry = typeof data.agent === "string" ? registryEntry(data.agent) : undefined;
  const env = buildAgentEnv({
    source,
    inheritEnv: data.inheritEnv ?? false,
    authEnv: entry?.authEnv ?? [],
    extra: data.env ?? {},
  });
  return Object.freeze({
    kind: `acp:${agentName}`,
    agentName,
    entry,
    launch: launchOf(data, entry),
    model: data.model,
    env: Object.freeze(env),
    secrets: Object.freeze([...secretValues(env)]),
    cancelGraceMs: data.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    initializeTimeoutMs: data.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
  });
}

export function resolveAcpOptions(
  input: unknown,
  source: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedAcpOptions {
  if (!isRecord(input) || input.allowUnsandboxed !== true) {
    throw new AgentSessionError(
      "acpBackend requires allowUnsandboxed: true: the agent process runs on the host, unsandboxed",
      "AGENT_SESSION_SANDBOX_UNAVAILABLE",
      { path: "allowUnsandboxed" },
    );
  }
  const parsed = SCHEMA.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? "" : issue.path.map(String).join(".");
    throw new AgentSessionError(
      `Invalid acpBackend options: ${path === "" ? "(options)" : path}: ${issue?.message ?? "invalid"}`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path },
    );
  }
  return resolved(parsed.data, source);
}

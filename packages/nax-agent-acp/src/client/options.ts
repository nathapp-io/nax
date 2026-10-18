/**
 * acpBackend options (S4 spec §6.2), validated with zod at the factory, so a bad
 * option fails at acpBackend() and never at open. allowUnsandboxed is checked
 * first: anything but `true` is AGENT_SESSION_SANDBOX_UNAVAILABLE (R7).
 */
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
import { type AcpPermissionRules, type AcpRule, NO_RULES } from "#src/client/rule-policy";

import type { ShellSandboxPlan } from "#src/client/shell-sandbox";

export const DEFAULT_CANCEL_GRACE_MS = 10_000;
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;

/** Where rule-policy files go when the caller names no directory (rule-policy.ts, US-004 writes them). */
export const DEFAULT_STATE_DIR = join(tmpdir(), "nax-agent-acp");

export type AcpAgentSpec =
  | AcpAgentName
  | { readonly name: string; readonly command: string; readonly args?: readonly string[] };

/** Called for every agent process the backend spawns, including a reconnect's (S4b spec §8). Errors are logged and ignored. */
export interface AcpProcessHooks {
  spawned?(pid: number): void;
  exited?(pid: number): void;
}

export interface AcpBackendOptions {
  readonly agent: AcpAgentSpec;
  /** Required: the agent process runs on the host, unsandboxed (R7). */
  readonly allowUnsandboxed: true;
  /** Applied via session/set_config_option (category "model") before open returns. */
  readonly model?: string;
  /** Reasoning effort, set via session/set_config_option after the model (S4b spec 8). Skipped when not offered. */
  readonly effort?: string;
  /** Added to the agent's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default false: the allowlist only. true hands the whole process.env to the agent. */
  readonly inheritEnv?: boolean;
  /** nax's permission rules, translated into the agent's own config where the agent supports it. */
  readonly rules?: {
    readonly allow?: readonly AcpRule[];
    readonly deny?: readonly AcpRule[];
    readonly ask?: readonly AcpRule[];
  };
  /** Where an agent's rule-policy files are written; absolute. Defaults to DEFAULT_STATE_DIR. */
  readonly stateDir?: string;
  /** Optional command-only sandbox; the agent process still runs on the host. */
  readonly shellSandbox?: {
    readonly runtime: string;
    readonly runner: readonly string[];
    readonly pi?: { readonly extensions?: "user" | "none" };
    readonly opencode?: { readonly projectConfig?: "disable" | "keep" };
    readonly cursor?: { readonly onUnwrapped?: "rules" | "deny" };
  };
  /** Overrides the registry's launch command (a bare name or an absolute path). */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cancelGraceMs?: number;
  readonly initializeTimeoutMs?: number;
  /** Called with the pid of every agent process, including after a reconnect. Not called when the spawn fails. */
  readonly onProcess?: AcpProcessHooks;
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
  readonly effort: string | undefined;
  /** The rules translated into the agent's own config; NO_RULES when the caller has none. */
  readonly rules: AcpPermissionRules;
  /** The directory an agent's rule-policy files go in (absolute). */
  readonly stateDir: string;
  readonly shellSandbox:
    | {
        readonly runtime: string;
        readonly runner: readonly string[];
        readonly piExtensions: "user" | "none";
        readonly opencodeProjectConfig: "disable" | "keep";
        readonly cursorOnUnwrapped: "rules" | "deny";
      }
    | undefined;
  readonly shellSandboxPlan?: ShellSandboxPlan;
  readonly env: Readonly<Record<string, string>>;
  /** Values redacted from every agent excerpt (D-g). */
  readonly secrets: readonly string[];
  readonly cancelGraceMs: number;
  readonly initializeTimeoutMs: number;
  readonly onProcess: AcpProcessHooks | undefined;
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
/** One `Tool(pattern, …)` grant: a tool name and at least one pattern. */
const ruleSchema = z.strictObject({ tool: plain.min(1), patterns: z.array(plain).min(1) });
const rulesSchema = z.strictObject({
  allow: z.array(ruleSchema).optional(),
  deny: z.array(ruleSchema).optional(),
  ask: z.array(ruleSchema).optional(),
});
/** Rule-policy files are written outside the workdir, so the caller must be explicit about where. */
const stateDirSchema = plain.refine(isAbsolute, "must be an absolute path");
const SCHEMA = z
  .strictObject({
    agent: z.union([z.enum(["claude", "codex", "cursor", "gemini", "opencode", "pi"]), customAgent]),
    allowUnsandboxed: z.literal(true),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), plain).optional(),
    inheritEnv: z.boolean().optional(),
    rules: rulesSchema.optional(),
    stateDir: stateDirSchema.optional(),
    shellSandbox: z
      .strictObject({
        runtime: stateDirSchema,
        runner: z.array(plain).min(1),
        pi: z.strictObject({ extensions: z.enum(["user", "none"]).optional() }).optional(),
        opencode: z.strictObject({ projectConfig: z.enum(["disable", "keep"]).optional() }).optional(),
        cursor: z.strictObject({ onUnwrapped: z.enum(["rules", "deny"]).optional() }).optional(),
      })
      .optional(),
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

/** A frozen copy of one parsed rule; the caller's arrays never reach the resolved options. */
function freezeRule(rule: { readonly tool: string; readonly patterns: readonly string[] }): AcpRule {
  return Object.freeze({ tool: rule.tool, patterns: Object.freeze([...rule.patterns]) });
}

/** The caller's rules with every absent list empty, deeply frozen; NO_RULES when there are none. */
function freezeRules(input: z.output<typeof rulesSchema> | undefined): AcpPermissionRules {
  if (input === undefined) return NO_RULES;
  return Object.freeze({
    allow: Object.freeze((input.allow ?? []).map(freezeRule)),
    deny: Object.freeze((input.deny ?? []).map(freezeRule)),
    ask: Object.freeze((input.ask ?? []).map(freezeRule)),
  });
}

function freezeShellSandbox(input: ParsedOptions["shellSandbox"]): ResolvedAcpOptions["shellSandbox"] {
  if (input === undefined) return undefined;
  return Object.freeze({
    runtime: input.runtime,
    runner: Object.freeze([...input.runner]),
    piExtensions: input.pi?.extensions ?? "user",
    opencodeProjectConfig: input.opencode?.projectConfig ?? "disable",
    cursorOnUnwrapped: input.cursor?.onUnwrapped ?? "rules",
  });
}

function launchOf(data: ParsedOptions, entry: AgentRegistryEntry | undefined): AcpLaunch {
  if (data.command !== undefined)
    return { kind: "explicit", candidate: { command: data.command, args: data.args ?? [] } };
  if (typeof data.agent === "object") {
    return { kind: "explicit", candidate: { command: data.agent.command, args: data.agent.args ?? [] } };
  }
  return { kind: "registry", candidates: entry?.launch ?? [] };
}

function isProcessHooks(value: unknown): value is AcpProcessHooks {
  if (!isRecord(value)) return false;
  const fnOrAbsent = (v: unknown) => v === undefined || typeof v === "function";
  return fnOrAbsent(value.spawned) && fnOrAbsent(value.exited);
}

function resolved(
  data: ParsedOptions,
  source: Readonly<Record<string, string | undefined>>,
  onProcess: AcpProcessHooks | undefined,
): ResolvedAcpOptions {
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
    effort: data.effort,
    rules: freezeRules(data.rules),
    stateDir: data.stateDir ?? DEFAULT_STATE_DIR,
    shellSandbox: freezeShellSandbox(data.shellSandbox),
    env: Object.freeze(env),
    secrets: Object.freeze([...secretValues(env)]),
    cancelGraceMs: data.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    initializeTimeoutMs: data.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    onProcess,
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
  // Functions are checked by hand: the zod schema validates plain data only.
  const { onProcess, ...rest } = input;
  if (onProcess !== undefined && !isProcessHooks(onProcess)) {
    throw new AgentSessionError(
      "Invalid acpBackend options: onProcess: spawned and exited must be functions",
      "AGENT_SESSION_INVALID_OPTIONS",
      { path: "onProcess" },
    );
  }
  const parsed = SCHEMA.safeParse(rest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? "" : issue.path.map(String).join(".");
    throw new AgentSessionError(
      `Invalid acpBackend options: ${path === "" ? "(options)" : path}: ${issue?.message ?? "invalid"}`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path },
    );
  }
  return resolved(parsed.data, source, onProcess);
}

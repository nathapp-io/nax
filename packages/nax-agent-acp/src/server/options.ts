/**
 * Option resolution for the ACP server (S5 spec §6.1): flag > env > config file >
 * built-in default. Config dir: master plan M-5.
 */
import { join } from "node:path";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import type { CliFlags } from "#src/server/cli";
import { BASH_APPROVALS, type BashApproval, MODES, type NaxConfigSubset, type TierModel } from "#src/server/nax-config";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ServerOptions {
  readonly configDir: string;
  readonly sessionsDir: string;
  readonly defaultModel?: string;
  readonly defaultMode: AgentSessionProfile;
  readonly bashApproval: BashApproval;
  readonly tiers: readonly TierModel[];
  readonly catalogOverrides: readonly Readonly<Record<string, unknown>>[];
}

export type OptionsResult =
  | { readonly ok: true; readonly options: ServerOptions }
  | { readonly ok: false; readonly message: string };

interface Sourced {
  readonly value: string;
  readonly source: string;
}

type Picked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function firstSet(...candidates: readonly (Sourced | undefined)[]): Sourced | undefined {
  return candidates.find((c) => c !== undefined && c.value !== "");
}

function from(value: string | undefined, source: string): Sourced | undefined {
  return value === undefined ? undefined : { value, source };
}

export function resolveConfigDir(flags: CliFlags, env: Env, home: string): string {
  return (
    firstSet(
      from(flags.configDir, "--config-dir"),
      from(env.NAX_AGENT_CONFIG_DIR, "NAX_AGENT_CONFIG_DIR"),
      from(env.NAX_GLOBAL_CONFIG_DIR, "NAX_GLOBAL_CONFIG_DIR"),
    )?.value ?? join(home, ".nax")
  );
}

function pickEnum<T extends string>(
  label: string,
  allowed: readonly T[],
  chosen: Sourced | undefined,
  fallbackValue: T,
): Picked<T> {
  if (chosen === undefined) return { ok: true, value: fallbackValue };
  const match = allowed.find((a) => a === chosen.value);
  if (match !== undefined) return { ok: true, value: match };
  return {
    ok: false,
    message: `invalid ${label} "${chosen.value}" (from ${chosen.source}); expected one of ${allowed.join(", ")}`,
  };
}

export function resolveServerOptions(input: {
  readonly flags: CliFlags;
  readonly env: Env;
  readonly file: NaxConfigSubset;
  readonly configDir: string;
}): OptionsResult {
  const { flags, env, file, configDir } = input;
  const mode = pickEnum(
    "mode",
    MODES,
    firstSet(
      from(flags.mode, "--mode"),
      from(env.NAX_AGENT_MODE, "NAX_AGENT_MODE"),
      from(file.agentServer.defaultMode, "config.json agentServer.defaultMode"),
    ),
    "ask",
  );
  if (!mode.ok) return mode;
  const bash = pickEnum(
    "bash approval",
    BASH_APPROVALS,
    firstSet(
      from(flags.bashApproval, "--bash-approval"),
      from(env.NAX_AGENT_BASH_APPROVAL, "NAX_AGENT_BASH_APPROVAL"),
      from(file.agentServer.bashApproval, "config.json agentServer.bashApproval"),
    ),
    "gated",
  );
  if (!bash.ok) return bash;
  if (mode.value === "ask" && bash.value !== "gated") {
    return {
      ok: false,
      message: `bash approval "${bash.value}" cannot be used with mode "ask"; ask requires gated`,
    };
  }
  const sessionsDir =
    firstSet(
      from(flags.sessionsDir, "--sessions-dir"),
      from(env.NAX_AGENT_SESSIONS_DIR, "NAX_AGENT_SESSIONS_DIR"),
      from(file.agentServer.sessionsDir, "config.json agentServer.sessionsDir"),
    )?.value ?? join(configDir, ".agent-server", "sessions");
  const defaultModel = firstSet(
    from(flags.model, "--model"),
    from(env.NAX_AGENT_MODEL, "NAX_AGENT_MODEL"),
    from(file.tiers.find((t) => t.tier === "balanced")?.model, "config.json models.native.balanced"),
  )?.value;
  return {
    ok: true,
    options: {
      configDir,
      sessionsDir,
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      defaultMode: mode.value,
      bashApproval: bash.value,
      tiers: file.tiers,
      catalogOverrides: file.catalogOverrides,
    },
  };
}

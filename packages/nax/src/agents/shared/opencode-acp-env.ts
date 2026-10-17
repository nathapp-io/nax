/**
 * opencode ACP env injection (US-002, opencode-acp-read-only).
 *
 * opencode loads the operator's global config directory
 * (`~/.config/opencode`, or `$OPENCODE_CONFIG_DIR` when set): plugins are code
 * that runs inside the opencode process, plus MCP servers, agents and provider
 * definitions. A nax session inherits all of it unless it is pointed somewhere
 * else, and `OPENCODE_CONFIG_DIR` is that pointer.
 *
 * The isolated directory is created empty and keeps nothing in it: nax never
 * copies or translates any part of the operator's config, so the session sees
 * opencode's own defaults. Credentials are not affected — opencode keeps them in
 * its *data* dir, not its config dir, so a session with an empty config dir
 * still authenticates.
 *
 * The model def is the carrier, exactly as for codex (`codex-acp-env.ts`):
 * `toSessionModel` copies `ModelDef.env` onto `SessionModel.env`, and
 * `backendEnv` hands every key of it to the agent process. So the injection
 * point is the model def, and this module is the one place that builds it —
 * `selectModel` and `completeAsWithFallback` both reach it through
 * `withAcpEnv` (`acp-env.ts`).
 *
 * It lives under `agents/shared/` rather than `agents/acp/` on purpose: the ACP
 * adapter may not read config (`scripts/check-adapter-no-config-import.sh`), and
 * `opencodeAcpSettings` is a config reader.
 *
 * Fail-open (the "not too tight" ruling): an opencode session whose isolated
 * config dir cannot be created runs on the operator's own opencode config rather
 * than failing the open. Off by default, because an isolated config dir also
 * hides a provider that is only defined in the operator's config.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { DEFAULT_AGENT_OPENCODE_ACP_CONFIG, type NaxConfig } from "@/config";
import { globalConfigDir } from "@/config/paths";
import { getSafeLogger } from "@/logger";

/** The agent name this injection applies to (the registry key in nax-agent-acp). */
const OPENCODE_AGENT_NAME = "opencode";
/** opencode's config-directory override, read by the binary at launch. */
const OPENCODE_CONFIG_DIR_ENV = "OPENCODE_CONFIG_DIR";
/** Isolated-dir location under `globalConfigDir()` (never spelled inline — see paths/index.ts). */
const ISOLATED_OPENCODE_CONFIG_DIR_NAME = "acp";
const ISOLATED_OPENCODE_CONFIG_DIR_LEAF = "opencode-config";

export interface OpencodeAcpSettings {
  readonly isolateConfig: boolean;
}

/** Settings from config.agent.acp.opencode; schema defaults when the config or any level is undefined. */
export function opencodeAcpSettings(config: Pick<NaxConfig, "agent"> | undefined): OpencodeAcpSettings {
  const opencode = config?.agent?.acp?.opencode;
  // The default comes from the schema module's constant rather than a literal
  // here: a second literal is a second source of truth that drifts the first
  // time the schema default moves (same as `codexAcpSettings`).
  return { isolateConfig: opencode?.isolateConfig ?? DEFAULT_AGENT_OPENCODE_ACP_CONFIG.isolateConfig };
}

/** `<globalConfigDir()>/acp/opencode-config` */
export function isolatedOpencodeConfigDir(): string {
  return join(globalConfigDir(), ISOLATED_OPENCODE_CONFIG_DIR_NAME, ISOLATED_OPENCODE_CONFIG_DIR_LEAF);
}

/**
 * The env an opencode model def enters its agent call with — a NEW def, never a
 * mutation of the input. For any other agent name (or none), or with
 * `isolateConfig` off, the input is returned itself, untouched.
 *
 * `OPENCODE_CONFIG_DIR` is added only when the def's own env does not already
 * set it — an operator's `models.opencode.<tier>.env` entry is a deliberate
 * override and nax does not second-guess it. A key set even to an empty string
 * counts: a dir cannot be created for it, and the operator's choice stands.
 *
 * When the isolated dir cannot be created, one warn is logged and
 * `OPENCODE_CONFIG_DIR` is simply omitted — the session then runs on the
 * operator's opencode config, which is the pre-change behaviour.
 */
export function withOpencodeAcpEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: OpencodeAcpSettings,
): T {
  if (agentName !== OPENCODE_AGENT_NAME || !settings.isolateConfig) return def;
  if (def.env?.[OPENCODE_CONFIG_DIR_ENV] !== undefined) return def;
  const configDir = createIsolatedOpencodeConfigDir();
  if (configDir === undefined) return def;
  return { ...def, env: { ...def.env, [OPENCODE_CONFIG_DIR_ENV]: configDir } };
}

/** `isolatedOpencodeConfigDir()` created (recursive) with its one documented failure mode handled. */
function createIsolatedOpencodeConfigDir(): string | undefined {
  const configDir = isolatedOpencodeConfigDir();
  try {
    _opencodeAcpEnvDeps.mkdir(configDir);
    return configDir;
  } catch (err) {
    _opencodeAcpEnvDeps.warn(
      "Could not create the isolated opencode config dir — this opencode session runs on the operator's own config",
      { configDir, error: errorMessage(err) },
    );
    return undefined;
  }
}

/** Test seam — every filesystem and logger touch in this module. */
export const _opencodeAcpEnvDeps: {
  /** `mkdirSync(path, { recursive: true })`. Nothing is ever written into the dir. */
  mkdir: (path: string) => void;
  /** The project logger, stage-tagged `opencode-acp`. */
  warn: (message: string, data: Record<string, unknown>) => void;
} = {
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  warn: (message, data) => {
    getSafeLogger()?.warn("opencode-acp", message, data);
  },
};

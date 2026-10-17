/**
 * Codex ACP env injection (codex-acp-read-only, US-002).
 *
 * codex has two launch-time knobs nax must set before the agent process
 * starts, and both are environment variables:
 *
 * - `INITIAL_AGENT_MODE` decides what codex's `full` profile means —
 *   `workspace-write` (codex runs inside its own OS sandbox and nax approves
 *   every escalation it asks for) or `agent-full-access` (no sandbox, no
 *   requests). `none` / `read` / `review` still switch themselves to
 *   `read-only` through `applyMode`, so injecting this never widens them.
 * - `CODEX_HOME` relocates codex's config directory, which is how a nax
 *   session stops inheriting the operator's own `~/.codex/config.toml`
 *   (hooks, MCP servers, plugins). The isolated home shares exactly one thing
 *   back — `auth.json`, linked, so a token refresh in either home is seen by
 *   both.
 *
 * The model def is the carrier: `toSessionModel` copies `ModelDef.env` onto
 * `SessionModel.env`, and `backendEnv` hands every key of it to the agent
 * process (`buildAllowedEnv` step 5, "Model-level env overrides"). So the
 * injection point is the model def, and this module is the one place that
 * builds it — `selectModel` (which `SessionManager.openSession` calls) and
 * `completeAsWithFallback` both go through `withCodexAcpEnv`.
 *
 * It lives under `agents/shared/` rather than `agents/acp/` on purpose: the ACP
 * adapter may not read config (`scripts/check-adapter-no-config-import.sh`),
 * and `codexAcpSettings` is a config reader.
 *
 * Fail-open (the "not too tight" ruling): a codex session that cannot get its
 * isolated home runs on the operator's own codex home rather than failing the
 * open. The mode is injected whatever happens to the home.
 */

import { lstatSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { DEFAULT_AGENT_CODEX_ACP_CONFIG, type NaxConfig } from "@/config";
import { globalConfigDir } from "@/config/paths";
import { getSafeLogger } from "@/logger";

/** The agent name this injection applies to (the registry key in nax-agent-acp). */
const CODEX_AGENT_NAME = "codex";
/** codex's startup mode/approval knob, read by the binary at launch. */
const INITIAL_AGENT_MODE_ENV = "INITIAL_AGENT_MODE";
/** codex's config-directory override. */
const CODEX_HOME_ENV = "CODEX_HOME";
/** codex's own config directory under the operator's home. */
const CODEX_HOME_DIR_NAME = ".codex";
/** The one file the isolated home borrows from the operator's home. */
const CODEX_AUTH_FILE_NAME = "auth.json";
/** Isolated-home location under `globalConfigDir()` (#1831-style path helper rules: never spelled inline). */
const ISOLATED_CODEX_HOME_DIR_NAME = "acp";
const ISOLATED_CODEX_HOME_LEAF = "codex-home";

/** What codex's `full` profile means (see the module header). */
export type CodexFullMode = "workspace-write" | "agent-full-access";

export interface CodexAcpSettings {
  readonly isolateHome: boolean;
  readonly fullMode: CodexFullMode;
}

/** Settings from config.agent.acp.codex; schema defaults when the config or any level is undefined. */
export function codexAcpSettings(config: Pick<NaxConfig, "agent"> | undefined): CodexAcpSettings {
  const codex = config?.agent?.acp?.codex;
  return {
    // The defaults come from the schema module's `DEFAULT_AGENT_CODEX_ACP_CONFIG`
    // rather than a literal here: a second literal is a second source of truth
    // that drifts the first time the schema default moves (see
    // `DEFAULT_AGENT_TIMEOUT_RETRY_CONFIG` for the same pattern).
    isolateHome: codex?.isolateHome ?? DEFAULT_AGENT_CODEX_ACP_CONFIG.isolateHome,
    fullMode: codex?.fullMode ?? DEFAULT_AGENT_CODEX_ACP_CONFIG.fullMode,
  };
}

/** `<globalConfigDir()>/acp/codex-home` */
export function isolatedCodexHomeDir(): string {
  return join(globalConfigDir(), ISOLATED_CODEX_HOME_DIR_NAME, ISOLATED_CODEX_HOME_LEAF);
}

/** The operator's own codex home: `CODEX_HOME` when non-empty, else `<homedir>/.codex`. */
function sourceCodexHome(): string {
  const fromEnv = _codexAcpEnvDeps.env(CODEX_HOME_ENV);
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(_codexAcpEnvDeps.homedir(), CODEX_HOME_DIR_NAME);
}

/**
 * mkdir the isolated home (recursive) and link `<isolated>/auth.json` to the
 * operator's `auth.json` — but only when the source file exists and the
 * isolated home has no `auth.json` entry yet (lstat semantics, so a dangling
 * link counts as an entry and is never replaced).
 *
 * Nothing else is created: the point is a home with **no** `config.toml`, so
 * the operator's hooks / MCP servers / plugins cannot reach a nax session.
 *
 * A link rather than a copy because codex's file credential store saves with
 * truncate-and-write on the existing path: both homes write through to the same
 * file, so a token refresh in either one is seen by the other.
 *
 * Throws on a filesystem failure — the caller decides whether that is fatal
 * (it is not: see `withCodexAcpEnv`).
 */
export function prepareIsolatedCodexHome(): string {
  const isolated = isolatedCodexHomeDir();
  _codexAcpEnvDeps.mkdir(isolated);
  const linkPath = join(isolated, CODEX_AUTH_FILE_NAME);
  if (_codexAcpEnvDeps.entryExists(linkPath)) return isolated;
  const sourceAuth = join(sourceCodexHome(), CODEX_AUTH_FILE_NAME);
  if (!_codexAcpEnvDeps.fileExists(sourceAuth)) return isolated;
  _codexAcpEnvDeps.symlink(sourceAuth, linkPath);
  return isolated;
}

/**
 * The env a codex model def enters its agent call with — a NEW def, never a
 * mutation of the input. For any other agent name (or none) the input is
 * returned itself, untouched.
 *
 * Each key is added only when the def's own env does not already set it: an
 * operator's `models.<agent>.<tier>.env` entry is a deliberate override and
 * nax does not second-guess it.
 *
 * When the isolated home cannot be prepared, one warn is logged and `CODEX_HOME`
 * is simply omitted — the session then runs on the operator's codex home, which
 * is the pre-change behaviour. `INITIAL_AGENT_MODE` is still injected.
 */
export function withCodexAcpEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: CodexAcpSettings,
): T {
  if (agentName !== CODEX_AGENT_NAME) return def;
  const env: Record<string, string> = { ...def.env };
  if (env[INITIAL_AGENT_MODE_ENV] === undefined) env[INITIAL_AGENT_MODE_ENV] = settings.fullMode;
  if (settings.isolateHome && env[CODEX_HOME_ENV] === undefined) {
    const home = isolatedCodexHomeOrUndefined();
    if (home !== undefined) env[CODEX_HOME_ENV] = home;
  }
  return { ...def, env };
}

/** `prepareIsolatedCodexHome()` with its one documented failure mode handled. */
function isolatedCodexHomeOrUndefined(): string | undefined {
  try {
    return prepareIsolatedCodexHome();
  } catch (err) {
    _codexAcpEnvDeps.warn(
      "Could not prepare the isolated codex home — this codex session runs on the operator's own codex home",
      { codexHome: isolatedCodexHomeDir(), error: errorMessage(err) },
    );
    return undefined;
  }
}

/** Test seam — every filesystem, environment and logger touch in this module. */
export const _codexAcpEnvDeps: {
  /** `mkdirSync(path, { recursive: true })`. */
  mkdir: (path: string) => void;
  /** `lstat`: true for files, directories and dangling links. */
  entryExists: (path: string) => boolean;
  /** `stat`: true only when the target exists and is a regular file. */
  fileExists: (path: string) => boolean;
  /** `symlinkSync(target, path)` — a hard link would work on one filesystem only. */
  symlink: (target: string, path: string) => void;
  /** `process.env[name]`. */
  env: (name: string) => string | undefined;
  /** `os.homedir()`. */
  homedir: () => string;
  /** The project logger, stage-tagged `codex-acp`. */
  warn: (message: string, data: Record<string, unknown>) => void;
} = {
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  entryExists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
  fileExists: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  symlink: (target, path) => {
    symlinkSync(target, path);
  },
  env: (name) => process.env[name],
  homedir: () => osHomedir(),
  warn: (message, data) => {
    getSafeLogger()?.warn("codex-acp", message, data);
  },
};

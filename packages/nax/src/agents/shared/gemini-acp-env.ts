/**
 * gemini ACP env injection (US-002, gemini-acp-read-only).
 *
 * gemini reads its whole user-scoped configuration from one home
 * (`GEMINI_CLI_HOME`, default `~`): `settings.json`, `policies/`
 * (`auto-saved.toml` — every "Always Allow" the operator ever granted),
 * installed extensions, MCP servers, skills and history. Its policy tiers are
 * ranked, and the user tier outranks the default tier nax's read-only session
 * relies on, so an operator's own approval can loosen a nax `read` session.
 *
 * `GEMINI_CLI_HOME` relocates that home. The isolated home this module prepares
 * shares back exactly what makes a session *authenticate* and nothing that
 * grants it *authority*:
 *
 * - `oauth_creds.json` and `gemini-credentials.json` are **symlinked** from the
 *   operator's home, so a Google login or API-key credential refresh in either
 *   home is seen by both. A link rather than a copy for the same reason as
 *   codex's `auth.json`: the agent rewrites the file in place on refresh.
 * - `settings.json` is **regenerated** every call and carries only
 *   `security.auth.selectedType` — the one field that tells gemini *which*
 *   stored credential to use (Google login vs API key). Everything else, most
 *   visibly `mcpServers`, is dropped.
 *
 * Nothing else is copied: no policies, extensions, skills or history, so the
 * isolated session starts from gemini's own defaults and cannot inherit a
 * looser approval.
 *
 * The model def is the carrier, as for codex and opencode
 * (`codex-acp-env.ts`): `toSessionModel` copies `ModelDef.env` onto
 * `SessionModel.env`, and `backendEnv` hands every key of it to the agent
 * process. The injection point is therefore the model def, and this module is
 * the one place that builds it — `selectModel` (which
 * `SessionManager.openSession` calls) and `completeAsWithFallback` both reach it
 * through `withAcpEnv` (`acp-env.ts`).
 *
 * It lives under `agents/shared/` rather than `agents/acp/` on purpose: the ACP
 * adapter may not read config (`scripts/check-adapter-no-config-import.sh`), and
 * `geminiAcpSettings` is a config reader.
 *
 * Fail-open (the "not too tight" ruling): a gemini session whose isolated home
 * cannot be prepared runs on the operator's own gemini home rather than failing
 * the open. Off by default, because an isolated home also hides whatever the
 * operator configured there.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { DEFAULT_AGENT_GEMINI_ACP_CONFIG, type NaxConfig } from "@/config";
import { globalConfigDir } from "@/config/paths";
import { getSafeLogger } from "@/logger";

/** The agent name this injection applies to (the registry key in nax-agent-acp). */
const GEMINI_AGENT_NAME = "gemini";
/** gemini's home override, read by the binary at launch. */
const GEMINI_CLI_HOME_ENV = "GEMINI_CLI_HOME";
/** gemini's own directory inside a home — `.gemini` under `GEMINI_CLI_HOME` (or the operator's home). */
const GEMINI_DIR_NAME = ".gemini";
/** The one file whose contents this module re-writes rather than links. */
const GEMINI_SETTINGS_FILE_NAME = "settings.json";
/** Isolated-home location under `globalConfigDir()` (never spelled inline — see paths/index.ts). */
const ISOLATED_GEMINI_HOME_DIR_NAME = "acp";
const ISOLATED_GEMINI_HOME_LEAF = "gemini-home";

/**
 * The credential files the isolated home borrows from the operator's home.
 * Both are links, never copies: gemini writes a refreshed credential back to
 * the path it read.
 */
const GEMINI_SHARED_FILES: readonly string[] = ["oauth_creds.json", "gemini-credentials.json"];

export interface GeminiAcpSettings {
  readonly isolateHome: boolean;
}

/** Settings from config.agent.acp.gemini; schema defaults when the config or any level is undefined. */
export function geminiAcpSettings(config: Pick<NaxConfig, "agent"> | undefined): GeminiAcpSettings {
  const gemini = config?.agent?.acp?.gemini;
  // The default comes from the schema module's constant rather than a literal
  // here: a second literal is a second source of truth that drifts the first
  // time the schema default moves (same as `codexAcpSettings`).
  return { isolateHome: gemini?.isolateHome ?? DEFAULT_AGENT_GEMINI_ACP_CONFIG.isolateHome };
}

/** `<globalConfigDir()>/acp/gemini-home` — the value `GEMINI_CLI_HOME` is set to (gemini reads `<home>/.gemini`). */
export function isolatedGeminiHomeDir(): string {
  return join(globalConfigDir(), ISOLATED_GEMINI_HOME_DIR_NAME, ISOLATED_GEMINI_HOME_LEAF);
}

/** The operator's own gemini home: `GEMINI_CLI_HOME` when non-empty, else `<homedir>`. */
function sourceGeminiHomeDir(): string {
  const fromEnv = _geminiAcpEnvDeps.env(GEMINI_CLI_HOME_ENV);
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return _geminiAcpEnvDeps.homedir();
}

/** The operator's `.gemini` directory — where both the credentials and the settings are read from. */
function sourceGeminiDir(): string {
  return join(sourceGeminiHomeDir(), GEMINI_DIR_NAME);
}

/**
 * mkdir the isolated home's `.gemini` (recursive), link both credential files
 * into it and write the auth type, then return the isolated home.
 *
 * Each link is made only when the operator's file exists and the isolated home
 * has no entry of that name yet — lstat semantics, so a dangling link counts as
 * an entry and is never replaced. `settings.json` is the exception and is
 * rewritten on every call: it is generated content, not a borrowed file.
 *
 * Every nax process on the machine shares this home, so a link a sibling
 * process created between our check and our own `symlink` is accepted rather
 * than failing preparation (`linkOrAcceptConcurrentLink`).
 *
 * Nothing else is created. The point is a home with **no** `policies/`, no
 * extensions and no `mcpServers`, so no operator approval can reach a nax
 * session.
 *
 * Throws on a filesystem failure — the caller decides whether that is fatal
 * (it is not: see `withGeminiAcpEnv`).
 */
export function prepareIsolatedGeminiHome(): string {
  const isolated = isolatedGeminiHomeDir();
  const geminiDir = join(isolated, GEMINI_DIR_NAME);
  _geminiAcpEnvDeps.mkdir(geminiDir);
  linkSharedCredentialFiles(geminiDir);
  writeIsolatedSettings(geminiDir);
  return isolated;
}

function linkSharedCredentialFiles(geminiDir: string): void {
  const sourceDir = sourceGeminiDir();
  for (const fileName of GEMINI_SHARED_FILES) {
    const linkPath = join(geminiDir, fileName);
    if (_geminiAcpEnvDeps.entryExists(linkPath)) continue;
    const sourcePath = join(sourceDir, fileName);
    if (!_geminiAcpEnvDeps.fileExists(sourcePath)) continue;
    linkOrAcceptConcurrentLink(sourcePath, linkPath);
  }
}

/**
 * Link one credential file, tolerating the concurrent nax process that got
 * there first.
 *
 * The isolated home is shared by every nax process on the machine, and
 * create-if-absent is two syscalls: two processes can both see the entry absent
 * above and then both `symlink`, and the loser gets `EEXIST`. The loser's link
 * is exactly the one the winner made — confirmed by the `entryExists` check,
 * which also keeps a *non*-race `EEXIST` (a directory in the way, say) from
 * being swallowed — so preparation continues. Every other failure (EACCES,
 * ENOSPC, a source that vanished mid-flight) is a real one and still reaches
 * `withGeminiAcpEnv`'s fail-open.
 */
function linkOrAcceptConcurrentLink(sourcePath: string, linkPath: string): void {
  try {
    _geminiAcpEnvDeps.symlink(sourcePath, linkPath);
  } catch (err) {
    if (!isAlreadyExists(err) || !_geminiAcpEnvDeps.entryExists(linkPath)) throw err;
  }
}

/** `EEXIST` — the entry was created between our `lstat` and our `symlink`. */
function isAlreadyExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
}

/**
 * Write `<isolated>/.gemini/settings.json` carrying only the operator's
 * `security.auth.selectedType`.
 *
 * Absent, non-JSON, or carrying no non-empty string at that path: nothing is
 * written, and gemini falls back to its own auth default (`GEMINI_API_KEY`)
 * inside the isolated home. Only a *parse* failure warns — an auth type that is
 * simply not there is the ordinary state of a fresh install, not a fault.
 */
function writeIsolatedSettings(geminiDir: string): void {
  const sourcePath = join(sourceGeminiDir(), GEMINI_SETTINGS_FILE_NAME);
  const text = _geminiAcpEnvDeps.readText(sourcePath);
  if (text === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    _geminiAcpEnvDeps.warn(
      "Could not parse the operator's gemini settings.json — the isolated home carries no auth type and gemini uses its own default",
      { path: sourcePath, error: errorMessage(err) },
    );
    return;
  }
  const selectedType = selectedAuthType(parsed);
  if (selectedType === undefined) return;
  _geminiAcpEnvDeps.writeText(
    join(geminiDir, GEMINI_SETTINGS_FILE_NAME),
    JSON.stringify({ security: { auth: { selectedType } } }),
  );
}

/** `security.auth.selectedType` when it is a non-empty string, otherwise undefined. */
function selectedAuthType(parsed: unknown): string | undefined {
  const security = recordField(parsed, "security");
  const auth = recordField(security, "auth");
  const selectedType = recordField(auth, "selectedType");
  return typeof selectedType === "string" && selectedType !== "" ? selectedType : undefined;
}

/** `value[key]` for a plain JSON object, undefined for anything else (arrays and null included). */
function recordField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * The env a gemini model def enters its agent call with — a NEW def when the
 * isolated home was prepared, the input itself in every other case (another
 * agent name, `isolateHome` off, a `GEMINI_CLI_HOME` the model env already
 * pins, or a home that could not be prepared).
 *
 * A key set even to an empty string counts as pinned: the operator's choice
 * stands and nax prepares nothing.
 *
 * When the isolated home cannot be prepared, one warn is logged and
 * `GEMINI_CLI_HOME` is simply omitted — the session then runs on the operator's
 * gemini home, which is the pre-change behaviour.
 */
export function withGeminiAcpEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: GeminiAcpSettings,
): T {
  if (agentName !== GEMINI_AGENT_NAME || !settings.isolateHome) return def;
  if (def.env?.[GEMINI_CLI_HOME_ENV] !== undefined) return def;
  const home = isolatedGeminiHomeOrUndefined();
  if (home === undefined) return def;
  return { ...def, env: { ...def.env, [GEMINI_CLI_HOME_ENV]: home } };
}

/** `prepareIsolatedGeminiHome()` with its one documented failure mode handled. */
function isolatedGeminiHomeOrUndefined(): string | undefined {
  try {
    return prepareIsolatedGeminiHome();
  } catch (err) {
    _geminiAcpEnvDeps.warn(
      "Could not prepare the isolated gemini home — this gemini session runs on the operator's own gemini home",
      { geminiHome: isolatedGeminiHomeDir(), error: errorMessage(err) },
    );
    return undefined;
  }
}

/** Test seam — every filesystem, environment and logger touch in this module. */
export const _geminiAcpEnvDeps: {
  /** `mkdirSync(path, { recursive: true })`. */
  mkdir: (path: string) => void;
  /** `lstat`: true for files, directories and dangling links. */
  entryExists: (path: string) => boolean;
  /** `stat`: true only when the target exists and is a regular file. */
  fileExists: (path: string) => boolean;
  /** `symlinkSync(target, path)` — a copy would go stale on the next credential refresh. */
  symlink: (target: string, path: string) => void;
  /**
   * The file's text, or undefined when it is absent. Synchronous because the
   * whole preparation runs inside `selectModel`, which is synchronous — so
   * `readFileSync`/`writeFileSync` rather than the async `Bun.file`/`Bun.write`
   * the project prefers elsewhere (same reason `cli/init-detect.ts` gives).
   */
  readText: (path: string) => string | undefined;
  /** `writeFileSync(path, text)` — the isolated settings file, regenerated each call. */
  writeText: (path: string, text: string) => void;
  /** `process.env[name]`. */
  env: (name: string) => string | undefined;
  /** `os.homedir()`. */
  homedir: () => string;
  /** The project logger, stage-tagged `gemini-acp`. */
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
  readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  writeText: (path, text) => {
    writeFileSync(path, text);
  },
  env: (name) => process.env[name],
  homedir: () => osHomedir(),
  warn: (message, data) => {
    getSafeLogger()?.warn("gemini-acp", message, data);
  },
};

/**
 * Shared environment variable allowlist for agent subprocess spawning.
 *
 * Two canonical implementations live here:
 * - `buildAllowedEnv` — the broad allowlist, for the ClaudeCodeAdapter
 *   (src/agents/claude/execution.ts), hooks and command-argv.
 * - `buildAcpRunEnv` — the per-provider run env of an ACP run session
 *   (src/agents/acp/open-context.ts, backendEnv), built from
 *   `acpProviderEnvFamily`: only the agent's own provider's variables, never
 *   nax's `NAX_`/`CLAW_`/`TURBO_` variables (M7).
 *
 * When adding new env var prefixes or API key vars, update ONLY this file.
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { getSafeLogger } from "@/logger";

/** Essential OS vars passed through to every agent subprocess. */
const ESSENTIAL_VARS = ["PATH", "TMPDIR", "NODE_ENV", "USER", "LOGNAME"];

/**
 * Explicit API key vars passed through regardless of prefix matching.
 * Union of all adapters' needs — harmless to pass extras.
 */
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_API_KEY"];

/**
 * Env var prefixes passed through in bulk.
 * Union of CLI and ACP adapter needs.
 */
const ALLOWED_PREFIXES = [
  "CLAUDE_",
  "NAX_",
  "CLAW_",
  "TURBO_",
  "CODEX_",
  "GEMINI_",
  "ANTHROPIC_",
  "OPENCODE_",
  "MINIMAX_",
];

export interface BuildAllowedEnvOptions {
  /** Extra vars merged in last (highest priority). */
  env?: Record<string, string | undefined>;
  /** Model-level env overrides merged before `env`. */
  modelEnv?: Record<string, string | undefined>;
}

/** The provider variables one ACP agent may see: exact names, plus name prefixes. */
export interface AcpProviderEnvFamily {
  readonly keys: readonly string[];
  readonly prefixes: readonly string[];
}

/** opencode, pi and custom agents are multi-provider, so they keep every provider key. */
const MULTI_PROVIDER_PREFIXES: readonly string[] = [
  "CLAUDE_",
  "ANTHROPIC_",
  "CODEX_",
  "GEMINI_",
  "OPENCODE_",
  "MINIMAX_",
  "CURSOR_",
];

const MULTI_PROVIDER_FAMILY: AcpProviderEnvFamily = Object.freeze({
  keys: API_KEY_VARS,
  prefixes: MULTI_PROVIDER_PREFIXES,
});

const PROVIDER_ENV_FAMILIES: ReadonlyMap<string, AcpProviderEnvFamily> = new Map<string, AcpProviderEnvFamily>([
  ["claude", { keys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"], prefixes: ["CLAUDE_", "ANTHROPIC_"] }],
  ["codex", { keys: ["OPENAI_API_KEY"], prefixes: ["CODEX_"] }],
  ["gemini", { keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], prefixes: ["GEMINI_"] }],
  ["cursor", { keys: [], prefixes: ["CURSOR_"] }],
]);

/**
 * The provider variables an ACP agent may see (M7). A single-provider agent gets
 * only its own provider's key and prefixes, so a codex session is never handed
 * `ANTHROPIC_API_KEY`, and no agent sees `NAX_`, `CLAW_` or `TURBO_` variables:
 * those carry nax's own secrets (the Telegram token among them). A multi-provider
 * agent (opencode, pi, a custom name) keeps every provider key.
 */
export function acpProviderEnvFamily(agent: string): AcpProviderEnvFamily {
  return PROVIDER_ENV_FAMILIES.get(agent) ?? MULTI_PROVIDER_FAMILY;
}

/** HOME, sanitised: it must be absolute, because an unexpanded "~" yields a literal ~/dir cwd. */
function sanitizedHome(): string {
  const rawHome = process.env.HOME ?? "";
  const safeHome = rawHome && isAbsolute(rawHome) ? rawHome : homedir();
  if (rawHome !== safeHome) {
    getSafeLogger()?.warn("env", `HOME env is not absolute ("${rawHome}"), falling back to os.homedir(): ${safeHome}`);
  }
  return safeHome;
}

/**
 * The environment an ACP run session launches with (M7): the essential OS vars,
 * the sanitised HOME, the agent's own provider variables, then the model's env.
 * Nothing else — nax's own `NAX_`/`CLAW_`/`TURBO_` variables reach the agent only
 * when the model's env names them.
 */
export function buildAcpRunEnv(agent: string, modelEnv?: Readonly<Record<string, string>>): Record<string, string> {
  const family = acpProviderEnvFamily(agent);
  const env: Record<string, string> = {};
  for (const varName of ESSENTIAL_VARS) {
    const value = process.env[varName];
    if (value) env[varName] = value;
  }
  env.HOME = sanitizedHome();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (family.keys.includes(key) || family.prefixes.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  if (modelEnv !== undefined) Object.assign(env, modelEnv);
  return env;
}

/**
 * Build the allowed environment for an agent subprocess.
 *
 * Allowlist strategy:
 * 1. Essential OS vars (PATH, TMPDIR, HOME, etc.)
 * 2. Explicit API key vars
 * 3. Prefix-matched vars (CLAUDE_*, NAX_*, ANTHROPIC_*, etc.)
 * 4. Model-level env overrides (modelEnv)
 * 5. Call-site extra env (env) — highest priority
 */
export function buildAllowedEnv(options?: BuildAllowedEnvOptions): Record<string, string | undefined> {
  const allowed: Record<string, string | undefined> = {};

  // 1. Essential OS vars
  for (const varName of ESSENTIAL_VARS) {
    if (process.env[varName]) allowed[varName] = process.env[varName];
  }

  // 2. Sanitize HOME — must be absolute. Unexpanded "~" causes literal ~/dir in cwd.
  allowed.HOME = sanitizedHome();

  // 3. Explicit API key vars
  for (const varName of API_KEY_VARS) {
    if (process.env[varName]) allowed[varName] = process.env[varName];
  }

  // 4. Prefix-matched vars
  for (const [key, value] of Object.entries(process.env)) {
    if (ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      allowed[key] = value;
    }
  }

  // 5. Model-level env overrides
  if (options?.modelEnv) Object.assign(allowed, options.modelEnv);

  // 6. Call-site extra env (highest priority)
  if (options?.env) Object.assign(allowed, options.env);

  return allowed;
}

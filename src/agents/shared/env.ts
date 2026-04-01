/**
 * Shared environment variable allowlist for agent subprocess spawning.
 *
 * Single canonical implementation used by both:
 * - ClaudeCodeAdapter (src/agents/claude/execution.ts)
 * - SpawnAcpClient (src/agents/acp/spawn-client.ts)
 *
 * When adding new env var prefixes or API key vars, update ONLY this file.
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { getSafeLogger } from "../../logger";

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
  "ACPX_",
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
  const rawHome = process.env.HOME ?? "";
  const safeHome = rawHome && isAbsolute(rawHome) ? rawHome : homedir();
  if (rawHome !== safeHome) {
    getSafeLogger()?.warn("env", `HOME env is not absolute ("${rawHome}"), falling back to os.homedir(): ${safeHome}`);
  }
  allowed.HOME = safeHome;

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

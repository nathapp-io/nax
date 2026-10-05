/**
 * The agent's environment (S4 spec §6.2). By default an allowlist: the base
 * keys, LC_*, the registry entry's auth variables, then `env`. `inheritEnv`
 * passes the whole source instead (documented as handing the embedder's
 * credentials to the agent). The redaction set is every secret-named value in
 * the result (D-g).
 */
const BASE_KEYS: readonly string[] = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"];
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD/i;

export interface AgentEnvInput {
  readonly source: Readonly<Record<string, string | undefined>>;
  readonly inheritEnv: boolean;
  readonly authEnv: readonly string[];
  readonly extra: Readonly<Record<string, string>>;
}

function allowed(key: string, authEnv: readonly string[]): boolean {
  return BASE_KEYS.includes(key) || key.startsWith("LC_") || authEnv.includes(key);
}

export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
  const picked = Object.entries(input.source).flatMap(([key, value]): [string, string][] =>
    value !== undefined && (input.inheritEnv || allowed(key, input.authEnv)) ? [[key, value]] : [],
  );
  return { ...Object.fromEntries(picked), ...input.extra };
}

export function secretValues(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_KEY.test(key) && value.length > 0)
    .map(([, value]) => value);
}

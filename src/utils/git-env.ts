/**
 * Config overrides every nax-spawned git carries (#2198, defence in depth).
 *
 * `core.fsmonitor` names a program git runs on every status/diff/add; were an
 * agent ever to get a value into a config nax's git reads (a redirected
 * commondir, a nested repo git recurses into), nax would run it unsandboxed.
 * nax never needs an fsmonitor, so it is always off.
 *
 * Passed through GIT_CONFIG_COUNT/KEY/VALUE (git >= 2.31; older git ignores
 * them) rather than `-c` so argv stays unchanged, and because git forwards
 * these to the child git processes it spawns (submodules) as well.
 */

const HARDENED_GIT_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [["core.fsmonitor", "false"]];

const NON_NEGATIVE_INT = /^\d+$/;

/**
 * `base` plus the hardened entries, appended after any GIT_CONFIG_COUNT
 * entries the caller's environment already carries. A malformed existing
 * count is left alone: git rejects it either way, and rewriting it would
 * change which of the caller's entries apply.
 */
export function hardenedGitEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const existing = base.GIT_CONFIG_COUNT;
  if (existing !== undefined && existing !== "" && !NON_NEGATIVE_INT.test(existing)) return { ...base };
  const start = existing === undefined || existing === "" ? 0 : Number.parseInt(existing, 10);
  const env: Record<string, string | undefined> = { ...base };
  HARDENED_GIT_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(start + HARDENED_GIT_CONFIG.length);
  return env;
}

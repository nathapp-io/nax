/**
 * Config overrides every nax-spawned git carries (#2198, defence in depth).
 *
 * `core.fsmonitor` names a program git runs on every status/diff/add; were an
 * agent ever to get a value into a config nax's git reads (a redirected
 * commondir, a nested repo git recurses into), nax would run it unsandboxed.
 * nax never needs an fsmonitor, so it is always off.
 *
 * Submodules (#2210): for every gitlink, `git status` / `diff` / `commit`
 * run `git status` inside the nested repo to learn whether it is dirty, and
 * that child git reads the nested repo's own config and `.gitattributes` --
 * files an agent can write when it creates the repo inside its write root.
 * A filter driver (`filter.<x>.clean`) named there would run unsandboxed, and
 * unlike fsmonitor it cannot be switched off by name. `diff.ignoreSubmodules
 * =dirty` skips that dirty check (a moved gitlink HEAD is still reported,
 * without spawning git in it), and `submodule.recurse=false` keeps checkout /
 * merge from recursing. `git add` ignores diff.ignoreSubmodules, so nax stages
 * through `gitlinkSafeAdd` (`./git-add`) instead of a bare `git add`.
 *
 * Passed through GIT_CONFIG_COUNT/KEY/VALUE (git >= 2.31; older git ignores
 * them) rather than `-c` so argv stays unchanged, and because git forwards
 * these to the child git processes it spawns (submodules) as well.
 *
 * Coverage: `gitWithTimeout` applies it, and every other site in `src/` that
 * spawns git itself passes `env: gitSpawnEnv(...)`. The generic forge and
 * auto-pr runners harden every command they spawn, since `gh` / `glab` run git
 * underneath. `scripts/check-git-spawn-env.ts` (in `lint:checks`) fails on a
 * `["git", ...]` argv literal that is neither inside a spawn call carrying one
 * of these helpers nor marked `// nax-git-env-allow: <reason>` (argv handed to
 * a runner that hardens it itself). An argv held in a variable and spawned
 * elsewhere is beyond a textual gate; keep git argv literal at the spawn.
 */

const HARDENED_GIT_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.fsmonitor", "false"],
  ["diff.ignoreSubmodules", "dirty"],
  ["submodule.recurse", "false"],
];

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

/**
 * The environment for a git nax spawns directly: `process.env`, then the
 * caller's `overlay` (e.g. GIT_INDEX_FILE), then the hardened entries. Pass
 * the overlay here rather than spreading the result, so a GIT_CONFIG_COUNT
 * the overlay sets is appended to instead of overwritten.
 */
export function gitSpawnEnv(
  overlay?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return hardenedGitEnv(overlay === undefined ? process.env : { ...process.env, ...overlay });
}

import { injectedForgeIdentity } from "@/forge";
import { gitWithTimeout } from "@/utils/git";

/** Bot git never runs hooks: a PR head can supply them through a relative core.hooksPath. */
export const BOT_GIT_HOOKS_OFF = ["-c", "core.hooksPath=/dev/null"] as const;

/**
 * The credential helper `botGit` installs for an authenticated fetch/push, in
 * git's shell-function form (`!f() { ...; }; f`).
 *
 * Git strips the leading `!`, appends the action (`get` / `store` / `erase`) and
 * runs the rest with `sh -c`, leaving `$1` as the action and the request lines —
 * `protocol=`, `host=` — on stdin. The token is read from the spawned process's
 * environment (`NAX_FORGE_GIT_TOKEN`), never from this string, so it cannot reach
 * `.git/config` or the argv a `ps` shows.
 *
 * `x-access-token` is GitHub's App HTTPS username; GitLab accepts any non-empty
 * username with a token. Only `get` over HTTPS answers — anything else prints
 * nothing and exits 0, so a `store` never writes the token to a credential store
 * and a non-HTTPS URL gets no credential at all.
 */
export const NAX_BOT_CREDENTIAL_HELPER =
  '!f() { [ "$1" = get ] || return 0; proto=; while IFS= read -r line; do case $line in protocol=https) proto=1 ;; esac; done; [ -n "$proto" ] || return 0; printf \'%s\\n\' "username=x-access-token" "password=$NAX_FORGE_GIT_TOKEN"; }; f';

/** Git verbs that reach the network. Everything else keeps the plain argv. */
const BOT_GIT_NETWORK_VERBS: ReadonlySet<string> = new Set(["fetch", "push"]);

/** Read by `NAX_BOT_CREDENTIAL_HELPER` from the spawned git's environment. */
const BOT_GIT_TOKEN_ENV = "NAX_FORGE_GIT_TOKEN";

/**
 * Turning the terminal prompt off makes a rejected credential fail at once
 * instead of blocking on a terminal that is not there — the caller's existing
 * error path then reports git's own message.
 */
const NO_TERMINAL_PROMPT = { GIT_TERMINAL_PROMPT: "0" } as const;

/**
 * The credential prefix for one authenticated fetch/push: an empty helper entry
 * first, so every helper the repository or the user configured — including one
 * in `.git/config` that would answer with the wrong credential — is cleared,
 * then ours.
 */
const BOT_GIT_CREDENTIAL_ARGV = ["-c", "credential.helper=", "-c", `credential.helper=${NAX_BOT_CREDENTIAL_HELPER}`];

export function botGit(
  args: string[],
  workdir: string,
  timeoutMs?: number,
  maxBytes?: number,
): ReturnType<typeof gitWithTimeout> {
  const identity = injectedForgeIdentity();
  // The token reaches git only for a network verb of a captured identity. It goes
  // through the environment, never argv: argv is visible in `ps` and in git's own
  // error output, and a `-c` value would persist in `.git/config`.
  const authenticated = identity !== undefined && BOT_GIT_NETWORK_VERBS.has(args[0] ?? "");
  const prefix = authenticated ? [...BOT_GIT_HOOKS_OFF, ...BOT_GIT_CREDENTIAL_ARGV] : [...BOT_GIT_HOOKS_OFF];
  const envOverlay = authenticated ? { ...NO_TERMINAL_PROMPT, [BOT_GIT_TOKEN_ENV]: identity.token } : undefined;
  // nax-git-env-allow: handed to gitWithTimeout, which hardens it
  return gitWithTimeout(args, workdir, timeoutMs, maxBytes, ["git", ...prefix, ...args], envOverlay);
}

import type { InjectedForgeIdentity } from "@/forge";
import { injectedForgeIdentity } from "@/forge";
import { gitWithTimeout, NO_TERMINAL_PROMPT } from "@/utils/git";

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
 * The credential prefix for one authenticated fetch/push: an empty helper entry
 * first, so every helper the repository or the user configured — including one
 * in `.git/config` that would answer with the wrong credential — is cleared,
 * then ours.
 */
const BOT_GIT_CREDENTIAL_ARGV = ["-c", "credential.helper=", "-c", `credential.helper=${NAX_BOT_CREDENTIAL_HELPER}`];

/**
 * The environment overlay for one git spawn. Nothing is added when there is no
 * captured identity or the verb never reaches the network. A captured identity
 * always turns the terminal prompt off; only one that carries a token also gets
 * `NAX_FORGE_GIT_TOKEN` for `NAX_BOT_CREDENTIAL_HELPER` to read — a login-only
 * identity leaves the credential to the host's own helper.
 */
function envOverlayFor(
  identity: InjectedForgeIdentity | undefined,
  networkVerb: boolean,
): Record<string, string> | undefined {
  if (identity === undefined || !networkVerb) return undefined;
  return identity.token === undefined
    ? { ...NO_TERMINAL_PROMPT }
    : { ...NO_TERMINAL_PROMPT, [BOT_GIT_TOKEN_ENV]: identity.token };
}

export function botGit(
  args: string[],
  workdir: string,
  timeoutMs?: number,
  maxBytes?: number,
): ReturnType<typeof gitWithTimeout> {
  const identity = injectedForgeIdentity();
  const networkVerb = BOT_GIT_NETWORK_VERBS.has(args[0] ?? "");
  // The token reaches git only for a network verb of a captured identity that has
  // one. It goes through the environment, never argv: argv is visible in `ps` and
  // in git's own error output, and a `-c` value would persist in `.git/config`.
  // A login-only identity installs no helper at all, so git falls back to the
  // host's ambient credential helper.
  const authenticated = identity?.token !== undefined && networkVerb;
  const prefix = authenticated ? [...BOT_GIT_HOOKS_OFF, ...BOT_GIT_CREDENTIAL_ARGV] : [...BOT_GIT_HOOKS_OFF];
  const envOverlay = envOverlayFor(identity, networkVerb);
  // nax-git-env-allow: handed to gitWithTimeout, which hardens it
  return gitWithTimeout(args, workdir, timeoutMs, maxBytes, ["git", ...prefix, ...args], envOverlay);
}

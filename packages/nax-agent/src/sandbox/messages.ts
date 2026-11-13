/**
 * Every sentence the agent reads about the sandbox (spec 5.5), in one place so
 * descriptions, refusals and result notes cannot drift apart. The agent must
 * always know whether it is sandboxed and what it may write (spec S5).
 */

/**
 * srt's proxy refusals: the HTTP proxy answers `CONNECT tunnel failed, response
 * 403` and the socat bridge prints `E CONNECT <host>:<port>: Forbidden`.
 */
export const LIKELY_NETWORK_DENIAL = /CONNECT tunnel failed, response 403|E CONNECT \S+: Forbidden/i;

/**
 * Case-insensitive: docker prints `socket: operation not permitted` in lower
 * case (an AF_UNIX connect the sandbox refuses), coreutils in title case.
 */
export const LIKELY_SANDBOX_DENIAL = new RegExp(
  `operation not permitted|read-only file system|${LIKELY_NETWORK_DENIAL.source}`,
  "i",
);

function describeNetwork(network: "open" | readonly string[]): string {
  if (network === "open") return "network access is unrestricted";
  if (network.length === 0) return "network access is disabled";
  return `network access is limited to ${network.join(", ")}`;
}

/**
 * US-003: the writable temp root the sentence advertises. A confined session
 * (`sharedTmp: false`) can only write under the run's own temp directory, so
 * promising "the system temp directories" would send the agent at a denied
 * write; a shared-temp session keeps the wording it had before.
 *
 * US-005: naming $TMPDIR alone is not enough — /tmp is the path an agent
 * reaches for first, and under a confined sandbox it is denied. The confined
 * phrase therefore names it as the root that does NOT work, extending the
 * pre-change phrase rather than replacing it.
 */
const tempRootsPhrase = (sharedTmp: boolean): string =>
  sharedTmp
    ? "the system temp directories"
    : "this run's temp directory ($TMPDIR) rather than /tmp, which is not writable";

/**
 * US-006: on macOS srt refuses every setuid program, `/bin/ps` among them, and
 * kills a non-setuid copy with SIGKILL. A test that shells out to ps therefore
 * fails for a reason that has nothing to do with the test, and an agent reading
 * only "Operation not permitted" has no way to tell the two apart. Appended on
 * darwin alone: on Linux ps runs, where the sentence would excuse a real
 * failure. It is deliberately in `sandboxSentence` rather than at each call
 * site so every description that advertises a WORKING sandbox carries it.
 */
const DARWIN_SETUID_REFUSAL_SENTENCE =
  'On macOS the sandbox also refuses ps and other setuid programs ("Operation not permitted"), so a test that ' +
  "shells out to ps fails here for that reason alone.";

export function sandboxSentence(
  network: "open" | readonly string[],
  sharedTmp = true,
  platform?: NodeJS.Platform,
): string {
  const sentence =
    `inside an OS sandbox: writes are allowed only under the repository root, ${tempRootsPhrase(sharedTmp)} and ` +
    "package-manager caches -- and nothing under .nax/ except .nax/scratchpad/, since .nax/ is nax's own state " +
    "(change a feature's acceptance test with the Edit tool); credential files (~/.ssh, ~/.aws, ~/.npmrc, nax credentials and similar) are unreadable; " +
    `${describeNetwork(network)}. A write anywhere else fails with "Operation not permitted" or "Read-only file system" ` +
    "-- that is the sandbox, not a bug in your command.";
  return platform === "darwin" ? `${sentence} ${DARWIN_SETUID_REFUSAL_SENTENCE}` : sentence;
}

export function unsandboxedSentence(reason: string): string {
  return `Commands are NOT sandboxed on this machine (${reason}).`;
}

export function rawBashRefusalReason(reason: string): string {
  return (
    `sandbox unavailable (${reason}): raw bash requires the sandbox when execution.sandbox.enabled is true -- ` +
    "set this stage's bashApproval to gated or escalate, or disable the sandbox."
  );
}

/**
 * US-003: the denial path is exactly where an agent discovers the sandbox
 * refuses a `/tmp` write, so the hint names the two roots that do work -- the
 * session temp dir and the scratchpad -- rather than only listing the policy's
 * write roots. A shared-temp session (`allowSharedTmp: true`) can write `/tmp`,
 * so its hint omits the "not /tmp" clause that would contradict its policy.
 */
export function denialHintLine(writeRoots: readonly string[], sharedTmp = false): string {
  const tempClause = sharedTmp ? "" : " For temporary files use $TMPDIR or .nax/scratchpad/, not /tmp.";
  return (
    `note: this command ran in the nax sandbox; that failure may be a sandbox denial -- writable roots: ${writeRoots.join(", ")}.` +
    tempClause
  );
}

/** Network refusals name the network policy, not the writable roots. */
export function networkDenialHintLine(network: "open" | readonly string[]): string {
  return `note: this command ran in the nax sandbox; that failure may be a sandbox network denial -- ${describeNetwork(network)}.`;
}

/** US-2890: states where a FAILED wrapped command ran, so the model never has to guess. */
export const SANDBOX_STATUS_LINE = "[nax] this command ran INSIDE the sandbox (unsandboxed was not requested).";

const NEXT_STEP_OFFERED =
  "[nax] If this needs the network, a local socket or a device, re-run with `unsandboxed: true` and an " +
  "`unsandboxedReason`; the user will be asked to approve.";

const NEXT_STEP_NOT_OFFERED =
  "[nax] This session cannot run commands outside the sandbox. Ask the user to run it, or to enable " +
  "`allowUnsandboxedCommands`.";

/** The next step that matches what this session really offers. */
export function unsandboxedNextStepLine(unsandboxedOffered: boolean): string {
  return unsandboxedOffered ? NEXT_STEP_OFFERED : NEXT_STEP_NOT_OFFERED;
}

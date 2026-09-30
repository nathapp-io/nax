/**
 * The CLI trust gate (US-003): the one helper every gated command calls before
 * repository-controlled code may run.
 *
 * `runTrustGate` resolves the project root for the requested workdir (the
 * nearest ancestor with a `.nax/config.json`, realpath-normalized -- see
 * `src/trust/match.ts`), asks the entry gate (`src/trust`) for a decision --
 * prompting only when the invocation is attached to a terminal -- and turns
 * the two expected refusals into the CLI's house exit: messages on stderr and
 * exit code 2. Anything else propagates to the command's own error handling.
 *
 * The gate writes nothing to stdout, so a refused command's stdout stays
 * parseable by whatever piped it (fleet orchestrators run these unattended).
 */

import { NaxError } from "@/errors";
import { ensureProjectTrusted, normalizeTrustPath, resolveTrustRoot } from "@/trust";

/**
 * Injectable seams: what "interactive" means for this invocation and how the
 * refusal reaches the operator. Tests replace these; the defaults are the
 * process TTYs and plain stderr.
 */
export const _trustGateCliDeps: {
  isInteractive: () => boolean;
  error: (text: string) => void;
  exit: (code: number) => never;
} = {
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  error: (text: string) => {
    console.error(text);
  },
  exit: (code: number) => process.exit(code),
};

/**
 * Refuse to run repository-controlled code from `workdir` unless the project
 * root it belongs to is trusted, exiting 2 with the grant command when it is
 * not.
 *
 * - `PROJECT_UNTRUSTED`: names the root, then the command that would grant
 *   trust, then exits 2.
 * - `TRUST_STORE_UNREADABLE`: the store cannot be parsed -- report the
 *   underlying message and exit 2 rather than running against a store this
 *   build cannot read.
 * - anything else: propagate; the caller's error handling owns it.
 */
export async function runTrustGate(workdir: string): Promise<void> {
  const root = await normalizeTrustPath(resolveTrustRoot(workdir));
  try {
    await ensureProjectTrusted(root, { interactive: _trustGateCliDeps.isInteractive() });
  } catch (err) {
    if (err instanceof NaxError && err.code === "PROJECT_UNTRUSTED") {
      const contextHint = err.context?.hint;
      _trustGateCliDeps.error(`Project not trusted: ${root}`);
      _trustGateCliDeps.error(typeof contextHint === "string" ? contextHint : `run: nax trust add ${root}`);
      _trustGateCliDeps.exit(2);
    }
    if (err instanceof NaxError && err.code === "TRUST_STORE_UNREADABLE") {
      _trustGateCliDeps.error(err.message);
      _trustGateCliDeps.exit(2);
    }
    throw err;
  }
}

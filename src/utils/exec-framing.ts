/**
 * Frame a finished spawn result the way the model expects to see it: an
 * aborted call opens with the cancellation line, an orphansKilled call appends
 * the `[nax]` footer, a timed-out call reports the deadline, and everything
 * else gets `exit N\nstdout\nstderr` (US-001 AC14/AC15).
 *
 * One function shared by the `Bash` tool and `RunCommand` (Exec) so the two
 * ladders a model reads interchangeably cannot drift — the deadline label is
 * the only difference between the call sites, so it is a parameter.
 */
export function formatExecBody(
  launched: {
    aborted?: boolean;
    orphansKilled?: boolean;
    timedOut: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  },
  timeoutMs: number,
): string {
  if (launched.aborted === true) {
    return `Cancelled: the turn ended while this command was running.\nexit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}`;
  }
  if (launched.orphansKilled === true) {
    return `exit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}\n[nax] background processes still holding the output were killed`;
  }
  if (launched.timedOut) {
    return `timed out after ${timeoutMs}ms`;
  }
  return `exit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}`;
}

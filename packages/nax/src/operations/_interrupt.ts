/** A turn ended by a soft interrupt (finish A, A5 step limits): the session is still warm. */
import { SessionFailureError } from "@/agents";

export function isInterruptedStale(err: unknown): boolean {
  return (
    err instanceof SessionFailureError &&
    err.adapterFailure.outcome === "fail-stale" &&
    err.adapterFailure.reason === "interrupted"
  );
}

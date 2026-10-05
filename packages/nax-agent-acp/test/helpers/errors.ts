/** Narrowing helpers for thrown values, so tests assert codes without casts. */
import { AgentSessionError, NaxError } from "@nathapp/nax-agent";

export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

export function sessionError(error: unknown): AgentSessionError {
  if (error instanceof AgentSessionError) return error;
  throw new Error(`expected an AgentSessionError, got ${String(error)}`);
}

export function naxError(error: unknown): NaxError {
  if (error instanceof NaxError) return error;
  throw new Error(`expected a NaxError, got ${String(error)}`);
}

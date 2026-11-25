/**
 * #2986 — tell a backend its wrapped command has SPAWNED. bwrap creates its
 * placeholders at spawn, so this is when the backend can identify them. A backend
 * that fails here must never fail the command it observes.
 */
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import type { SandboxBackend } from "./types.ts";

export function notifyCommandStarted(backend: SandboxBackend, commandId: string): void {
  try {
    backend.commandStarted?.(commandId);
  } catch (err) {
    getSafeLogger()?.warn("sandbox", "backend commandStarted failed", { error: errorMessage(err) });
  }
}

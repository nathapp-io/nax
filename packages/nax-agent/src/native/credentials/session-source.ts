/**
 * A credential source owned by one session (S3 spec 5.2), instead of the
 * process-wide store behind `configureCredentials`. It never reads the slot:
 * the fingerprint salt is random per store, so an embedder that never called
 * `configureCredentials` can still run a session and stamp its cost rows.
 */
import { randomBytes } from "node:crypto";
import { createMemoryCredentialStore, type StoredCredential } from "@nathapp/nax-ai";
import { createChangeGuard, type GuardedCredentialStore } from "./change-guard.ts";
import { createExecCredentialSource } from "./exec-source.ts";

export type CredentialSource =
  | { readonly kind: "memory"; readonly credentials: Readonly<Record<string, StoredCredential>> }
  | {
      readonly kind: "exec";
      readonly command: readonly string[];
      readonly timeoutMs?: number;
      readonly onChange?: "warn" | "refuse";
    };

const SALT_BYTES = 32;

export function createSessionCredentialStore(source: CredentialSource): GuardedCredentialStore {
  const salt = randomBytes(SALT_BYTES);
  if (source.kind === "memory") {
    return createChangeGuard(createMemoryCredentialStore(source.credentials), {
      onChange: "warn",
      salt,
      describe: () => ({ source: "memory" }),
    });
  }
  const exec = createExecCredentialSource({
    command: source.command,
    ...(source.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
  });
  return createChangeGuard(exec, {
    onChange: source.onChange ?? "warn",
    salt,
    describe: (providerId) => {
      const account = exec.accountOf(providerId);
      return account === undefined ? { source: "exec" } : { source: "exec", account };
    },
  });
}

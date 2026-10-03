import { NaxError } from "./nax-error.ts";

/** Auth settings used by the native credential store. */
export interface CredentialAuthConfig {
  readonly source: "file" | "exec";
  readonly exec?: { readonly command: readonly string[]; readonly timeoutMs: number };
  readonly onChange: "warn" | "refuse";
}

/** Host functions the native credential store reads on demand. */
export interface CredentialsConfig {
  /** The directory holding `credentials`, `config.json` and the fingerprint salt. Read per call. */
  configDir(): string;
  /** The auth section of the global config. Read per call. */
  readAuthConfig(): Promise<CredentialAuthConfig>;
}

let configured: CredentialsConfig | undefined;

export function configureCredentials(config: CredentialsConfig): void {
  configured = config;
}

export function credentialsConfig(): CredentialsConfig {
  if (configured === undefined) {
    throw new NaxError(
      "Credentials are not configured: call configureCredentials() before reading credentials",
      "CREDENTIALS_NOT_CONFIGURED",
      { stage: "credentials" },
    );
  }
  return configured;
}

/** Clears the slot. Tests only. @internal */
export function _resetCredentialsConfig(): void {
  configured = undefined;
}

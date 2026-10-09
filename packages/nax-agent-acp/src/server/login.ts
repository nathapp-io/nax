/**
 * `nax-agent login <provider>` (S5 spec §6.1, S5-4): an interactive login on
 * the terminal, writing to the same credential store as `nax auth login`. An
 * editor's terminal auth runs this; exit 0 tells it the login succeeded.
 * Exit codes: 0 signed in, 1 failure or no terminal, 130 cancelled.
 */
import { AuthCancelledError, type AuthMethod, PromptCancelledError, redactSecrets } from "@nathapp/nax-agent";
import type { AuthPorts } from "#src/server/auth";
import { messageOf } from "#src/server/errors";

export interface LoginDeps {
  readonly isTTY: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly auth: Pick<AuthPorts, "runLogin" | "interaction">;
  /** After a successful login: offers to set a default model (#2414). A failure here never fails the login. */
  readonly offerModel?: (provider: string) => Promise<void>;
}

function envName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

async function offerAfterLogin(provider: string, deps: LoginDeps): Promise<void> {
  try {
    await deps.offerModel?.(provider);
  } catch (error) {
    deps.err(`nax-agent: could not set a default model: ${redactSecrets(messageOf(error))}`);
  }
}

export async function runLoginCommand(
  input: { readonly provider: string; readonly method?: AuthMethod },
  deps: LoginDeps,
): Promise<number> {
  if (!deps.isTTY) {
    deps.err(
      `nax-agent login needs an interactive terminal. Without one, set the provider's environment variable ` +
        `(for example ${envName(input.provider)}); nax-agent reads it when nothing is stored.`,
    );
    return 1;
  }
  try {
    const result = await deps.auth.runLogin(input.provider, deps.auth.interaction(deps.out), input.method);
    deps.out(`Signed in to ${result.providerId} (method: ${result.method}, credential: ${result.kind})`);
    await offerAfterLogin(result.providerId, deps);
    return 0;
  } catch (error) {
    if (error instanceof AuthCancelledError || error instanceof PromptCancelledError) return 130;
    deps.err(`nax-agent: ${redactSecrets(messageOf(error))}`);
    return 1;
  }
}

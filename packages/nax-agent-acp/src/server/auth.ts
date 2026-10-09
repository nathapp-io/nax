/**
 * Credentials for the ACP server (S5 spec §6.3, S5-4): the nax-agent auth API
 * behind one port, so the server and `login` are testable without a store.
 */
import {
  type AuthInteraction,
  type AuthMethod,
  type AuthResult,
  createTerminalAuthInteraction,
  loginProviderIds,
  providersWithoutCredentials,
  runLogin,
} from "@nathapp/nax-agent";

export interface AuthPorts {
  /** Providers `runLogin` can serve (M-33). */
  loginProviderIds(): Promise<readonly string[]>;
  /** Of these providers, those with neither a stored nor an ambient credential (M-29). */
  providersWithoutCredentials(providerIds: readonly string[]): Promise<readonly string[]>;
  runLogin(providerId: string, interaction: AuthInteraction, method?: AuthMethod): Promise<AuthResult>;
  /** The terminal login UI, writing its lines through `log`. */
  interaction(log: (line: string) => void): AuthInteraction;
}

export const NAX_AGENT_AUTH: AuthPorts = {
  loginProviderIds,
  providersWithoutCredentials,
  runLogin,
  interaction: (log) => createTerminalAuthInteraction({ log }),
};

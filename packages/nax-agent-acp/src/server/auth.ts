/**
 * Credentials for the ACP server (S5 spec §6.3, S5-4): the nax-agent auth API
 * behind one port, so the server and `login` are testable without a store.
 */
import type { AuthMethod as AcpAuthMethod, AuthenticateResponse } from "@agentclientprotocol/sdk";
import {
  type AgentLogger,
  type AuthInteraction,
  type AuthMethod,
  type AuthResult,
  createTerminalAuthInteraction,
  loginProviderIds,
  type NativeCatalogOverrides,
  NaxError,
  providersWithoutCredentials,
  redactSecrets,
  runLogin,
} from "@nathapp/nax-agent";
import { authRequired, invalidParams, isAuthFailureCode, messageOf } from "#src/server/errors";
import type { ServerOptions } from "#src/server/options";

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

const METHOD_PREFIX = "login-";

/** The provider prefix of a native model id, or undefined when it has none (never guessed). */
export function providerOf(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

/** Terminal login methods (spec §6.3, M-33): loginable, non-override providers, in order. */
export function terminalAuthMethods(input: {
  readonly models: readonly string[];
  readonly overridden: ReadonlySet<string>;
  readonly loginProviders: readonly string[];
}): AcpAuthMethod[] {
  const loginable = new Set(input.loginProviders);
  const providers = [...new Set(input.models.map(providerOf).filter((p): p is string => p !== undefined))].filter(
    (p) => loginable.has(p) && !input.overridden.has(p),
  );
  return providers.map((p) => ({
    id: `${METHOD_PREFIX}${p}`,
    name: `Log in to ${p}`,
    type: "terminal",
    args: ["login", p],
  }));
}

export interface ServerAuth {
  readonly methods: readonly AcpAuthMethod[];
  /** Spec §6.3, M-29/M-31. */
  authenticate(methodId: string): Promise<AuthenticateResponse>;
  /** M-30: throws auth_required when the model's provider has no credential. */
  ensureCredentials(model: string): Promise<void>;
}

export function createServerAuth(deps: {
  readonly methods: readonly AcpAuthMethod[];
  readonly overridden: ReadonlySet<string>;
  readonly missing: AuthPorts["providersWithoutCredentials"];
}): ServerAuth {
  const check = async (provider: string): Promise<void> => {
    let missing: readonly string[];
    try {
      missing = await deps.missing([provider]);
    } catch (error) {
      if (error instanceof NaxError && isAuthFailureCode(error.code)) {
        throw authRequired(redactSecrets(error.message), { provider, code: error.code });
      }
      throw error;
    }
    if (missing.includes(provider)) throw authRequired(`no credentials for provider "${provider}"`, { provider });
  };
  return {
    methods: deps.methods,
    async authenticate(methodId) {
      const method = deps.methods.find((m) => m.id === methodId);
      if (method === undefined) {
        const ids = deps.methods.map((m) => m.id).join(", ");
        throw invalidParams(`unknown auth method "${methodId}"; expected one of: ${ids === "" ? "(none)" : ids}`);
      }
      await check(methodId.slice(METHOD_PREFIX.length));
      return {};
    },
    async ensureCredentials(model) {
      const provider = providerOf(model);
      if (provider === undefined || deps.overridden.has(provider)) return;
      await check(provider);
    },
  };
}

/** No login methods and no checks: the default for an app built without auth. */
export const NO_SERVER_AUTH: ServerAuth = createServerAuth({
  methods: [],
  overridden: new Set(),
  missing: async () => [],
});

export async function loadServerAuth(input: {
  readonly options: ServerOptions;
  readonly overrides: NativeCatalogOverrides;
  readonly ports: AuthPorts;
  readonly logger: AgentLogger;
}): Promise<ServerAuth> {
  const { options, ports, logger } = input;
  const overridden = new Set(input.overrides.map((o) => o.provider));
  let loginProviders: readonly string[] = [];
  try {
    loginProviders = await ports.loginProviderIds();
  } catch (error) {
    logger.warn("auth", "could not list login providers; no login methods advertised", {
      error: redactSecrets(messageOf(error)),
    });
  }
  const models = [
    ...options.tiers.map((t) => t.model),
    ...(options.defaultModel !== undefined ? [options.defaultModel] : []),
  ];
  return createServerAuth({
    methods: terminalAuthMethods({ models, overridden, loginProviders }),
    overridden,
    missing: (ids) => ports.providersWithoutCredentials(ids),
  });
}

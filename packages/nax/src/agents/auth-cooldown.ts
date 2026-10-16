/** Provider-scoped native auth retirement and credential-change recovery. */
import type { AuthStamp } from "@nathapp/nax-agent";
import { DEFAULT_AGENT_NAME } from "@/config";
import type { ModelDef } from "@/config/schema-types";
import type { AdapterFailure } from "@/context/engine";
import { providerOf } from "./cooldown-provider";
import type { CooldownStore } from "./cooldown-store";
import type { LoggerLike } from "./manager-types";

export type AuthCooldownStamp = { providerId: string; fingerprint?: string };

export interface AuthCooldownDeps {
  servedAuth(providerId: string): AuthStamp | undefined;
  readCredential(providerId: string): Promise<void>;
}

export function authStampFor(
  agent: string,
  reason: AdapterFailure,
  modelId: string | undefined,
  deps: Pick<AuthCooldownDeps, "servedAuth">,
): AuthCooldownStamp | undefined {
  if (agent !== DEFAULT_AGENT_NAME || reason.outcome !== "fail-auth") return undefined;
  const providerId = providerOf(modelId);
  if (!providerId) return undefined;
  return { providerId, fingerprint: deps.servedAuth(providerId)?.fingerprint };
}

export function authModelOf(modelDef: ModelDef | undefined): string | undefined {
  return modelDef ? `${modelDef.provider}/${modelDef.model}` : undefined;
}

/** Notice tracking arrives in US-003; this port keeps recovery independent of it. */
interface AuthTracker {
  drop(providerId: string): void;
}

export async function refreshAuthCooldowns(
  store: CooldownStore,
  tracker: AuthTracker,
  deps: AuthCooldownDeps,
  logger: LoggerLike,
): Promise<void> {
  for (const { key, agent, auth } of store.authCooldowns()) {
    const { providerId, fingerprint: previousFingerprint } = auth;
    let fingerprint: string | undefined;
    try {
      await deps.readCredential(providerId);
      fingerprint = deps.servedAuth(providerId)?.fingerprint;
    } catch (error) {
      logger.debug?.("agent-manager", "[auth-cooldown] Credential read failed; keeping cooldown", {
        providerId,
        error: String(error),
      });
      continue;
    }
    if (fingerprint === undefined || fingerprint === previousFingerprint) continue;
    if (!store.release(key)) continue;
    tracker.drop(providerId);
    logger.info("agent-manager", `Credential changed for ${providerId} — ${agent} available again`, {
      storyId: "_agent",
      agent,
      providerId,
      previousFingerprint,
      fingerprint,
    });
  }
}

/** Binds the store, injectable credential access, and future notice tracker. */
export class AuthCoordinator {
  private readonly _tracker: AuthTracker = { drop: () => {} };
  constructor(
    private readonly _store: CooldownStore,
    private readonly _deps: AuthCooldownDeps,
    private readonly _logger: LoggerLike,
  ) {}

  refreshAuthCooldowns(): Promise<void> {
    return refreshAuthCooldowns(this._store, this._tracker, this._deps, this._logger);
  }
}

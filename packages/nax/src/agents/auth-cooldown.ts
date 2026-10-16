/** Provider-scoped native auth retirement and credential-change recovery. */
import type { AuthStamp, StoredEntry } from "@nathapp/nax-agent";
import { DEFAULT_AGENT_NAME } from "@/config";
import type { ModelDef } from "@/config/schema-types";
import type { AdapterFailure } from "@/context/engine";
import { type AuthReloginNotice, authReloginHint } from "./auth-relogin";
import { providerOf } from "./cooldown-provider";
import type { CooldownStore } from "./cooldown-store";
import type { LoggerLike } from "./manager-types";

export type AuthCooldownStamp = { providerId: string; fingerprint?: string };

export interface AuthCooldownDeps {
  now(): number;
  listStoredProviders(): Promise<StoredEntry[]>;
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

/** Run-scoped claims are made before credential metadata is read. */
export class AuthReloginTracker {
  private readonly _claimed = new Set<string>();
  private readonly _order = new Set<string>();
  private readonly _pending = new Map<string, symbol>();
  private readonly _notices = new Map<string, { notice: AuthReloginNotice; fingerprint?: string }>();

  async report(
    agent: string,
    failure: AdapterFailure | undefined,
    modelId: string | undefined,
    deps: AuthCooldownDeps,
    logger: LoggerLike,
  ): Promise<void> {
    if (!failure) return;
    const stamp = authStampFor(agent, failure, modelId, deps);
    if (!stamp) return;
    const { providerId, fingerprint } = stamp;
    const key = JSON.stringify([providerId, fingerprint]);
    if (this._claimed.has(key)) return;
    this._claimed.add(key);
    this._order.add(providerId);
    const report = Symbol();
    this._pending.set(providerId, report);
    let credential: StoredEntry | undefined;
    try {
      credential = (await deps.listStoredProviders()).find((entry) => entry.providerId === providerId);
    } catch {
      // Metadata failure must not hide the actionable fallback hint.
    }
    if (this._pending.get(providerId) !== report) return;
    const message = authReloginHint(providerId, credential, deps.now());
    logger.warn("agent-manager", message, {
      storyId: "_agent",
      agent,
      providerId,
      ...(credential ? { kind: credential.kind, expires: credential.expires } : {}),
    });
    this._notices.set(providerId, { notice: { providerId, agent, message }, fingerprint });
  }

  notices(): readonly AuthReloginNotice[] {
    return [...this._order].flatMap((providerId) => {
      const entry = this._notices.get(providerId);
      return entry ? [entry.notice] : [];
    });
  }
  stamps(): readonly AuthCooldownStamp[] {
    return [...this._notices].map(([providerId, { fingerprint }]) => ({ providerId, fingerprint }));
  }
  drop(providerId: string): void {
    this._notices.delete(providerId);
    this._order.delete(providerId);
    this._pending.delete(providerId);
  }
  clear(): void {
    this._notices.clear();
    this._claimed.clear();
    this._order.clear();
    this._pending.clear();
  }
}

export async function refreshAuthCooldowns(
  store: CooldownStore,
  tracker: AuthReloginTracker,
  deps: AuthCooldownDeps,
  logger: LoggerLike,
): Promise<void> {
  const cooldowns = store.authCooldowns();
  for (const { key, agent, auth } of cooldowns) {
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
  const parked = new Set(cooldowns.map(({ auth }) => auth.providerId));
  for (const { providerId, fingerprint } of tracker.stamps()) {
    if (parked.has(providerId)) continue;
    try {
      await deps.readCredential(providerId);
      const current = deps.servedAuth(providerId)?.fingerprint;
      if (current !== undefined && current !== fingerprint) tracker.drop(providerId);
    } catch (error) {
      logger.debug?.("agent-manager", "[auth-cooldown] Credential read failed; keeping notice", {
        providerId,
        error: String(error),
      });
    }
  }
}

/** Binds the store, injectable credential access, and notice tracker. */
export class AuthCoordinator {
  private readonly _tracker = new AuthReloginTracker();
  constructor(
    private readonly _store: CooldownStore,
    private readonly _deps: AuthCooldownDeps,
    private readonly _logger: LoggerLike,
  ) {}

  reportAuthFailure(agent: string, failure: AdapterFailure | undefined, modelId: string | undefined): Promise<void> {
    return this._tracker.report(agent, failure, modelId, this._deps, this._logger);
  }
  authRelogins(): readonly AuthReloginNotice[] {
    return this._tracker.notices();
  }
  clear(): void {
    this._tracker.clear();
  }
  refreshAuthCooldowns(): Promise<void> {
    return refreshAuthCooldowns(this._store, this._tracker, this._deps, this._logger);
  }
}

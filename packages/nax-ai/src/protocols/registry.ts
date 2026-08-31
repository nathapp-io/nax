/**
 * Protocol backend registration and selection.
 *
 * A protocol may have more than one backend — `pi` today, `native` when a wire
 * format is hand-written later. Both can be registered at once so a native
 * implementation can be run against the pi-backed one on real traffic before
 * becoming the default. That comparison is the reason selection happens at
 * runtime rather than by swapping a module at build time.
 */

import type { Protocol } from "./types.ts";

export type BackendId = "pi" | "native";

/** Lazy factories keyed by backend id. Laziness preserves pi-ai's deferred SDK loading. */
export type ProtocolBackends = Partial<Record<BackendId, () => Promise<Protocol>>>;

export type ProtocolEntries = Readonly<Record<string, ProtocolBackends>>;

export interface BackendSelection {
  /** Applied to protocols not named in `byProtocol`. Defaults to "pi". */
  readonly default?: BackendId;
  readonly byProtocol?: Readonly<Record<string, BackendId>>;
}

export class UnknownProtocolError extends Error {
  constructor(readonly protocolName: string) {
    super(`Unknown protocol "${protocolName}".`);
    this.name = "UnknownProtocolError";
  }
}

export class UnregisteredBackendError extends Error {
  constructor(
    readonly protocolName: string,
    readonly backendId: BackendId,
    available: readonly BackendId[],
  ) {
    super(
      `Backend "${backendId}" is not registered for protocol "${protocolName}". ` +
        `Available: ${available.length > 0 ? available.join(", ") : "none"}. ` +
        `This is not falling back — a silent fallback would misreport which implementation ran.`,
    );
    this.name = "UnregisteredBackendError";
  }
}

export interface ProtocolRegistry {
  available(): ReadonlyMap<string, readonly BackendId[]>;
  resolve(protocolName: string): Promise<Protocol>;
  /** Throws if any configured selection names an unknown protocol or unregistered backend. */
  validate(): void;
}

export function createRegistry(entries: ProtocolEntries, selection: BackendSelection = {}): ProtocolRegistry {
  const resolved = new Map<string, Promise<Protocol>>();

  const backendsFor = (protocolName: string): ProtocolBackends => {
    const backends = entries[protocolName];
    if (backends === undefined) throw new UnknownProtocolError(protocolName);
    return backends;
  };

  const idsFor = (backends: ProtocolBackends): readonly BackendId[] =>
    (Object.keys(backends) as BackendId[]).filter((id) => backends[id] !== undefined);

  const selectedFor = (protocolName: string): BackendId =>
    selection.byProtocol?.[protocolName] ?? selection.default ?? "pi";

  return {
    available() {
      const map = new Map<string, readonly BackendId[]>();
      for (const [name, backends] of Object.entries(entries)) {
        map.set(name, idsFor(backends));
      }
      return map;
    },

    async resolve(protocolName) {
      const cached = resolved.get(protocolName);
      if (cached !== undefined) return cached;

      const backends = backendsFor(protocolName);
      const backendId = selectedFor(protocolName);
      const factory = backends[backendId];
      if (factory === undefined) {
        throw new UnregisteredBackendError(protocolName, backendId, idsFor(backends));
      }

      const promise = factory();
      resolved.set(protocolName, promise);
      return promise;
    },

    validate() {
      // Per-protocol overrides first: they take precedence over the default,
      // and names a protocol outside `entries` must surface as unknown before
      // any default-derived check runs. Throwing exits immediately, so the
      // same defect is never reported twice.
      for (const [protocolName, backendId] of Object.entries(selection.byProtocol ?? {})) {
        const backends = backendsFor(protocolName);
        if (backends[backendId] === undefined) {
          throw new UnregisteredBackendError(protocolName, backendId, idsFor(backends));
        }
      }
      // The default applies to every protocol not named in byProtocol. A
      // `{ default: "native" }` selection must fail at startup, not on the
      // first resolve().
      for (const [protocolName, backends] of Object.entries(entries)) {
        const backendId = selectedFor(protocolName);
        if (backends[backendId] === undefined) {
          throw new UnregisteredBackendError(protocolName, backendId, idsFor(backends));
        }
      }
    },
  };
}

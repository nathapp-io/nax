/**
 * Opens the S3 session behind an ACP session (S5 spec §5.3 session/new): the
 * native backend with the session's model and bash approval, and a file
 * transcript store in the sessions directory (S5-2 M-9). The facade factories
 * are injectable for tests.
 */
import {
  type AgentLogger,
  type AgentSession,
  type AgentSessionProfile,
  type CreateAgentSessionOptions,
  createAgentSession,
  createFileTranscriptStore,
  type NativeBackendOptions,
  type NativeCatalogOverrides,
  nativeBackend,
  type SessionBackend,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import type { BashApproval } from "#src/server/nax-config";

export interface OpenSessionRequest {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly profile: AgentSessionProfile;
  readonly bashApproval: BashApproval;
}

export type OpenSession = (request: OpenSessionRequest) => Promise<AgentSession>;

type CatalogOverride = NativeCatalogOverrides[number];

function isCatalogOverride(value: unknown): value is CatalogOverride {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "models" in value &&
    Array.isArray(value.models)
  );
}

/** Entries nax's own schema would reject are dropped here, with one warning (M-17). */
export function catalogOverridesFrom(raw: readonly unknown[], logger: AgentLogger): NativeCatalogOverrides {
  const kept = raw.filter(isCatalogOverride);
  if (kept.length < raw.length) {
    logger.warn("config", "ignoring agent.native.catalogOverrides entries without provider and models", {
      dropped: raw.length - kept.length,
    });
  }
  return kept;
}

export interface NativeOpenDeps {
  readonly sessionsDir: string;
  readonly catalogOverrides: NativeCatalogOverrides;
  readonly turnTimeoutSeconds: number;
  readonly create?: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
  readonly backend?: (options: NativeBackendOptions) => SessionBackend;
  readonly store?: (dir: string) => TranscriptStore;
}

export function nativeOpenSession(deps: NativeOpenDeps): OpenSession {
  const create = deps.create ?? createAgentSession;
  const backend = deps.backend ?? nativeBackend;
  const store = deps.store ?? createFileTranscriptStore;
  return async (request) =>
    create({
      backend: backend({
        model: request.model,
        bashApproval: request.bashApproval,
        ...(deps.catalogOverrides.length > 0 ? { catalogOverrides: deps.catalogOverrides } : {}),
      }),
      sessionId: request.sessionId,
      profile: request.profile,
      workdir: request.cwd,
      transcriptStore: store(deps.sessionsDir),
      turnTimeoutSeconds: deps.turnTimeoutSeconds,
    });
}

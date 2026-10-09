/**
 * Opens the S3 session behind an ACP session (S5 spec §5.3 session/new): the
 * native backend with the session's model and bash approval, and a transcript
 * store, resuming a stored session or creating a new one (S5-3 M-21). The
 * facade factories are injectable for tests.
 */
import {
  type AgentLogger,
  type AgentSession,
  type AgentSessionProfile,
  type CreateAgentSessionOptions,
  createAgentSession,
  type NativeBackendOptions,
  type NativeCatalogOverrides,
  nativeBackend,
  resumeAgentSession,
  type SessionBackend,
  type TranscriptDoc,
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

export interface OpenedSession {
  readonly session: AgentSession;
  /** The stored document read before opening; null for a session never prompted. */
  readonly doc: TranscriptDoc | null;
}

export type OpenSession = (request: OpenSessionRequest) => Promise<OpenedSession>;

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
  readonly transcripts: TranscriptStore;
  readonly catalogOverrides: NativeCatalogOverrides;
  readonly turnTimeoutSeconds: number;
  readonly create?: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
  readonly resume?: (sessionId: string, options: CreateAgentSessionOptions) => Promise<AgentSession>;
  readonly backend?: (options: NativeBackendOptions) => SessionBackend;
}

/** nax-agent accepts bashApproval only where Bash is offered (M-22). */
const TOOL_PROFILES: ReadonlySet<AgentSessionProfile> = new Set(["ask", "full"]);

/**
 * Resume when the store holds the session's document, create when it does not:
 * a session never prompted has none (M-21). History is kept across a model
 * change (M-19).
 */
export function nativeOpenSession(deps: NativeOpenDeps): OpenSession {
  const create = deps.create ?? createAgentSession;
  const resume = deps.resume ?? resumeAgentSession;
  const backend = deps.backend ?? nativeBackend;
  return async (request) => {
    const doc = await deps.transcripts.load(request.sessionId);
    const options: CreateAgentSessionOptions = {
      backend: backend({
        model: request.model,
        carryHistoryAcrossModels: true,
        ...(TOOL_PROFILES.has(request.profile) ? { bashApproval: request.bashApproval } : {}),
        ...(deps.catalogOverrides.length > 0 ? { catalogOverrides: deps.catalogOverrides } : {}),
      }),
      sessionId: request.sessionId,
      profile: request.profile,
      ...(request.profile !== "none" ? { workdir: request.cwd } : {}),
      transcriptStore: deps.transcripts,
      turnTimeoutSeconds: deps.turnTimeoutSeconds,
    };
    const session = doc === null ? await create(options) : await resume(request.sessionId, options);
    return { session, doc };
  };
}

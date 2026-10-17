/**
 * What an ACP SDK session opens with (S4b spec §6.1 steps 2-3): the backend's
 * BackendOpenContext and its acpBackend options. nax keeps its own env
 * allowlist (agents/shared/env.ts) with inheritEnv false, puts everything in the
 * prompt (no instructions), registers no tools (B5) and enforces the turn
 * deadline itself, so turnTimeoutSeconds is informational. Model and effort
 * come from the model spec (§6.7, D2-a); the startup and teardown deadlines
 * become initializeTimeoutMs and cancelGraceMs (§7.2, D3-i). nax's resolved
 * rule lists ride along as the backend's `rules`, and its per-agent policy
 * files are written under `<globalConfigDir>/acp` (`stateDir`;
 * SPEC-cursor-pi-acp-read-only US-005).
 */
import { join } from "node:path";
import {
  type BackendOpenContext,
  createFileTranscriptStore,
  createMemoryTranscriptStore,
  type OpenSessionOpts,
  parseModelSpec,
  type SessionAskPort,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import type { AcpAgentName, AcpBackendOptions, AcpProcessHooks } from "@nathapp/nax-agent-acp/client";
import { globalConfigDir } from "@/config/paths";
import { buildAllowedEnv } from "../shared/env";
import { type AcpProfile, acpProfileFor } from "./profile-map";
import { finalizeAcpSurface } from "./provider-embedder";
import type { TurnSlot } from "./turn-slot";

/** The backend's option schema accepts only these names (nax-agent-acp options.ts). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** nax's agent env: the allowlist plus the model's env, minus anything the backend would reject. */
export function backendEnv(modelEnv?: Readonly<Record<string, string>>): Record<string, string> {
  const allowed = buildAllowedEnv(modelEnv === undefined ? undefined : { modelEnv: { ...modelEnv } });
  return Object.fromEntries(
    Object.entries(allowed).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && ENV_NAME.test(entry[0]) && !entry[1].includes("\u0000"),
    ),
  );
}

/** `agent.acp.trackedSpawnStartupDeadlineMs`'s schema default; the adapter cannot read config (#1583). */
export const DEFAULT_STARTUP_DEADLINE_MS = 30_000;
/** `agent.acp.trackedSpawnDeadlineMs`'s schema default (PERF-1). */
export const DEFAULT_CLOSE_DEADLINE_MS = 10_000;
/** nax-agent-acp's option schema maxima (options.ts); nax's schema has no upper bound (D3-i). */
const BACKEND_MAX_INITIALIZE_MS = 3_600_000;
const BACKEND_MAX_CANCEL_GRACE_MS = 600_000;

/**
 * nax's per-agent rule-policy files live outside the workdir, under the global
 * config dir the backend cannot read for itself (SPEC-cursor-pi-acp-read-only
 * US-004/US-005): `<globalConfigDir>/acp/<agent>/…`.
 */
function acpStateDir(): string {
  return join(globalConfigDir(), "acp");
}

/** nax's resolved rule lists, as the backend's rules; a stage that configures none forwards empty lists. */
function rulesOf(opts: OpenSessionOpts): NonNullable<AcpBackendOptions["rules"]> {
  return {
    allow: opts.resolvedPermissions.toolGrants ?? [],
    deny: opts.resolvedPermissions.denyRules ?? [],
    ask: opts.resolvedPermissions.askRules ?? [],
  };
}

export function backendOptions(
  agent: AcpAgentName,
  opts: OpenSessionOpts,
  onProcess?: AcpProcessHooks,
): AcpBackendOptions {
  const { model, effort } = parseModelSpec(opts.modelDef.model);
  return {
    agent,
    allowUnsandboxed: true,
    ...(model === "" ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    env: backendEnv(opts.modelDef.env),
    inheritEnv: false,
    initializeTimeoutMs: Math.min(
      opts.trackedSpawnStartupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS,
      BACKEND_MAX_INITIALIZE_MS,
    ),
    cancelGraceMs: Math.min(opts.trackedSpawnDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS, BACKEND_MAX_CANCEL_GRACE_MS),
    // Forwarded verbatim: the backend's own option validator rejects a rule it
    // cannot use (an empty pattern list, say) rather than nax dropping it here,
    // where a dropped rule would silently widen a read-only profile.
    rules: rulesOf(opts),
    stateDir: acpStateDir(),
    ...(onProcess === undefined ? {} : { onProcess }),
  };
}

/** SessionManager's per-feature transcript dir when it derived one; else memory (nothing to resume after a crash). */
export function transcriptStoreFor(dir: string | undefined): TranscriptStore {
  return dir === undefined ? createMemoryTranscriptStore() : createFileTranscriptStore(dir);
}

export interface OpenContextInput {
  readonly name: string;
  /** The registered ACP agent — decides whether provider tools may be delivered (nax#2444 D3). */
  readonly agent: AcpAgentName;
  readonly opts: OpenSessionOpts;
  readonly store: TranscriptStore;
  /** A crash-leftover document to restore (§6.1, D2-j). */
  readonly resume: TranscriptDoc | undefined;
  readonly asks: SessionAskPort;
  readonly slot: TurnSlot;
  /** Aborted when the session starts closing. */
  readonly openSignal: AbortSignal;
}

function metadataOf(opts: OpenSessionOpts): Record<string, string> {
  const header = opts.toolAudit?.header;
  return {
    ...(header?.featureName === undefined ? {} : { feature: header.featureName }),
    ...(header?.storyId === undefined ? {} : { storyId: header.storyId }),
    ...(header?.sessionRole === undefined ? {} : { role: header.sessionRole }),
  };
}

/** nax#2500: the profile an ACP open uses and the sandbox it forwards (logged at open). */
export interface AcpOpenSummary {
  readonly profile: AcpProfile;
  readonly sandbox: "policy" | "unavailable" | "none";
}

export function acpOpenSummary(opts: OpenSessionOpts): AcpOpenSummary {
  const profile = acpProfileFor(opts.resolvedPermissions.mode, opts.declaredTools);
  return { profile, sandbox: sandboxFor(profile, opts)?.kind ?? "none" };
}

function sandboxFor(profile: AcpProfile, opts: OpenSessionOpts): OpenSessionOpts["sandbox"] {
  return profile === "review" || profile === "full" ? opts.sandbox : undefined;
}

export function openContext(input: OpenContextInput): BackendOpenContext {
  const { name, opts, slot } = input;
  const { profile } = acpOpenSummary(opts);
  const sandbox = sandboxFor(profile, opts);
  // nax#2444 D1/D3: provider tools ride the loopback host for capable agents;
  // everything else stays the historical B5 shape (no tools registered).
  const delivery = finalizeAcpSurface(input.agent, opts, profile);
  return {
    sessionId: name,
    workdir: opts.workdir,
    profile,
    instructions: undefined,
    tools: delivery.tools,
    ...(delivery.tools.length > 0 && opts.providerInstructions !== undefined
      ? { providerInstructions: opts.providerInstructions }
      : {}),
    transcriptStore: input.store,
    resume: input.resume === undefined ? undefined : { doc: input.resume },
    asks: input.asks,
    turnSignal: () => slot.signal(),
    currentTurnId: () => slot.turnId(),
    turnTimeoutSeconds: opts.timeoutSeconds,
    metadata: metadataOf(opts),
    openSignal: input.openSignal,
    ...(sandbox !== undefined ? { sandbox } : {}),
  };
}

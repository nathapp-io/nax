/**
 * What an ACP SDK session opens with (S4b spec §6.1 steps 2-3): the backend's
 * BackendOpenContext and its acpBackend options. nax keeps its own env
 * allowlist (agents/shared/env.ts) with inheritEnv false, puts everything in the
 * prompt (no instructions), registers no tools (B5) and enforces the turn
 * deadline itself, so turnTimeoutSeconds is informational. Model only: effort
 * is S4b-3; the probe found nax's model aliases offered verbatim (D2-a).
 */
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
import { buildAllowedEnv } from "../shared/env";
import { acpProfileFor } from "./profile-map";
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

export function backendOptions(
  agent: AcpAgentName,
  opts: OpenSessionOpts,
  onProcess?: AcpProcessHooks,
): AcpBackendOptions {
  const { model } = parseModelSpec(opts.modelDef.model);
  return {
    agent,
    allowUnsandboxed: true,
    ...(model === "" ? {} : { model }),
    env: backendEnv(opts.modelDef.env),
    inheritEnv: false,
    ...(onProcess === undefined ? {} : { onProcess }),
  };
}

/** SessionManager's per-feature transcript dir when it derived one; else memory (nothing to resume after a crash). */
export function transcriptStoreFor(dir: string | undefined): TranscriptStore {
  return dir === undefined ? createMemoryTranscriptStore() : createFileTranscriptStore(dir);
}

export interface OpenContextInput {
  readonly name: string;
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

export function openContext(input: OpenContextInput): BackendOpenContext {
  const { name, opts, slot } = input;
  return {
    sessionId: name,
    workdir: opts.workdir,
    profile: acpProfileFor(opts.resolvedPermissions.mode),
    instructions: undefined,
    tools: [],
    transcriptStore: input.store,
    resume: input.resume === undefined ? undefined : { doc: input.resume },
    asks: input.asks,
    turnSignal: () => slot.signal(),
    currentTurnId: () => slot.turnId(),
    turnTimeoutSeconds: opts.timeoutSeconds,
    metadata: metadataOf(opts),
    openSignal: input.openSignal,
  };
}

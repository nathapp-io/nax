/**
 * The native backend (S4 spec 5.2): the S3 facade's native half behind the
 * SessionBackend seam. Sandbox floor, profile tools, the interaction handler
 * with built-in and embedder tools, the NativeSessionAdapter, loop handlers
 * and the resume model check.
 */
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "#src/infra/spin-breaker/index";
import { NATIVE_AGENT } from "#src/native/models";
import { transcriptModelIdentity } from "#src/native/session/transcript-identity";
import type { TranscriptDoc } from "#src/native/session/transcript-types";
import type { TurnRetryConfig } from "#src/native/session/turn-retry";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { AgentSessionError } from "./agent-session-errors.ts";
import {
  type NativeBackendOptions,
  nativeProfileRules,
  parseNativeBackendOptions,
  type ResolvedNativeOptions,
} from "./native-backend-options.ts";
import { createSessionAskLink, createSessionAskResolver } from "./session-ask-link.ts";
import type { BackendOpenContext, OpenedBackend, SessionBackend } from "./session-backend.ts";
import { createSessionInteractionHandler, embedderToolDescriptor } from "./session-interaction.ts";
import { buildSessionToolSupport, defaultProtectedPaths, resolveSessionLauncher } from "./session-tool-support.ts";

export const NATIVE_BACKEND_KIND = "native";

/** nax's agent.native.transportRetry default (S3 spec 5.3). */
const SESSION_TRANSPORT_RETRY: TurnRetryConfig = { maxAttempts: 3, baseDelayMs: 2000 };

function createAdapter(raw: NativeBackendOptions): NativeSessionAdapter {
  const overrides = raw.catalogOverrides ?? [];
  const owns = overrides.length > 0 || raw.credentials !== undefined;
  return new NativeSessionAdapter(overrides, {
    ...(raw.credentials !== undefined ? { credentials: raw.credentials } : {}),
    ...(owns ? { ownClient: true } : {}),
  });
}

function checkResumeModel(doc: TranscriptDoc, sessionId: string, model: string): void {
  const resuming = transcriptModelIdentity(model);
  if (doc.model !== undefined && doc.model !== resuming) {
    throw new AgentSessionError(
      `Session "${sessionId}" was written by model "${doc.model}"; resume it with that model, not "${resuming}"`,
      "AGENT_SESSION_MODEL_MISMATCH",
      { sessionId },
    );
  }
}

async function openNative(resolved: ResolvedNativeOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  const raw = resolved.raw;
  if (ctx.resume !== undefined) checkResumeModel(ctx.resume.doc, ctx.sessionId, raw.model);
  const { bashApproval, allowUnsandboxed } = nativeProfileRules(ctx.profile, raw);
  const protectedPaths = { ...defaultProtectedPaths(raw.credentials !== undefined), ...raw.hostPorts?.protectedPaths };
  const launcher = await resolveSessionLauncher({
    profile: ctx.profile,
    root: ctx.workdir,
    protectedPaths,
    bashApproval,
    allowUnsandboxed,
  });
  let callId: string | undefined;
  const { support, grants } = buildSessionToolSupport({
    profile: ctx.profile,
    root: ctx.workdir,
    sessionName: ctx.sessionId,
    protectedPaths,
    bashApproval,
    launcher,
    askResolver: createSessionAskResolver(createSessionAskLink({ port: ctx.asks, currentCallId: () => callId })),
    interceptor: raw.hostPorts?.commandInterceptor,
  });
  const interactionHandler = createSessionInteractionHandler({
    sessionId: ctx.sessionId,
    runtime: support.runtime,
    embedderTools: new Map(ctx.tools.map((tool) => [tool.name, tool])),
    asks: ctx.asks,
    turnSignal: ctx.turnSignal,
    setCurrentCallId: (id) => {
      callId = id;
    },
  });
  const adapter = createAdapter(raw);
  const handle = await adapter.openSession(ctx.sessionId, {
    agentName: NATIVE_AGENT,
    workdir: ctx.workdir,
    resolvedPermissions: { mode: "default", toolGrants: grants, bashApproval },
    modelDef: { provider: resolved.provider, model: raw.model },
    timeoutSeconds: ctx.turnTimeoutSeconds,
    transcriptStore: ctx.transcriptStore,
    retainOnClose: true,
    resume: ctx.resume !== undefined,
    spinBreaker: DEFAULT_SPIN_BREAKER_SETTINGS,
    transportRetry: SESSION_TRANSPORT_RETRY,
    ...(ctx.instructions !== undefined && ctx.instructions !== "" ? { systemPrompt: ctx.instructions } : {}),
  });
  const codingTools = [...support.tools, ...ctx.tools.map(embedderToolDescriptor)];
  const loopHandlerContext = {
    sessionName: ctx.sessionId,
    workdir: ctx.workdir,
    model: raw.model,
    provider: resolved.provider,
  };
  return {
    adapter,
    handle,
    info: { kind: NATIVE_BACKEND_KIND, capabilities: {} },
    turnOpts: () => ({
      interactionHandler,
      codingTools,
      loopHandlerContext,
      ...(raw.loopHandlers !== undefined ? { loopHandlers: raw.loopHandlers } : {}),
    }),
    // Native owns no per-session resource beyond the adapter, which
    // closeSession (the facade's step before this) already releases.
    close: async () => {},
  };
}

export function nativeBackend(options: NativeBackendOptions): SessionBackend {
  const resolved = parseNativeBackendOptions(options);
  return { kind: NATIVE_BACKEND_KIND, open: (ctx) => openNative(resolved, ctx) };
}

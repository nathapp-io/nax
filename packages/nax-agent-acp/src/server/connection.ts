/**
 * The ACP agent app and its stdio transport (S5 spec §3.1). Uses the SDK's
 * `agent()` builder, not the deprecated AgentSideConnection. The client's
 * optional features are read once, at `initialize`. Every request handler runs
 * under `guard` (spec §7): one failure never stops the connection.
 */
import { Readable, Writable } from "node:stream";
import { type AgentApp, type AgentConnection, agent, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentLogger } from "@nathapp/nax-agent";
import { initializeResponse } from "#src/server/capabilities";
import { type ClientFeatures, clientFeatures, clientPort, NO_CLIENT_FEATURES } from "#src/server/client-port";
import { guard } from "#src/server/errors";
import type { SessionRegistry } from "#src/server/registry";

export interface AppDeps {
  readonly version: string;
  readonly registry: SessionRegistry;
  readonly logger: AgentLogger;
}

export function buildAgentApp(deps: AppDeps): AgentApp {
  let features: ClientFeatures = NO_CLIENT_FEATURES;
  return agent({ name: "nax-agent" })
    .onRequest("initialize", (ctx) => {
      features = clientFeatures(ctx.params.clientCapabilities);
      return initializeResponse(deps.version);
    })
    .onRequest("session/new", (ctx) =>
      guard(deps.logger, async () => {
        const created = await deps.registry.create({
          cwd: ctx.params.cwd,
          mcpServers: ctx.params.mcpServers,
          port: (sessionId) => clientPort(ctx.client, sessionId, features),
        });
        return { sessionId: created.sessionId };
      }),
    )
    .onRequest("session/prompt", (ctx) =>
      guard(deps.logger, () => deps.registry.get(ctx.params.sessionId).prompt(ctx.params.prompt)),
    )
    .onNotification("session/cancel", (ctx) => {
      const session = deps.registry.find(ctx.params.sessionId);
      if (session === undefined) {
        deps.logger.debug("session", "cancel for an unknown session ignored", { sessionId: ctx.params.sessionId });
        return;
      }
      session.cancel();
    });
}

export function serveStdio(
  app: AgentApp,
  io: { readonly stdin: Readable; readonly stdout: Writable },
): AgentConnection {
  return app.connect(ndJsonStream(Writable.toWeb(io.stdout), Readable.toWeb(io.stdin)));
}

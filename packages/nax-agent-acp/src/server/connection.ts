/**
 * The ACP agent app and its stdio transport (S5 spec §3.1). Uses the SDK's
 * `agent()` builder, not the deprecated AgentSideConnection.
 */
import { Readable, Writable } from "node:stream";
import { type AgentApp, type AgentConnection, agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { initializeResponse } from "#src/server/capabilities";

export interface AppDeps {
  readonly version: string;
}

export function buildAgentApp(deps: AppDeps): AgentApp {
  return agent({ name: "nax-agent" }).onRequest("initialize", () => initializeResponse(deps.version));
}

export function serveStdio(
  app: AgentApp,
  io: { readonly stdin: Readable; readonly stdout: Writable },
): AgentConnection {
  return app.connect(ndJsonStream(Writable.toWeb(io.stdout), Readable.toWeb(io.stdin)));
}

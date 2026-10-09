/**
 * ACP session id -> ServerSession, in memory (S5 spec §3.1; S5-3 makes it
 * persistent). `create` is session/new: an absolute cwd and a model are
 * required; the MCP notice is queued for the first turn (S5-2 M-11). `closeAll`
 * is the S5-2 shutdown (M-16).
 */
import { isAbsolute } from "node:path";
import type { AgentLogger } from "@nathapp/nax-agent";
import type { ClientPort } from "#src/server/client-port";
import { invalidParams, messageOf, unknownSession } from "#src/server/errors";
import type { OpenSession } from "#src/server/open-session";
import type { ServerOptions } from "#src/server/options";
import { createServerSession, type ServerSession } from "#src/server/server-session";
import type { ReadOldText } from "#src/server/translate/diff";
import { announce } from "#src/server/translate/notice";

export const NO_MODEL_MESSAGE = "no model configured: set models.native.balanced or --model";
export const MCP_NOTICE = "MCP servers are not supported yet; ignored";

export interface NewSessionInput {
  readonly cwd: string;
  readonly mcpServers: readonly unknown[];
  readonly port: (sessionId: string) => ClientPort;
}

export interface SessionRegistry {
  create(input: NewSessionInput): Promise<ServerSession>;
  /** Throws resource_not_found for an unknown id. */
  get(sessionId: string): ServerSession;
  find(sessionId: string): ServerSession | undefined;
  closeAll(): Promise<void>;
}

export interface RegistryDeps {
  readonly options: ServerOptions;
  readonly openSession: OpenSession;
  readonly newId: () => string;
  readonly readOldText: ReadOldText;
  readonly logger: AgentLogger;
  readonly turnTimeoutSeconds: number;
}

export function createSessionRegistry(deps: RegistryDeps): SessionRegistry {
  const sessions = new Map<string, ServerSession>();
  const { options } = deps;

  return {
    async create(input) {
      if (!isAbsolute(input.cwd)) throw invalidParams(`cwd must be an absolute path: ${input.cwd}`);
      const model = options.defaultModel;
      if (model === undefined) throw invalidParams(NO_MODEL_MESSAGE);
      const sessionId = deps.newId();
      const agentSession = await deps.openSession({
        sessionId,
        cwd: input.cwd,
        model,
        profile: options.defaultMode,
        bashApproval: options.bashApproval,
      });
      const port = input.port(sessionId);
      const contextWindow = options.tiers.find((tier) => tier.model === model)?.contextWindow;
      const session = createServerSession({
        session: agentSession,
        port,
        cwd: input.cwd,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        readOldText: deps.readOldText,
        logger: deps.logger,
        turnTimeoutSeconds: deps.turnTimeoutSeconds,
      });
      if (input.mcpServers.length > 0) {
        session.queueNotice(announce(port.features.updates.notices, "warning", MCP_NOTICE));
      }
      sessions.set(sessionId, session);
      deps.logger.info("session", "session opened", { sessionId, cwd: input.cwd, model, mode: options.defaultMode });
      return session;
    },
    get(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw unknownSession(sessionId);
      return session;
    },
    find: (sessionId) => sessions.get(sessionId),
    async closeAll() {
      const open = [...sessions.entries()];
      sessions.clear();
      const results = await Promise.allSettled(open.map(([, session]) => session.close()));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          deps.logger.warn("session", "session close failed", {
            sessionId: open[index]?.[0],
            error: messageOf(result.reason),
          });
        }
      });
    },
  };
}

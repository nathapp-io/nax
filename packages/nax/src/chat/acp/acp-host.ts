/**
 * The chat host's ACP glue: the install preflight and the opener wrapper that
 * reports every ACP open to the catalog. The host keeps one-line call sites.
 */
import { NaxError } from "@/errors";
import type { openChatSession } from "../open-chat-session";
import type { AcpCatalog } from "./acp-catalog";
import { acpAgentLabel, isChatAcpModel, parseChatAcpModel } from "./acp-model";

/** Throws CHAT_ACP_AGENT_UNAVAILABLE for an ACP model whose agent is not installed; no-op otherwise or without a catalog. */
export function assertAcpInstalled(catalog: AcpCatalog | undefined, model: string): void {
  if (catalog === undefined || !isChatAcpModel(model) || catalog.installed(model)) return;
  const target = parseChatAcpModel(model);
  const label = target ? acpAgentLabel(target.agent) : model;
  throw new NaxError(`[chat] ${label} is not installed on this machine`, "CHAT_ACP_AGENT_UNAVAILABLE", {
    stage: "chat",
    model,
  });
}

/**
 * Wraps an opener, forwarding (request, deps) unchanged. On success it reports
 * catalog.opened(handle.meta.model, handle.session.backend.capabilities) when that model is an
 * ACP model; on failure it reports catalog.failed(request.model, error) when request.model is an
 * ACP model (a resume request carries no model, so its failure is not recorded), then rethrows.
 */
export function reportAcpOpens(open: typeof openChatSession, catalog: AcpCatalog | undefined): typeof openChatSession {
  if (catalog === undefined) return open;
  return async (...args) => {
    const [request] = args;
    let handle: Awaited<ReturnType<typeof openChatSession>>;
    try {
      handle = await open(...args);
    } catch (error) {
      if (request.model !== undefined && isChatAcpModel(request.model)) catalog.failed(request.model, error);
      throw error;
    }
    if (isChatAcpModel(handle.meta.model)) catalog.opened(handle.meta.model, handle.session.backend.capabilities);
    return handle;
  };
}

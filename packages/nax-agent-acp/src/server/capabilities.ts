/**
 * The `initialize` response (S5 spec §5.2). Each slice advertises a capability in
 * the same change that implements it (master plan Review Focus); S5-3 advertises
 * load, list, resume, close and delete.
 */
import { type InitializeResponse, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

export function initializeResponse(version: string): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
    },
    authMethods: [],
    agentInfo: { name: "nax-agent", title: "nax-agent", version },
  };
}

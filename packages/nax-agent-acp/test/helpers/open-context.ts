/** A complete BackendOpenContext for calling a backend's open() directly. */
import { type BackendOpenContext, createMemoryTranscriptStore } from "@nathapp/nax-agent";

const IDLE = new AbortController().signal;

export function openContext(workdir: string, overrides: Partial<BackendOpenContext> = {}): BackendOpenContext {
  return {
    sessionId: "session-1",
    workdir,
    profile: "full",
    instructions: undefined,
    tools: [],
    transcriptStore: createMemoryTranscriptStore(),
    resume: undefined,
    asks: {
      requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
      recordAutoDecision: () => {},
      askQuestion: async () => null,
      noteQuestion: () => {},
    },
    turnSignal: () => IDLE,
    currentTurnId: () => undefined,
    turnTimeoutSeconds: 600,
    metadata: {},
    openSignal: IDLE,
    ...overrides,
  };
}

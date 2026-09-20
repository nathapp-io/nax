/**
 * Ambient module declaration for the dispatcher the implementer will create
 * at `src/agents/native/session/loop-events.ts`. This `.d.ts` exists only so
 * the test files in this directory typecheck BEFORE the seam is built —
 * tests must exercise observable behavior at runtime, not rely on the
 * shape of this declaration. Once `loop-events.ts` lands, the runtime
 * resolution will take over and TypeScript will typecheck against the
 * real declarations.
 *
 * Delete this file once `src/agents/native/session/loop-events.ts`
 * exists; the implementer does not need it.
 */
declare module "@/agents/native/session/loop-events" {
  export type AfterToolPatch = {
    content?: string;
    isError?: boolean;
  };

  export type AfterToolPayload = {
    content: string;
    isError?: boolean;
    denied?: { reason: string; breach: boolean };
  };

  export type BeforeToolOutcome =
    | { kind: "allow"; input?: Record<string, unknown> }
    | { kind: "nudge"; text: string }
    | { kind: "block"; content: string; isError?: boolean }
    | { kind: "terminate"; content: string; isError?: boolean };

  export type AfterToolHandler = (
    call: { id: string; name: string; input: unknown },
    payload: AfterToolPayload,
  ) => AfterToolPatch;

  export type BeforeToolHandler = (
    call: { id: string; name: string; input: unknown },
    tools: readonly unknown[],
  ) => BeforeToolOutcome;

  export interface LoopEventRegistry {
    registerBeforeTool(handler: BeforeToolHandler): void;
    registerAfterTool(handler: AfterToolHandler): void;
    beforeTool(call: { id: string; name: string; input: unknown }, tools: readonly unknown[]): BeforeToolOutcome;
    afterTool(call: { id: string; name: string; input: unknown }, payload: AfterToolPayload): AfterToolPatch;
  }

  export function createLoopEventRegistry(): LoopEventRegistry;

  export function buildToolResult(args: {
    toolCallId: string;
    content: string;
    isError?: boolean;
    denied?: { reason: string; breach: boolean };
  }): {
    role: "tool-result";
    toolCallId: string;
    content: string;
    isError?: boolean;
    denied?: { reason: string; breach: boolean };
  };
}

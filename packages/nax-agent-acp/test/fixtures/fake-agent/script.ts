/**
 * The fake ACP agent's script (S4 spec §9). A test describes what the agent
 * answers and does per prompt; the agent reports every request it receives
 * through FakeHooks.record. Plain data, so the subprocess entry parses it from JSON.
 */
import type {
  AgentCapabilities,
  ElicitationSchema,
  PermissionOptionKind,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk";

export interface RpcFailure {
  readonly code: number;
  readonly message: string;
}

export type FakeStep =
  /**
   * An agent_message_chunk; `sessionId` addresses another session (routing tests);
   * `echoMcpAuth` appends the tool host's Authorization value (scrubbing tests, S4-5).
   */
  | { readonly kind: "text"; readonly text: string; readonly sessionId?: string; readonly echoMcpAuth?: boolean }
  | { readonly kind: "thought"; readonly text: string }
  /** Any session/update for the prompt's session: tool calls, usage, plans (S4-5 D5-m). */
  | { readonly kind: "update"; readonly update: SessionUpdate }
  /** elicitation/create (S4-5 D5-m). */
  | ElicitStep
  | { readonly kind: "delay"; readonly ms: number }
  | PermissionStep
  /** Waits until every detached permission request, MCP call and elicitation of this prompt has been answered. */
  | { readonly kind: "settled" }
  /** Waits for session/cancel, then carries on with the next step (waitForCancel stops the turn instead). */
  | { readonly kind: "awaitCancel" }
  /** Blocks until session/cancel arrives; the turn then stops "cancelled". */
  | { readonly kind: "waitForCancel" }
  /** Never settles and ignores session/cancel. */
  | { readonly kind: "hang" }
  /** Subprocess only: writes `stderr` and exits with `code` mid-turn. */
  | { readonly kind: "exit"; readonly code: number; readonly stderr?: string }
  /** Calls an embedder tool through the session's HTTP MCP server, as an MCP client (S4-4 D4-k). */
  | McpCallStep
  /** The prompt request fails with this JSON-RPC error; `echoMcpAuth` appends the MCP server's Authorization value (leak tests). */
  | { readonly kind: "fail"; readonly failure: RpcFailure; readonly echoMcpAuth?: boolean };

/** Records `mcp-result` `{ tool, result }` or `mcp-error` `{ tool, message }`. */
export interface McpCallStep {
  readonly kind: "mcpCall";
  readonly tool: string;
  readonly input?: Readonly<Record<string, unknown>>;
  /** Sent without waiting for the result; `settled` waits for it. */
  readonly detached?: boolean;
}

/** Records `elicitation-answer` (the response) or `elicitation-error` `{ message }`. */
export interface ElicitStep {
  readonly kind: "elicit";
  readonly message: string;
  /** Absent: a message-only form (no properties). */
  readonly requestedSchema?: ElicitationSchema;
  /** Default "form"; "url" sends a url-mode request. */
  readonly mode?: "form" | "url";
  /** Default "session" (the prompt's session); "request" is request-scoped; "other" names another session. */
  readonly scope?: "session" | "request" | "other";
  /** Sent without waiting for the answer; `settled` waits for it. */
  readonly detached?: boolean;
}

/** session/request_permission with one option per kind (optionId "opt-<kind>"). */
export interface PermissionStep {
  readonly kind: "permission";
  readonly options: readonly PermissionOptionKind[];
  /** Overrides the default tool call { toolCallId: "fake-permission", title: "Edit a file", kind: "edit" }. */
  readonly toolCall?: Partial<Pick<ToolCallUpdate, "toolCallId" | "title" | "kind" | "rawInput" | "locations">>;
  /** Addresses another session (routing tests). */
  readonly sessionId?: string;
  /** Sent without waiting for the answer; the answer is still recorded. */
  readonly detached?: boolean;
}

export interface FakeTurn {
  readonly steps: readonly FakeStep[];
  readonly stopReason?: StopReason;
  readonly usage?: Usage;
}

export interface FakeStartup {
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly hang?: boolean;
  readonly ignoreSigterm?: boolean;
  /** Spawns `sleep 30` in the agent's process group and records its pid as "child". */
  readonly spawnChild?: boolean;
  readonly garbageLine?: boolean;
  readonly oversizedLineBytes?: number;
}

export interface FakeScript {
  /** Subprocess only: behaviour before the ACP stream starts. */
  readonly startup?: FakeStartup;
  readonly protocolVersion?: number;
  readonly agentInfo?: { readonly name: string; readonly version: string };
  readonly capabilities?: AgentCapabilities;
  readonly hangInitialize?: boolean;
  readonly initializeFailure?: RpcFailure;
  readonly newSessionFailure?: RpcFailure;
  /** Default "fake-session-1". */
  readonly sessionId?: string;
  readonly configOptions?: readonly SessionConfigOption[];
  /** Turns in order; the last repeats. Default: one turn replying "ok". */
  readonly turns?: readonly FakeTurn[];
  /** Subprocess only: variables whose presence the "start" record reports. */
  readonly recordEnv?: readonly string[];
}

export interface FakeRecord {
  readonly method: string;
  readonly params: unknown;
}

export interface FakeHooks {
  record(method: string, params: unknown): void;
  /** Ends the agent process (subprocess); in process the step fails instead. */
  exit(code: number, stderr?: string): never;
}

/** Claude's session config as the fake offers it: a `mode` select and a `model` select. */
export const CLAUDE_CONFIG_OPTIONS: readonly SessionConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "acceptEdits", name: "Accept edits" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "sonnet", name: "Sonnet" },
    ],
  },
];

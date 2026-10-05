/**
 * The fake ACP agent's script (S4 spec §9). A test describes what the agent
 * answers and does per prompt; the agent reports every request it receives
 * through FakeHooks.record. Plain data, so the subprocess entry parses it from JSON.
 */
import type {
  AgentCapabilities,
  PermissionOptionKind,
  SessionConfigOption,
  StopReason,
  Usage,
} from "@agentclientprotocol/sdk";

export interface RpcFailure {
  readonly code: number;
  readonly message: string;
}

export type FakeStep =
  /** An agent_message_chunk; `sessionId` addresses another session (routing tests). */
  | { readonly kind: "text"; readonly text: string; readonly sessionId?: string }
  | { readonly kind: "thought"; readonly text: string }
  | { readonly kind: "delay"; readonly ms: number }
  /** session/request_permission with one option per kind; the outcome is recorded as "permission-outcome". */
  | { readonly kind: "permission"; readonly options: readonly PermissionOptionKind[] }
  /** Blocks until session/cancel arrives; the turn then stops "cancelled". */
  | { readonly kind: "waitForCancel" }
  /** Never settles and ignores session/cancel. */
  | { readonly kind: "hang" }
  /** Subprocess only: writes `stderr` and exits with `code` mid-turn. */
  | { readonly kind: "exit"; readonly code: number; readonly stderr?: string }
  /** The prompt request fails with this JSON-RPC error. */
  | { readonly kind: "fail"; readonly failure: RpcFailure };

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

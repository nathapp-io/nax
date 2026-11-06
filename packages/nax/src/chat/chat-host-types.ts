/**
 * The chat host's contract, kept beside the host rather than inside it.
 *
 * These declarations — the host itself, its composition input, the state a mounted screen reads
 * and the options a send carries — are what every caller of `createChatHost` depends on. They
 * live here so `chat-host.ts` can hold only the implementation and stay inside the 600-line
 * source cap, and `chat-host.ts` re-exports all of them, so no consumer's import path changes.
 *
 * `ChatHost.steer` (US-004) is optional on purpose: a hand-built test host typechecks without
 * one, and the screen falls back to interrupt-and-send when it is absent. The real host always
 * provides it (see `host-steer-compact.ts`).
 */
import type {
  CommandRunResult,
  CompactResult,
  ImageAttachment,
  SandboxState,
  SessionEvent,
  SessionMeta,
  SessionStorage,
  SteerResult,
} from "@nathapp/nax-agent";
import type { NaxConfig } from "@/config";
import type { InteractionChain } from "@/interaction";
import type { Logger } from "@/logger";
import type { AcpCatalog, AcpRefreshResult } from "./acp";
import type { ChatAskController } from "./ask-controller";
import type { ChatBackgroundTasks } from "./background";
import type { ChatAgentRow } from "./chat-agents-listing";
import type { EffortLevel } from "./chat-effort";
import type { ChatMode } from "./chat-mode";
import type { ChatJobs, ChatRunAsks } from "./jobs";
import type { ChatHistory, openChatSession } from "./open-chat-session";
import type { RecentModelStore } from "./recent-models";
import type { ChatResources } from "./resources";

export interface ChatHostState {
  readonly sessionId: string;
  readonly mode: ChatMode;
  readonly model: string;
  readonly meta: SessionMeta;
  readonly sandbox?: SandboxState;
  /** The session model's catalog context window; absent when the catalog cannot say. */
  readonly contextWindow?: number;
}

export interface ChatSessionRow {
  readonly sessionId: string;
  readonly title: string | null;
  readonly updatedAt: string | null;
  readonly heldByPid?: number;
}

export interface ChatSendOptions {
  readonly title?: string;
  /** Images to send with this message; an absent or empty list sends the text alone. */
  readonly images?: readonly ImageAttachment[];
}

/** Shared-session chat lifecycle, independent of the terminal shell. */
export interface ChatHost {
  readonly repoRoot: string;
  readonly catalog?: ChatResources["catalog"];
  readonly naxPlugins?: ChatResources["naxPlugins"];
  readonly mcp?: ChatResources["mcp"];
  /** The memory host this chat writes notes through; absent when memory is off or unavailable. */
  readonly memory?: ChatResources["memory"];
  readonly models: readonly string[];
  readonly asks: ChatAskController;
  readonly jobs?: ChatJobs;
  readonly runAsks?: ChatRunAsks;
  readonly tasks?: ChatBackgroundTasks;
  /** Task-notice turns in a row that may wake the agent before a user turn (`interaction.defaults.chatTaskNoticeTurns`). */
  readonly taskNoticeTurns?: number;
  readonly confirmBeforeClose?: () => Promise<boolean>;
  current(): ChatHostState;
  history?(): ChatHistory;
  effortLevels?(model: string): readonly EffortLevel[];
  refreshAcpModels?(): Promise<readonly AcpRefreshResult[]>;
  /** Why the model cannot be used right now (an ACP agent that is not installed or not logged in), if it cannot. */
  modelNote?(model: string): string | undefined;
  /** One row per catalog agent in catalog order, resolved against the chat session's current model. */
  agents?(): readonly ChatAgentRow[];
  start(input: { mode: ChatMode; model: string }): Promise<void>;
  clear(): Promise<void>;
  resume(input: { id?: string }): Promise<void>;
  notice(): string | undefined;
  resourceNotice?(): string | undefined;
  switchTo(input: { mode?: ChatMode; model?: string }): Promise<void>;
  send(message: string, onEvent: (event: SessionEvent) => void, options?: ChatSendOptions): Promise<void>;
  /** Whether the open session reads images; `false` when no session is open or it cannot say. */
  acceptsImages?(): Promise<boolean>;
  /**
   * Hand text to the running turn (US-004). Optional so a hand-built host typechecks: a host
   * without it makes the screen interrupt and send instead, exactly as an `unsupported` brain
   * does. `no_turn` when there is no session to steer.
   */
  steer?(text: string): SteerResult;
  /**
   * Compact the conversation history now (US-005), recording what the summarizer call spent.
   * Optional so a hand-built host typechecks: one without it makes the screen's `/compact`
   * answer that compaction is not available here. Rejects when no session is open, when the
   * session's brain cannot compact, and when the summarizer itself fails.
   */
  compact?(): Promise<CompactResult>;
  /**
   * The models used most recently, newest first, with the effort each was used at (US-006).
   * Optional so a hand-built host typechecks: one without it makes `/model` list the catalogue
   * alone, as it did before the list existed.
   */
  recentModels?(): readonly string[];
  runCommand?(command: string, onEvent: (event: SessionEvent) => void): Promise<CommandRunResult>;
  cancel(): void;
  listSessions(): Promise<readonly ChatSessionRow[]>;
  close(): Promise<void>;
}

export interface ChatHostDeps {
  readonly naxEntry?: readonly string[];
  readonly resources?: ChatResources;
  readonly models?: readonly string[];
  /** The ACP agents offered as chat models; absent on a host that offers native models only. */
  readonly acp?: AcpCatalog;
  readonly effortLevels?: ReadonlyMap<string, readonly EffortLevel[]>;
  readonly config: NaxConfig;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly chain: InteractionChain | null;
  readonly open?: typeof openChatSession;
  readonly storage: SessionStorage;
  /**
   * The persisted recent models and the list loaded from them before the host was built
   * (US-006). Optional so a host composed without one simply has no recent rows.
   */
  readonly recents?: { readonly store: RecentModelStore; readonly initial: readonly string[] };
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}

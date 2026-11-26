/**
 * Runtime types for the optional `chat` root config key (US-005, nax#2931).
 *
 * Every field is optional: an absent `chat` block, or an absent `workflow` block inside it,
 * leaves today's chat behaviour untouched. `specFixRounds` is the one required field — the
 * schema supplies its default once `workflow` is present.
 *
 * `web` (US-015) is the chat session's web policy. Its `WebSearchBackendId` comes from
 * `@nathapp/nax-agent` as a type only: the search backends themselves are built by the
 * wiring layer, which is free to depend on the factories this file must not.
 */
import type { WebSearchBackendId } from "@nathapp/nax-agent/internal";

/** The profiles one launch kind runs with. An empty list means "not set" — the caller's default applies. */
export interface ChatStepConfig {
  /** `nax chat` profile names, as `--profile <name>` accepts them. */
  readonly profiles?: readonly string[];
}

/** A `nax bot` step: profiles plus the model the job runs on. */
export interface ChatBotStepConfig extends ChatStepConfig {
  /** Model id forwarded to `nax bot review|fix --model <id>`. */
  readonly model?: string;
}

/** The agent and model that write or review a spec (`nax plan`). */
export interface ChatAgentChoice {
  /** Agent name; falls back to the chat session's own default agent when absent. */
  readonly agent?: string;
  /** Model id; falls back to the agent's own default when absent. */
  readonly model?: string;
}

/**
 * Which profiles, agents and models each part of the chat workflow runs with.
 *
 * Step keys are per launch kind: `plan` -> `plan`; `run` and `publish` -> `run`;
 * `bot_review` -> `botReview`; `bot_fix` -> `botFix`.
 */
export interface ChatWorkflowConfig {
  /** `nax plan` launches. */
  readonly plan?: ChatStepConfig;
  /** `nax run` launches, and `publish` (a publish-only run). */
  readonly run?: ChatStepConfig;
  /** `nax bot review` launches. */
  readonly botReview?: ChatBotStepConfig;
  /** `nax bot fix` launches. */
  readonly botFix?: ChatBotStepConfig;
  /** The agent and model that write the spec. */
  readonly specWriter?: ChatAgentChoice;
  /** The agent and model that review the spec. */
  readonly specReviewer?: ChatAgentChoice;
  /** Fix rounds the spec loop gets; defaults to DEFAULT_SPEC_FIX_ROUNDS (2), 1..10. */
  readonly specFixRounds: number;
}

/** The chat session's own compaction policy (US-006). `0` turns either half off. */
export interface ChatCompactionConfig {
  /** Absolute token trigger for the native chat session; 0 turns the cap off. */
  readonly compactAtTokens: number;
  /** Minutes of idleness before a background compact; 0 turns idle compaction off. */
  readonly idleCompactAfterMinutes: number;
}

/** The optional `chat` root config key. */
export interface ChatConfig {
  readonly workflow?: ChatWorkflowConfig;
  /** Chat-session compaction policy; absent means the resolver defaults apply. */
  readonly compaction?: ChatCompactionConfig;
  /** The chat session's web policy; absent means `nax chat` reaches no network at all. */
  readonly web?: ChatWebConfig;
}

/**
 * `chat.web.search` (US-015) — the backend a web search goes through.
 *
 * `backend` is required once `search` is present: no backend is the default, so leaving
 * `search` out is how search stays off while `web__fetch` remains available.
 */
export interface ChatWebSearchConfig {
  /** Which backend a search calls. */
  readonly backend: WebSearchBackendId;
  /** Required when `backend` is `"searxng"`; an http or https URL. Unused by the hosted backends. */
  readonly searxngUrl?: string;
  /** How many results one search asks for; defaults to 8, in 1..20. */
  readonly maxResults: number;
}

/** Limits on one `web__fetch`: how much page text is kept, and the deadline it runs under. */
export interface ChatWebFetchConfig {
  /** Bytes of page text kept per fetch; defaults to 200000, in 1000..5000000. */
  readonly maxBytes: number;
  /** Deadline for one fetch; defaults to 15000, in 1000..60000. */
  readonly timeoutMs: number;
}

/**
 * The optional `chat.web` block (US-015): what the chat session may reach, and how.
 *
 * `enabled` defaults to false and nothing else here is materialized for a config that never
 * sets `web`, so an unconfigured repository keeps today's no-network behaviour exactly.
 */
export interface ChatWebConfig {
  /** Whether `nax chat` may use the web tools at all; defaults to false. */
  readonly enabled: boolean;
  /** Search settings; absent means fetch only. */
  readonly search?: ChatWebSearchConfig;
  /** The fetch limits, with the defaults applied. */
  readonly fetch: ChatWebFetchConfig;
  /** Hosts a sandboxed command may reach once the session is exposed; absent means the built-in list (US-016). */
  readonly exposedAllowedDomains?: readonly string[];
}

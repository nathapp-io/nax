/**
 * Runtime types for the optional `chat` root config key (US-005, nax#2931).
 *
 * Every field is optional: an absent `chat` block, or an absent `workflow` block inside it,
 * leaves today's chat behaviour untouched. `specFixRounds` is the one required field — the
 * schema supplies its default once `workflow` is present.
 */

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
 * Step keys are per launch kind: `plan` -> `plan`; `run` and `finish` -> `run`;
 * `bot_review` -> `botReview`; `bot_fix` -> `botFix`.
 */
export interface ChatWorkflowConfig {
  /** `nax plan` launches. */
  readonly plan?: ChatStepConfig;
  /** `nax run` launches, and `finish` (a publish-only run). */
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

/** The optional `chat` root config key. */
export interface ChatConfig {
  readonly workflow?: ChatWorkflowConfig;
}

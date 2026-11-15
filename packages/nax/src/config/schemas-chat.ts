/**
 * `chat` root-key schema (US-005, nax#2931).
 *
 * The key is optional with no root default, so `NaxConfigSchema.parse({})` and `DEFAULT_CONFIG`
 * keep their key sets. Inside `workflow` every field is optional except `specFixRounds`, whose
 * default applies once `workflow` is present.
 *
 * Profile names and model ids are validated here with the same patterns a launch applies to its
 * input; the launch path (`src/chat/jobs/job-argv.ts`) reads these two constants rather than
 * re-spelling them, so config load and launch cannot drift.
 */
import { z } from "zod";
import type { ChatConfig } from "./runtime-types-chat";

/** Fix rounds the spec loop gets when `chat.workflow.specFixRounds` is unset. */
export const DEFAULT_SPEC_FIX_ROUNDS = 2;

/** A profile name, as `nax chat` accepts one. */
export const CHAT_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A model id, as `nax bot review|fix --model` accepts one. */
export const CHAT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const ChatStepConfigSchema = z.object({
  profiles: z.array(z.string().regex(CHAT_PROFILE_PATTERN, "must be a valid profile name")).optional(),
});

const ChatBotStepConfigSchema = ChatStepConfigSchema.extend({
  model: z.string().regex(CHAT_MODEL_PATTERN, "must be a valid model id").optional(),
});

const ChatAgentChoiceSchema = z.object({
  agent: z.string().min(1, "must not be empty").optional(),
  model: z.string().regex(CHAT_MODEL_PATTERN, "must be a valid model id").optional(),
});

const ChatWorkflowConfigSchema = z.object({
  plan: ChatStepConfigSchema.optional(),
  run: ChatStepConfigSchema.optional(),
  botReview: ChatBotStepConfigSchema.optional(),
  botFix: ChatBotStepConfigSchema.optional(),
  specWriter: ChatAgentChoiceSchema.optional(),
  specReviewer: ChatAgentChoiceSchema.optional(),
  specFixRounds: z.number().int().min(1).max(10).default(DEFAULT_SPEC_FIX_ROUNDS),
});

const ChatConfigObjectSchema = z.object({
  workflow: ChatWorkflowConfigSchema.optional(),
});

export const ChatConfigSchema: z.ZodType<ChatConfig, z.input<typeof ChatConfigObjectSchema>> = ChatConfigObjectSchema;

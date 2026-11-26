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
 *
 * `compaction` (US-006) is the chat session's own policy: an absolute token cap for the native
 * chat session and the idle delay before a background compact. It is deliberately separate from
 * the shared `execution.compaction` (US-005) — the chat defaults must not land there, because
 * story sessions and chat subagents keep the execution settings.
 *
 * `web` (US-015) is the chat session's web policy: whether the web tools are offered, which
 * search backend they use, what one fetch may spend, and which hosts a sandboxed command may
 * reach once the session has been exposed. It is optional with no default, so a config that
 * never mentions it keeps the existing no-network behaviour.
 */

import type { WebSearchBackendId } from "@nathapp/nax-agent/internal";
import { MIN_COMPACT_AT_TOKENS } from "@nathapp/nax-agent/internal";
import { z } from "zod";
import type { ChatConfig } from "./runtime-types-chat";

/** Fix rounds the spec loop gets when `chat.workflow.specFixRounds` is unset. */
export const DEFAULT_SPEC_FIX_ROUNDS = 2;

/** The native chat session's absolute compaction trigger when `chat.compaction.compactAtTokens` is unset. */
export const DEFAULT_CHAT_COMPACT_AT_TOKENS = 200_000;

/** Minutes of chat idleness before an idle compaction when `chat.compaction.idleCompactAfterMinutes` is unset. */
export const DEFAULT_IDLE_COMPACT_AFTER_MINUTES = 55;

/** One day: an idle delay beyond it is indistinguishable from "off". */
const MAX_IDLE_COMPACT_AFTER_MINUTES = 1_440;

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

/** The chat session's compaction policy. 0 turns either half off. */
const ChatCompactionConfigSchema = z.object({
  compactAtTokens: z
    .number()
    .int()
    .refine((tokens) => tokens === 0 || tokens >= MIN_COMPACT_AT_TOKENS, {
      message: `compactAtTokens must be 0 (off) or at least ${MIN_COMPACT_AT_TOKENS}`,
    })
    .default(DEFAULT_CHAT_COMPACT_AT_TOKENS),
  idleCompactAfterMinutes: z
    .number()
    .int()
    .min(0)
    .max(MAX_IDLE_COMPACT_AFTER_MINUTES)
    .default(DEFAULT_IDLE_COMPACT_AFTER_MINUTES),
});

/** `chat.web.search.maxResults` when the key is unset. */
export const DEFAULT_CHAT_WEB_MAX_RESULTS = 8;

/** `chat.web.fetch.maxBytes` when the key is unset: 200 kB of page text per fetch. */
export const DEFAULT_CHAT_WEB_FETCH_MAX_BYTES = 200_000;

/** `chat.web.fetch.timeoutMs` when the key is unset. */
export const DEFAULT_CHAT_WEB_FETCH_TIMEOUT_MS = 15_000;

/** The inclusive range `chat.web.search.maxResults` accepts. `web__search` clamps to the same range. */
export const CHAT_WEB_MAX_RESULTS_RANGE = { min: 1, max: 20 } as const;

/** The inclusive range `chat.web.fetch.maxBytes` accepts. */
export const CHAT_WEB_FETCH_MAX_BYTES_RANGE = { min: 1_000, max: 5_000_000 } as const;

/** The inclusive range `chat.web.fetch.timeoutMs` accepts. */
export const CHAT_WEB_FETCH_TIMEOUT_MS_RANGE = { min: 1_000, max: 60_000 } as const;

/** The one backend that needs a URL of its own. */
const SEARXNG_BACKEND_ID = "searxng";

/** Reported when a searxng search names no instance to call. */
const SEARXNG_URL_REQUIRED_MESSAGE = `is required when chat.web.search.backend is "${SEARXNG_BACKEND_ID}"`;

/** Reported for a searxngUrl that is not an http or https URL. */
const SEARXNG_URL_SCHEME_MESSAGE = "must be an http or https URL";

/**
 * The four backend ids, spelled once here.
 *
 * Spelled out rather than derived from `WebSearchBackendId` (a type has no runtime value) and
 * bound to it with `satisfies`, so an id that leaves the union is a compile error here; the
 * `ChatConfigSchema` annotation at the bottom of this file catches the other direction.
 */
const WEB_SEARCH_BACKEND_IDS = [
  "tavily",
  "brave",
  "exa",
  SEARXNG_BACKEND_ID,
] as const satisfies readonly WebSearchBackendId[];

const WebSearchBackendIdSchema = z.enum(WEB_SEARCH_BACKEND_IDS);

/**
 * http or https — the only two schemes `web__search` can call.
 *
 * A local predicate, not a shared one: `memory.koda.url` has the same test in
 * `schemas-memory.ts`, and that helper stays private to the schema that owns the rule.
 */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    // Not a URL at all: the scheme message covers that case too.
    return false;
  }
}

/**
 * `chat.web.search` — the backend a search goes through, and how many results it asks for.
 *
 * `searxng` is self-hosted, so it is the one backend that must say where it lives: the
 * cross-field rule below reports a missing or unusable `searxngUrl` AT `searxngUrl`, which is
 * how the operator finds the key to add. The hosted backends take their key from the
 * environment (`TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`), never from config.
 */
const ChatWebSearchConfigSchema = z
  .object({
    backend: WebSearchBackendIdSchema,
    searxngUrl: z.string().optional(),
    maxResults: z
      .number()
      .int()
      .min(CHAT_WEB_MAX_RESULTS_RANGE.min)
      .max(CHAT_WEB_MAX_RESULTS_RANGE.max)
      .default(DEFAULT_CHAT_WEB_MAX_RESULTS),
  })
  .strict()
  .superRefine((search, ctx) => {
    if (search.searxngUrl === undefined) {
      if (search.backend === SEARXNG_BACKEND_ID) {
        ctx.addIssue({ code: "custom", path: ["searxngUrl"], message: SEARXNG_URL_REQUIRED_MESSAGE });
      }
      return;
    }
    if (!isHttpUrl(search.searxngUrl)) {
      ctx.addIssue({ code: "custom", path: ["searxngUrl"], message: SEARXNG_URL_SCHEME_MESSAGE });
    }
  });

/** `chat.web.fetch` — the limits one `web__fetch` runs under. */
const ChatWebFetchConfigSchema = z
  .object({
    maxBytes: z
      .number()
      .int()
      .min(CHAT_WEB_FETCH_MAX_BYTES_RANGE.min)
      .max(CHAT_WEB_FETCH_MAX_BYTES_RANGE.max)
      .default(DEFAULT_CHAT_WEB_FETCH_MAX_BYTES),
    timeoutMs: z
      .number()
      .int()
      .min(CHAT_WEB_FETCH_TIMEOUT_MS_RANGE.min)
      .max(CHAT_WEB_FETCH_TIMEOUT_MS_RANGE.max)
      .default(DEFAULT_CHAT_WEB_FETCH_TIMEOUT_MS),
  })
  .strict();

/**
 * `chat.web` — the web tool family's policy for a chat session (US-015).
 *
 * `fetch` is `.prefault({})`, not `.default({})`: a Zod 4 `.default` returns the literal
 * without parsing it, so the inner defaults would never apply and `chat.web: { enabled: true }`
 * would resolve without `fetch`.
 */
const ChatWebConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    search: ChatWebSearchConfigSchema.optional(),
    fetch: ChatWebFetchConfigSchema.prefault({}),
    exposedAllowedDomains: z.array(z.string().min(1)).optional(),
  })
  .strict();

const ChatConfigObjectSchema = z.object({
  workflow: ChatWorkflowConfigSchema.optional(),
  compaction: ChatCompactionConfigSchema.optional(),
  /**
   * Optional with no default: a config that never mentions the web keeps `web` absent, so
   * today's no-network chat behaviour is unchanged (`chat.web: {}` is different — it means
   * "web configured, all defaults" and resolves to `enabled: false` plus the fetch limits).
   */
  web: ChatWebConfigSchema.optional(),
});

export const ChatConfigSchema: z.ZodType<ChatConfig, z.input<typeof ChatConfigObjectSchema>> = ChatConfigObjectSchema;

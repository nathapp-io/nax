/**
 * Debate schemas for nax configuration.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";

const DebaterPersonaEnum = z.enum(["challenger", "pragmatist", "completionist", "security", "testability"]);

const DebaterSchema = z.object({
  agent: z.string().min(1, "debater.agent must be non-empty"),
  model: z.string().min(1, "debater.model must be non-empty").optional(),
  persona: DebaterPersonaEnum.optional(),
});

const toObject = (val: unknown): unknown => (val === undefined || val === null ? {} : val);

const RESOLVER_TYPES = ["synthesis", "majority-fail-closed", "majority-fail-open", "custom"] as const;

const makeResolverSchema = (defaultType: (typeof RESOLVER_TYPES)[number]) =>
  z.preprocess(
    toObject,
    z.object({
      type: z.enum(RESOLVER_TYPES).default(defaultType),
      agent: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      tieBreaker: z.string().min(1).optional(),
      maxPromptTokens: z.number().int().positive().optional(),
    }),
  );

const DebateStageConfigSchema = (defaults: {
  enabled: boolean;
  resolverType: (typeof RESOLVER_TYPES)[number];
  sessionMode: "one-shot" | "stateful";
  rounds: number;
}) =>
  z.preprocess(
    toObject,
    z.object({
      enabled: z.boolean().default(defaults.enabled),
      resolver: makeResolverSchema(defaults.resolverType),
      sessionMode: z.enum(["one-shot", "stateful"]).default(defaults.sessionMode),
      rounds: z.number().int().min(1).default(defaults.rounds),
      mode: z.enum(["panel", "hybrid"]).default("panel"),
      debaters: z.array(DebaterSchema).min(2, "debaters must have at least 2 entries").optional(),
      timeoutSeconds: z.number().int().positive().default(600),
      autoPersona: z.boolean().default(false),
    }),
  );

export const DebateConfigSchema = z.preprocess(
  toObject,
  z.object({
    enabled: z.boolean().default(false),
    agents: z.number().int().min(2).default(3),
    maxConcurrentDebaters: z.number().int().min(1).max(10).default(2),
    stages: z.preprocess(
      toObject,
      z.object({
        plan: DebateStageConfigSchema({ enabled: true, resolverType: "synthesis", sessionMode: "stateful", rounds: 3 }),
        review: DebateStageConfigSchema({
          enabled: true,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 2,
        }),
        acceptance: DebateStageConfigSchema({
          enabled: false,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 1,
        }),
        rectification: DebateStageConfigSchema({
          enabled: false,
          resolverType: "synthesis",
          sessionMode: "one-shot",
          rounds: 1,
        }),
        escalation: DebateStageConfigSchema({
          enabled: false,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 1,
        }),
      }),
    ),
  }),
);

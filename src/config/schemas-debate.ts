/**
 * Debate schemas for nax configuration.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";
import { ConfiguredModelSchema } from "./schemas-model";

const DebaterPersonaEnum = z.enum(["challenger", "pragmatist", "completionist", "security", "testability"]);

const GrounderConfigSchema = z.object({
  model: ConfiguredModelSchema.default("fast"),
  timeoutSeconds: z.number().int().positive().default(1800),
});

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

// Selector discriminated union — Phase 2 adds verifier-pick with optional patch
const SelectorSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("synthesis") }),
    z.object({ kind: z.literal("majority-fail-closed") }),
    z.object({ kind: z.literal("majority-fail-open") }),
    z.object({ kind: z.literal("judge") }),
    z.object({
      kind: z.literal("verifier-pick"),
      patch: z
        .object({
          enabled: z.boolean(),
          overlapThreshold: z.number().optional(),
          maxDeltas: z.number().int().positive().optional(),
          onFailure: z.enum(["use-unpatched", "block"]).optional(),
        })
        .optional(),
    }),
  ])
  .optional();

// Plan-stage-only extensions (Phase 2 AC3)
const PlanStageExtensions = z.object({
  evidenceMode: z.enum(["current", "asymmetric"]).default("current"),
});

const makeDebateStageSchema = (
  defaults: {
    enabled: boolean;
    resolverType: (typeof RESOLVER_TYPES)[number];
    sessionMode: "one-shot" | "stateful";
    rounds: number;
  },
  extensions?: z.ZodObject<z.ZodRawShape>,
) => {
  const base = z.object({
    enabled: z.boolean().default(defaults.enabled),
    resolver: makeResolverSchema(defaults.resolverType),
    sessionMode: z.enum(["one-shot", "stateful"]).default(defaults.sessionMode),
    rounds: z.number().int().min(1).default(defaults.rounds),
    mode: z.enum(["panel", "hybrid"]).default("panel"),
    debaters: z.array(DebaterSchema).min(2, "debaters must have at least 2 entries").optional(),
    timeoutSeconds: z.number().int().positive().default(600),
    autoPersona: z.boolean().default(false),
    preDebatePhase: z
      .object({
        kind: z.enum(["grounder", "custom"]),
        onFailure: z.enum(["degrade", "block"]).optional(),
      })
      .optional(),
    proposers: z
      .object({
        citationsRequired: z.boolean().optional(),
        fileReadAccess: z.boolean().optional(),
        fileReadBudget: z.number().int().positive().optional(),
      })
      .optional(),
    selector: SelectorSchema,
    postDebateVerifier: z
      .object({
        kind: z.enum(["plan-checklist", "review-grounding-filter", "custom"]),
        onBlocker: z.enum(["block", "tag-expert"]).optional(),
      })
      .optional(),
  });

  // Non-plan stages explicitly reject evidenceMode so Zod throws if it is provided.
  const extended = extensions ? base.extend(extensions.shape) : base.extend({ evidenceMode: z.undefined() });
  return z.preprocess(toObject, extended);
};

export const DebateConfigSchema = z.preprocess(
  toObject,
  z.object({
    enabled: z.boolean().default(false),
    agents: z.number().int().min(2).default(3),
    maxConcurrentDebaters: z.number().int().min(1).max(10).default(2),
    grounder: z.preprocess(toObject, GrounderConfigSchema),
    stages: z.preprocess(
      toObject,
      z.object({
        plan: makeDebateStageSchema(
          { enabled: true, resolverType: "synthesis", sessionMode: "stateful", rounds: 3 },
          PlanStageExtensions,
        ),
        review: makeDebateStageSchema({
          enabled: true,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 2,
        }),
        acceptance: makeDebateStageSchema({
          enabled: false,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 1,
        }),
        rectification: makeDebateStageSchema({
          enabled: false,
          resolverType: "synthesis",
          sessionMode: "one-shot",
          rounds: 1,
        }),
        escalation: makeDebateStageSchema({
          enabled: false,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 1,
        }),
      }),
    ),
  }),
);

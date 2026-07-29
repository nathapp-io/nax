import { z } from "zod";

/** Header map; values may contain ${ENV_VAR} placeholders resolved at emit time. */
const HeadersSchema = z.record(z.string(), z.string()).default({});

const ReporterEventSchema = z.enum(["onRunStart", "onStoryComplete", "onRunEnd", "onPhaseStart", "onPhaseComplete"]);

export const WebhookReporterConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    url: z.string().url().optional(),
    headers: HeadersSchema,
    events: z.array(ReporterEventSchema).optional(),
    timeoutMs: z.number().int().positive().default(5000),
  })
  .default({
    enabled: false,
    headers: {},
    timeoutMs: 5000,
  });

export const OtelReporterConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().optional(),
    headers: HeadersSchema,
    serviceName: z.string().default("nax"),
    timeoutMs: z.number().int().positive().default(5000),
    detail: z.enum(["counts", "summary", "full"]).default("counts"),
    heartbeatIntervalMs: z.number().int().positive().default(10_000),
    maxBatchSize: z.number().int().positive().default(64),
    flushIntervalMs: z.number().int().positive().default(5_000),
    maxQueueSize: z.number().int().positive().default(2_048),
    phases: z.array(z.string()).optional(),
  })
  .default({
    enabled: false,
    headers: {},
    serviceName: "nax",
    timeoutMs: 5000,
    detail: "counts",
    heartbeatIntervalMs: 10_000,
    maxBatchSize: 64,
    flushIntervalMs: 5_000,
    maxQueueSize: 2_048,
  });

export const ReportersConfigSchema = z
  .object({
    webhook: WebhookReporterConfigSchema,
    otel: OtelReporterConfigSchema,
  })
  .default({
    webhook: {
      enabled: false,
      headers: {},
      timeoutMs: 5000,
    },
    otel: {
      enabled: false,
      headers: {},
      serviceName: "nax",
      timeoutMs: 5000,
      detail: "counts",
      heartbeatIntervalMs: 10_000,
      maxBatchSize: 64,
      flushIntervalMs: 5_000,
      maxQueueSize: 2_048,
    },
  });

export type ReporterEvent = z.infer<typeof ReporterEventSchema>;
export type WebhookReporterConfig = z.infer<typeof WebhookReporterConfigSchema>;
export type OtelReporterConfig = z.infer<typeof OtelReporterConfigSchema>;
export type ReportersConfig = z.infer<typeof ReportersConfigSchema>;

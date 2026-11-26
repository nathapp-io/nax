import { join } from "node:path";
import { z } from "zod";
import { BashApprovalModeSchema } from "#src/config/bash-approval";
import { WEB_SEEN_URL_CAP } from "#src/web/types";

export const SESSION_META_MODES = ["none", "read", "ask", "full"] as const;
export type SessionMetaMode = (typeof SESSION_META_MODES)[number];
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function defaultSessionsDir(configDir: string): string {
  return join(configDir, ".agent-server", "sessions");
}

/**
 * The stored form of a session's web exposure. `seenUrls` is bounded by the same cap the
 * live exposure keeps, so a snapshot written by a build that lost track of it cannot
 * exceed the bound on the way back in.
 */
const WebMetaSchema = z.object({
  exposedAt: z.string().nullable(),
  seenUrls: z.array(z.string()).max(WEB_SEEN_URL_CAP),
  searches: z.number().int().min(0),
});

type WebMeta = z.infer<typeof WebMetaSchema>;

const MetaObjectSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  mode: z.enum(SESSION_META_MODES),
  model: z.string().min(1),
  bashApproval: BashApprovalModeSchema,
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  costUsd: z.number().optional(),
  web: WebMetaSchema.optional(),
});

/**
 * The exposure a malformed `web` value degrades to: still exposed, from the last time the
 * meta was written, with nothing pre-approved and no searches counted. Failing closed
 * matters more than the lost detail -- a session that read hostile text must not come
 * back looking as if it never did.
 */
function failClosedWeb(meta: Record<string, unknown>): WebMeta {
  return { exposedAt: firstString(meta.updatedAt, meta.createdAt), seenUrls: [], searches: 0 };
}

/** The first of `values` that is a timestamp string; `null` when none is. */
function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) if (typeof value === "string") return value;
  return null;
}

/**
 * Replace a present-but-malformed `web` value with the fail-closed one, before the object
 * schema can reject it. Without this the whole meta would be unreadable
 * (`SESSION_META_UNREADABLE`) and the session's title, cost and history would go with it.
 *
 * The fallback reads the SIBLING `updatedAt` and `createdAt`, so this has to run on the
 * object rather than as a field-level `.catch`. An ABSENT `web` is left exactly as it is:
 * metadata written before the field existed stays readable and stays unexposed.
 */
function preprocessWeb(meta: unknown): unknown {
  if (typeof meta !== "object" || meta === null) return meta;
  const record = meta as Record<string, unknown>;
  if (record.web === undefined) return meta;
  if (WebMetaSchema.safeParse(record.web).success) return meta;
  return { ...record, web: failClosedWeb(record) };
}

export const MetaSchema = z.preprocess(preprocessWeb, MetaObjectSchema);

export type SessionMeta = Readonly<z.infer<typeof MetaSchema>>;

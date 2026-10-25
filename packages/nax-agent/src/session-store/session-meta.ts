import { join } from "node:path";
import { z } from "zod";
import { BashApprovalModeSchema } from "#src/config/bash-approval";

export const SESSION_META_MODES = ["none", "read", "ask", "full"] as const;
export type SessionMetaMode = (typeof SESSION_META_MODES)[number];
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function defaultSessionsDir(configDir: string): string {
  return join(configDir, ".agent-server", "sessions");
}

export const MetaSchema = z.object({
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
});

export type SessionMeta = Readonly<z.infer<typeof MetaSchema>>;

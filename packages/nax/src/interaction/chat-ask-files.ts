import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { NaxError } from "@/errors";
import type { InteractionAction, InteractionRequest } from "./types";

export const CHAT_ASKS_FLAG = "--chat-asks";
export const CHAT_ASK_POLL_MS = 500;
export const RUN_ASK_POLL_MS = 1_000;
export const CHAT_ASK_STALE_MS = 15_000;
const KEY_LENGTH = 16;
const KEY_PATTERN = /^[a-f0-9]{16}$/;
const MAC_PATTERN = /^[a-f0-9]{64}$/;
export type ChatAskSecret = string | Uint8Array;
export interface ChatAnswer {
  requestId: string;
  action: InteractionAction;
  value?: string;
  respondedBy: "chat-user" | "chat-agent";
  reason?: string;
  /** Accept the wire spec's ISO timestamp and InteractionResponse's epoch milliseconds. */
  respondedAt: string | number;
}
export interface ChatSettled {
  requestId: string;
  by: string;
  action: InteractionAction;
  value?: string;
  settledAt: string;
}
export interface ChatAskRecord {
  schemaVersion: 1;
  key: string;
  request: InteractionRequest;
  askedAt: string;
  mac: string;
}
export interface ChatNoticeRecord {
  schemaVersion: 1;
  key: string;
  request: InteractionRequest;
  at: string;
  mac: string;
}
export type ChatAnswerRecord = ChatAnswer & { schemaVersion: 1; mac: string };
export type ChatSettledRecord = ChatSettled & { schemaVersion: 1; mac: string };

export const _chatAskFileDeps = {
  file: Bun.file,
  write: Bun.write,
  rename: renameSync,
  unlink: unlinkSync,
  readdir: readdirSync,
  randomUUID: (): string => crypto.randomUUID(),
};

const actionSchema = z.enum(["approve", "reject", "choose", "input", "skip", "abort"]);
const wireSchema = z.object({ schemaVersion: z.literal(1), mac: z.string().regex(MAC_PATTERN) });
const requestSchema = z
  .object({
    id: z.string(),
    type: z.enum(["confirm", "choose", "input", "review", "notify", "webhook"]),
    featureName: z.string(),
    storyId: z.string().optional(),
    stage: z.enum(["pre-flight", "execution", "review", "merge", "cost", "custom"]),
    summary: z.string(),
    detail: z.string().optional(),
    options: z.array(z.object({ key: z.string(), label: z.string(), description: z.string().optional() })).optional(),
    timeout: z.number().optional(),
    fallback: z.enum(["continue", "skip", "escalate", "abort"]),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.number(),
  })
  .passthrough();
const askSchema = wireSchema.extend({
  key: z.string().regex(KEY_PATTERN),
  request: requestSchema,
  askedAt: z.iso.datetime(),
});
const noticeSchema = wireSchema.extend({
  key: z.string().regex(KEY_PATTERN),
  request: requestSchema,
  at: z.iso.datetime(),
});
const answerSchema = wireSchema.extend({
  requestId: z.string(),
  action: actionSchema,
  value: z.string().optional(),
  respondedBy: z.enum(["chat-user", "chat-agent"]),
  reason: z.string().optional(),
  respondedAt: z.union([z.number(), z.iso.datetime()]),
});
const settledSchema = wireSchema.extend({
  requestId: z.string(),
  by: z.string(),
  action: actionSchema,
  value: z.string().optional(),
  settledAt: z.iso.datetime(),
});

export function chatAskKey(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex").slice(0, KEY_LENGTH);
}

/** Sort recursively, preserving array order and JSON's treatment of optional fields. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

export function signChatRecord(secret: ChatAskSecret, record: object): string {
  const { mac: _mac, ...payload } = record as Record<string, unknown>;
  // Normalize to JSON first so signing and verification see precisely the wire representation.
  const json = JSON.stringify(canonical(JSON.parse(JSON.stringify(payload))));
  return createHmac("sha256", secret).update(json).digest("hex");
}

export function verifyChatRecord(secret: ChatAskSecret, record: unknown): boolean {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
  const mac = "mac" in record ? record.mac : undefined;
  if (typeof mac !== "string" || !MAC_PATTERN.test(mac)) return false;
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(signChatRecord(secret, record), "hex"));
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function removeFile(path: string): void {
  try {
    _chatAskFileDeps.unlink(path);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

/** All writes publish via a unique sibling rename; failed writes never expose partial JSON. */
async function atomicWrite(path: string, record: object): Promise<void> {
  const temp = `${path}.${_chatAskFileDeps.randomUUID()}.tmp`;
  try {
    await _chatAskFileDeps.write(temp, JSON.stringify(record));
    _chatAskFileDeps.rename(temp, path);
  } catch (cause) {
    let cleanupCause: unknown;
    try {
      removeFile(temp);
    } catch (err) {
      cleanupCause = err;
    }
    throw new NaxError(`[chat-asks] Failed to write ${path}`, "CHAT_ASK_WRITE_FAILED", {
      stage: "chat-asks",
      path,
      cause,
      cleanupCause,
    });
  }
}

function recordPath(dir: string, key: string, kind: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new NaxError(`[chat-asks] Invalid key: ${key}`, "CHAT_ASK_INVALID_KEY", { stage: "chat-asks" });
  }
  return join(dir, `${key}.${kind}.json`);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return await _chatAskFileDeps.file(path).json();
  } catch (err) {
    // Disappearing files and malformed JSON are ordinary polling misses, not I/O failures.
    if (isMissing(err) || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

async function readSigned<T>(path: string, secret: ChatAskSecret, schema: z.ZodType<T>): Promise<T | undefined> {
  const raw = await readJson(path);
  if (!verifyChatRecord(secret, raw)) return undefined;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function namesFor(dir: string, kind: string): string[] {
  try {
    return _chatAskFileDeps
      .readdir(dir)
      .filter((name) => new RegExp(`^[a-f0-9]{16}\\.${kind}\\.json$`).test(name))
      .sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

export async function writeChatAsk(
  dir: string,
  request: InteractionRequest,
  now: Date,
  secret: ChatAskSecret,
): Promise<string> {
  const key = chatAskKey(request.id);
  const record = { schemaVersion: 1, key, request, askedAt: now.toISOString() };
  await atomicWrite(recordPath(dir, key, "ask"), { ...record, mac: signChatRecord(secret, record) });
  return key;
}

export async function readChatAsks(dir: string, secret: ChatAskSecret): Promise<ChatAskRecord[]> {
  const records = await Promise.all(
    namesFor(dir, "ask").map(async (name) => {
      const record = await readSigned(join(dir, name), secret, askSchema);
      return record && record.key === chatAskKey(record.request.id) && name === `${record.key}.ask.json`
        ? record
        : undefined;
    }),
  );
  return records.filter((record) => record !== undefined);
}

export async function writeChatAnswer(
  dir: string,
  key: string,
  answer: ChatAnswer,
  secret: ChatAskSecret,
): Promise<void> {
  const record = { ...answer, schemaVersion: 1 };
  await atomicWrite(recordPath(dir, key, "answer"), { ...record, mac: signChatRecord(secret, record) });
}

export async function readChatAnswer(dir: string, key: string, secret: ChatAskSecret): Promise<ChatAnswer | undefined> {
  const record = await readSigned(recordPath(dir, key, "answer"), secret, answerSchema);
  if (!record || chatAskKey(record.requestId) !== key) return undefined;
  const { schemaVersion: _version, mac: _mac, ...answer } = record;
  return answer;
}

export async function writeChatSettled(
  dir: string,
  key: string,
  settled: ChatSettled,
  secret: ChatAskSecret,
): Promise<void> {
  const record = { ...settled, schemaVersion: 1 };
  await atomicWrite(recordPath(dir, key, "settled"), { ...record, mac: signChatRecord(secret, record) });
}

export async function readChatSettled(
  dir: string,
  key: string,
  secret: ChatAskSecret,
): Promise<ChatSettled | undefined> {
  const record = await readSigned(recordPath(dir, key, "settled"), secret, settledSchema);
  if (!record || chatAskKey(record.requestId) !== key) return undefined;
  const { schemaVersion: _version, mac: _mac, ...settled } = record;
  return settled;
}

export async function writeChatNotice(
  dir: string,
  request: InteractionRequest,
  now: Date,
  secret: ChatAskSecret,
): Promise<void> {
  const key = chatAskKey(request.id);
  const record = { schemaVersion: 1, key, request, at: now.toISOString() };
  await atomicWrite(recordPath(dir, key, "notice"), { ...record, mac: signChatRecord(secret, record) });
}

/** A single parent consumes notices; unlink before returning so overlapping ticks cannot deliver twice. */
export async function takeChatNotices(dir: string, secret: ChatAskSecret): Promise<ChatNoticeRecord[]> {
  const records = await Promise.all(
    namesFor(dir, "notice").map(async (name) => {
      const path = join(dir, name);
      const record = await readSigned(path, secret, noticeSchema);
      if (!record || record.key !== chatAskKey(record.request.id) || name !== `${record.key}.notice.json`)
        return undefined;
      try {
        _chatAskFileDeps.unlink(path);
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
      return record;
    }),
  );
  return records.filter((record) => record !== undefined);
}

export async function writeChatHeartbeat(dir: string, now: Date): Promise<void> {
  await atomicWrite(join(dir, "heartbeat.json"), { schemaVersion: 1, at: now.toISOString() });
}

export async function chatHeartbeatFresh(dir: string, nowMs: number): Promise<boolean> {
  const record = await readJson(join(dir, "heartbeat.json"));
  const parsed = z.object({ schemaVersion: z.literal(1), at: z.iso.datetime() }).safeParse(record);
  return parsed.success && nowMs - Date.parse(parsed.data.at) <= CHAT_ASK_STALE_MS;
}

export async function removeChatHeartbeat(dir: string): Promise<void> {
  removeFile(join(dir, "heartbeat.json"));
}

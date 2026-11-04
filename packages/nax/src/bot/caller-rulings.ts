/**
 * Caller-supplied rulings for `nax bot review --rulings <path>`. nax trusts the caller that supplies this
 * file, exactly as it does for `--decisions`: the caller is responsible for who may rule. Applying a ruling
 * goes through the same recorder a writer's thread reply takes (`recordPrRulings`); this module only loads,
 * validates and plans.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { z } from "zod";
import { NaxError } from "@/errors";
import type { PrComment } from "@/forge/pr-types";
import type { SettledItems } from "../workflow/item-thread-state";
import type { PrRuling } from "../workflow/item-threads";
import { parseRulingKeyword } from "../workflow/ruling-keyword";

export interface CallerRuling {
  readonly item: string;
  readonly key?: string;
  readonly ruling: string;
  readonly by: string;
  readonly at: string;
}

export interface CallerRulingsFile {
  readonly version: 1;
  readonly headSha: string;
  readonly rulings: readonly CallerRuling[];
}

export type CallerRulingSkip =
  | "unknown-item"
  | "stale-key"
  | "already-settled"
  | "superseded-by-writer"
  | "echo-failed";
export type CallerRulingsIgnored = "untrusted-pr" | "head-mismatch";

/** Machine-readable account of what a `--rulings` file did; present in the review artifact. */
export interface CallerRulingsReport {
  readonly applied: readonly { readonly item: string; readonly disposition: PrRuling["disposition"] }[];
  readonly skipped: readonly { readonly item: string; readonly reason: CallerRulingSkip }[];
  readonly ignored?: CallerRulingsIgnored;
}

const MAX_FILE_BYTES = 262_144;
const MAX_RULINGS = 100;
const MAX_RULING_LENGTH = 2_000;
const MAX_BY_LENGTH = 100;

export const _callerRulingsDeps = {
  fileSize: async (path: string): Promise<number> => (await Bun.file(path).stat()).size,
  readText: (path: string): Promise<string> => Bun.file(path).text(),
};

const CallerRulingsSchema = z.object({
  version: z.literal(1),
  headSha: z.string().regex(/^[a-fA-F0-9]{40}$/),
  rulings: z
    .array(
      z.object({
        item: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
        key: z
          .string()
          .regex(/^w-[A-Za-z0-9._:-]+\.[a-f0-9]{8}$/)
          .optional(),
        ruling: z
          .string()
          .min(1)
          .max(MAX_RULING_LENGTH)
          .refine((text) => parseRulingKeyword(text) !== null, {
            message: "ruling must start with fixed <sha>, waive: <reason>, confirm, override: <reason> or verified",
          }),
        by: z
          .string()
          .min(1)
          .max(MAX_BY_LENGTH)
          .regex(/^[^\r\n]+$/, "by must be a single line"),
        at: z.iso.datetime({ offset: true }),
      }),
    )
    .max(MAX_RULINGS)
    .superRefine((rulings, ctx) => {
      const seen = new Set<string>();
      for (const { item } of rulings) {
        if (seen.has(item)) {
          ctx.addIssue({ code: "custom", message: `duplicate item ${item}` });
          return;
        }
        seen.add(item);
      }
    }),
});

function invalidFile(path: string, problem: string, cause?: unknown): NaxError {
  return new NaxError(`[bot] Invalid rulings file ${path}: ${problem}`, "BOT_RULINGS_INVALID", {
    stage: "bot",
    path,
    cause,
  });
}

function readFailed(path: string, cause: unknown): NaxError {
  return new NaxError(`[bot] Cannot read rulings file ${path}`, "BOT_RULINGS_READ_FAILED", {
    stage: "bot",
    path,
    cause,
  });
}

async function readBoundedText(path: string): Promise<string> {
  let size: number;
  try {
    size = await _callerRulingsDeps.fileSize(path);
  } catch (cause) {
    throw readFailed(path, cause);
  }
  if (size > MAX_FILE_BYTES) throw invalidFile(path, `file exceeds ${MAX_FILE_BYTES} bytes`);
  try {
    return await _callerRulingsDeps.readText(path);
  } catch (cause) {
    throw readFailed(path, cause);
  }
}

export async function loadCallerRulings(path: string): Promise<CallerRulingsFile> {
  const text = await readBoundedText(path);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw invalidFile(path, errorMessage(cause), cause);
  }
  const result = CallerRulingsSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw invalidFile(path, first ? first.message : result.error.message, result.error);
  }
  return result.data;
}

export function ignoredCallerRulings(reason: CallerRulingsIgnored): CallerRulingsReport {
  return { applied: [], skipped: [], ignored: reason };
}

type OpenRulingItem = SettledItems["open"][number];

export interface CallerRulingsPlan {
  readonly candidates: ReadonlyMap<OpenRulingItem, PrRuling>;
  readonly skipped: CallerRulingsReport["skipped"];
}

/** A kept reply is an authorized writer's; it wins when it carries a ruling and is not older than the caller's. */
function writerRuledAfter(item: OpenRulingItem, at: string): boolean {
  const callerMs = Date.parse(at);
  const later = (reply: PrComment) => !(Date.parse(reply.createdAt) <= callerMs); // NaN fails closed
  return item.kept.some((reply) => parseRulingKeyword(reply.body) !== null && later(reply));
}

function candidate(item: OpenRulingItem, entry: CallerRuling): PrRuling | null {
  const keyword = parseRulingKeyword(entry.ruling);
  if (!keyword) return null;
  return { ...keyword, itemKey: item.key, itemId: item.itemId, by: null, callerBy: entry.by };
}

/** Decide, per caller ruling, whether it becomes a candidate for its item. Pure; the recorder posts. */
export function planCallerRulings(rulings: readonly CallerRuling[], state: SettledItems): CallerRulingsPlan {
  const candidates = new Map<OpenRulingItem, PrRuling>();
  const skipped: { item: string; reason: CallerRulingSkip }[] = [];
  for (const entry of rulings) {
    const byId = (item: { itemId: string }) => item.itemId === entry.item;
    const matches = (item: { itemId: string; key: string }) =>
      byId(item) && (entry.key === undefined || item.key === entry.key);
    const known = [...state.settled, ...state.open].filter(byId);
    const open = state.open.find(matches);
    const settled = state.settled.find(matches);
    if (known.length === 0) skipped.push({ item: entry.item, reason: "unknown-item" });
    else if (!open && !settled) skipped.push({ item: entry.item, reason: "stale-key" });
    else if (!open) skipped.push({ item: entry.item, reason: "already-settled" });
    else if (writerRuledAfter(open, entry.at)) skipped.push({ item: entry.item, reason: "superseded-by-writer" });
    else {
      const ruling = candidate(open, entry);
      if (ruling) candidates.set(open, ruling);
    }
  }
  return { candidates, skipped };
}

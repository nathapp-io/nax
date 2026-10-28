/** Pure wire formats for durable workflow PR item threads. Posting and ownership live elsewhere. */
import { createHash } from "node:crypto";
import { NaxError } from "@/errors";
import { isNaxBotMarkerKey, NAX_BOT_HEADER, parseNaxBotMarker } from "@/forge";
import { RULING_SHA_PATTERN, RULING_SHA_SOURCE } from "@/utils/ruling-sha";
import type { Disposition } from "./decisions-sidecar";
import { safeInline } from "./pr-body-safe";
import type { OpenItem } from "./types";

export interface PrRuling {
  readonly itemKey: string;
  readonly itemId: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly sha?: string;
  readonly by: string | null;
}

export interface ItemIndex {
  readonly reviewedHead?: string;
  readonly reviewedBase?: string;
  readonly keys: readonly string[];
}

const HASH_CHARS = 8;
const SHORT_SHA_CHARS = 7;
const MAX_REPLY_ID_CHARS = 20;
const ITEM_KEY_PATTERN = /^w-([A-Za-z0-9._:-]+)\.[a-f0-9]{8}$/;
const SHA_PATTERN = /^[a-fA-F0-9]{40}$/;
const REPLY_INSTRUCTION =
  "Rule on it by replying: fixed <sha>, waive: <reason>, confirm, override: <reason>, or verified. Any other reply from a collaborator is read as a ruling only when its meaning is clear.";
const CHANGE_INSTRUCTION = "To change it, reply on this thread.";
// Exhaustive type-checked vocabularies without importing the sidecar's I/O implementation.
const DISPOSITION_NAMES = {
  fixed: true,
  waived: true,
  confirmed: true,
  overridden: true,
  verified: true,
} satisfies Record<Disposition, boolean>;
const KIND_NAMES = {
  finding: true,
  ruling: true,
  "cannot-verify": true,
  gate: true,
  advisor: true,
  story: true,
  ci: true,
  reason: true,
} satisfies Record<OpenItem["kind"], boolean>;

/**
 * Rulings a re-raise cancels. `waived`, `confirmed` and `overridden` carry over when the same item is raised
 * again: they are the reviewer's standing judgement on the item, not a statement that it is gone.
 */
export const REOPENED_BY_RERAISE: ReadonlySet<Disposition> = new Set<Disposition>([
  "fixed",
  "verified",
] satisfies readonly Disposition[]);

export function itemKey(item: OpenItem): string {
  const hash = createHash("sha256").update(`${item.kind}\n${item.issue}`).digest("hex").slice(0, HASH_CHARS);
  return `w-${item.id}.${hash}`;
}

export function isPostable(item: OpenItem): boolean {
  return isNaxBotMarkerKey(item.id) && isNaxBotMarkerKey(askKey(itemKey(item), "0".repeat(MAX_REPLY_ID_CHARS)));
}

/** Unwrapped body; callers apply withNaxBotMarker with itemKey(item). */
export function renderItemOpener(item: OpenItem): string {
  return [
    `Open item **${item.id}** (${item.kind}): ${safeInline(item.issue)}`,
    ...(item.suggestion ? [`Suggestion: ${safeInline(item.suggestion)}`] : []),
    ...(item.ruling ? [`Advisor: ${safeInline(item.ruling.action)} — ${safeInline(item.ruling.why)}`] : []),
    REPLY_INSTRUCTION,
  ].join("\n");
}

/** Accept raw render output or a forge-marked comment; this does not establish ownership. */
function bodyLines(body: string): string[] {
  const lines = body.split(/\r?\n/);
  if (lines[0] !== NAX_BOT_HEADER) return lines;
  if (!parseNaxBotMarker(body)) return [];
  return lines.slice(2, -2);
}

export function parseItemOpener(body: string): Pick<OpenItem, "id" | "kind" | "issue"> | null {
  const match = /^Open item \*\*([A-Za-z0-9._:-]+)\*\* \(([^)]+)\): (.*)$/.exec(bodyLines(body)[0] ?? "");
  const kind = match?.[2] ?? "";
  if (!match?.[1] || !isOpenItemKind(kind)) return null;
  return { id: match[1], kind, issue: match[3] ?? "" };
}

export function isOpenItemKind(kind: string): kind is OpenItem["kind"] {
  return Object.hasOwn(KIND_NAMES, kind);
}

export function renderRulingEcho(ruling: PrRuling): string {
  if (ruling.disposition === "fixed" && (!ruling.sha || !RULING_SHA_PATTERN.test(ruling.sha))) {
    throw new NaxError("[workflow] Fixed ruling requires a valid sha", "WORKFLOW_RULING_INVALID", {
      stage: "workflow",
    });
  }
  const recorded =
    ruling.disposition === "fixed" ? `fixed in ${ruling.sha?.slice(0, SHORT_SHA_CHARS) ?? ""}` : ruling.disposition;
  return [
    `Recorded: ${recorded} — ${safeInline(ruling.reason)}`,
    ruling.by === null ? "By nax bot" : `By @${ruling.by}`,
    CHANGE_INSTRUCTION,
  ].join("\n");
}

function isDisposition(value: string): value is Disposition {
  return Object.hasOwn(DISPOSITION_NAMES, value);
}

export function parseRulingEcho(key: string, body: string): PrRuling | null {
  const marker = parseNaxBotMarker(`<!-- nax-bot:v1 key=${key} -->`);
  const keyParts = /^wr-([a-z]+)-(w-.+)$/.exec(key);
  const disposition = keyParts?.[1] ?? "";
  const item = ITEM_KEY_PATTERN.exec(keyParts?.[2] ?? "");
  if (marker?.key !== key || !isDisposition(disposition) || !item?.[1]) return null;
  const [recorded, author, instruction, ...extra] = bodyLines(body);
  const line = new RegExp(`^Recorded: ([a-z]+)(?: in (${RULING_SHA_SOURCE}))? — (.+)$`).exec(recorded ?? "");
  const login = /^By @([A-Za-z0-9_.-]+)$/.exec(author ?? "")?.[1];
  if (!line || line[1] !== disposition || !line[3]?.trim() || instruction !== CHANGE_INSTRUCTION || extra.length)
    return null;
  if ((disposition === "fixed") !== (line[2] !== undefined)) return null;
  if (author !== "By nax bot" && !login) return null;
  return {
    itemKey: keyParts?.[2] ?? "",
    itemId: item[1],
    disposition,
    reason: line[3],
    by: login ?? null,
    ...(line[2] === undefined ? {} : { sha: line[2] }),
  };
}

export function askKey(key: string, replyId: string): string {
  return `wq-${key}-${replyId}`;
}

export function renderRulingAsk(): string {
  return "I could not read a ruling from that reply. Start a reply with fixed <sha>, waive: <reason>, confirm, override: <reason> or verified.";
}

export function closedKey(key: string): string {
  return `wc-${key}`;
}

export function renderItemClosed(sha: string): string {
  return `No longer open in the run at ${sha.slice(0, SHORT_SHA_CHARS)}.`;
}

/**
 * Marker key of the notice that supersedes a cancelled ruling. `readThread` reads a ruling only from the last own
 * marked comment, so posting the notice after a `wr-` echo leaves the item unruled until someone rules again.
 */
export function reopenKey(key: string): string {
  return `wo-${key}`;
}

/** Unwrapped body; callers apply withNaxBotMarker with reopenKey(key). */
export function renderItemReopened(sha: string): string {
  return `Raised again by the run at ${sha.slice(0, SHORT_SHA_CHARS)}. Reply on this thread to rule on it.`;
}

function validSha(sha: string | undefined): string | undefined {
  return sha !== undefined && SHA_PATTERN.exec(sha)?.[0] === sha ? sha : undefined;
}

export function renderItemIndex(index: ItemIndex): string {
  const head = validSha(index.reviewedHead);
  const base = head ? validSha(index.reviewedBase) : undefined;
  return [
    `nax workflow open items: ${index.keys.length}`,
    `Reviewed head: ${head ?? "none"}`,
    ...(base ? [`Reviewed base: ${base}`] : []),
    ...index.keys.map((key) => `- ${key}`),
  ].join("\n");
}

export function parseItemIndex(body: string): ItemIndex | null {
  const [countLine, headLine, ...rest] = bodyLines(body);
  const count = /^nax workflow open items: (\d+)$/.exec(countLine ?? "")?.[1];
  if (count === undefined || !headLine?.startsWith("Reviewed head: ")) return null;
  const head = validSha(headLine.slice("Reviewed head: ".length));
  const baseLine = rest[0]?.startsWith("Reviewed base: ") ? rest.shift() : undefined;
  const base = head && baseLine ? validSha(baseLine.slice("Reviewed base: ".length)) : undefined;
  // Preserve even unpostable item keys: their presence must continue to hold readiness closed.
  if (rest.some((line) => !line.startsWith("- ")) || rest.length !== Number(count)) return null;
  return {
    keys: rest.map((line) => line.slice(2)),
    ...(head ? { reviewedHead: head } : {}),
    ...(base ? { reviewedBase: base } : {}),
  };
}

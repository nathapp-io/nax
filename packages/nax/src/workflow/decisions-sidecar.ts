/**
 * The decisions sidecar (SPEC-workflow-record-promote, US-001): the rulings a human records for one
 * run's open items, written by `nax workflow record` and read back by `nax workflow promote`.
 * One sidecar belongs to a run — `<feature>/workflow/<runId>/decisions-<isoStamp>.json`, next to
 * that run's `result.json` — and the file is git-ignored, so the commands leave it uncommitted.
 *
 * Every entry is validated before anything is written: the vocabulary, the one-line reason, the sha
 * `fixed` requires, and the open item an id names. A sidecar read back is validated the same way
 * before it is trusted: a hand-edited or truncated file is refused rather than read as a run with no
 * rulings, and a caller cross-checks the entries it holds against the run's open items
 * (`checkEntriesAgainstItems`). Writes go to a temporary sibling unique to the call and are renamed
 * over the target, so two writers never publish each other's file and a reader never sees a partial
 * one. The two I/O helpers go through `_sidecarDeps`, mirroring the `result.ts` seam.
 */
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { byCodePoint, errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { OpenItem } from "./types";

export const _sidecarDeps = { mkdir, readdir, rename, unlink };

export const DISPOSITIONS = ["fixed", "waived", "confirmed", "overridden", "verified"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const SIDECAR_OUTCOMES = ["pending", "promoted", "verified-ready", "abandoned"] as const;
export type SidecarOutcome = (typeof SIDECAR_OUTCOMES)[number];

export const SIDECAR_KINDS = ["finding", "advisor", "gate", "ci", "story", "cannot-verify", "minor", "reason"] as const;
export type SidecarKind = (typeof SIDECAR_KINDS)[number];

export interface DecisionEntry {
  readonly id: string;
  readonly kind: SidecarKind;
  readonly disposition: Disposition;
  /** One non-empty line. */
  readonly reason: string;
  /** 7 to 40 hex characters; required when disposition is "fixed". */
  readonly sha?: string;
}

export interface DecisionsSidecar {
  /** "<runId>/result.json" */
  readonly artifact: string;
  readonly feature: string;
  /** UTC ISO-8601 with ":" and "." replaced by "-", e.g. "2026-10-13T09-12-00-417Z". */
  readonly resumedAt: string;
  readonly reasons: readonly string[];
  readonly decisions: readonly DecisionEntry[];
  readonly outcome: SidecarOutcome;
  readonly url?: string;
}

interface FoundSidecar {
  readonly path: string;
  readonly sidecar: DecisionsSidecar;
}

const DECISIONS_INVALID = "WORKFLOW_DECISIONS_INVALID";
const SIDECAR_PREFIX = "decisions-";
const SIDECAR_SUFFIX = ".json";
/** Temporary siblings are named `<sidecar>.tmp-<uuid>`: unique per call, and never read as a sidecar. */
const TMP_INFIX = ".tmp-";
const SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;
const KIND_NAMES: ReadonlySet<string> = new Set(SIDECAR_KINDS);
const DISPOSITION_NAMES: ReadonlySet<string> = new Set(DISPOSITIONS);
const OUTCOME_NAMES: ReadonlySet<string> = new Set(SIDECAR_OUTCOMES);

function invalid(message: string): NaxError {
  return new NaxError(message, DECISIONS_INVALID, { stage: "workflow" });
}

const isSidecarKind = (value: unknown): value is SidecarKind => typeof value === "string" && KIND_NAMES.has(value);

const isDisposition = (value: unknown): value is Disposition =>
  typeof value === "string" && DISPOSITION_NAMES.has(value);

const isOutcome = (value: unknown): value is SidecarOutcome => typeof value === "string" && OUTCOME_NAMES.has(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** `line two` after a newline is a second line, and a blank or spaces-only reason is no line at all. */
const isOneLine = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);

/** A JSON object as it arrived, before any field is validated; null for anything else. */
function fieldsOf(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * A sha belongs to `fixed` only. The shape is checked first, so a malformed sha is named as
 * malformed whether or not its disposition allows one at all.
 */
function checkSha(sha: unknown, id: string, disposition: Disposition): void {
  if (sha === undefined) {
    if (disposition === "fixed") throw invalid(`decision ${id}: disposition fixed requires a sha`);
    return;
  }
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw invalid(`decision ${id}: sha must be 7 to 40 hex characters`);
  }
  if (disposition !== "fixed") throw invalid(`decision ${id}: sha is only allowed when disposition is fixed`);
}

/** Validates one entry in place. `position` is its 1-based index, used while there is no id to name. */
function parseEntry(raw: unknown, position: number): DecisionEntry {
  const fields = fieldsOf(raw);
  const id = fields?.id;
  if (typeof id !== "string" || id === "") throw invalid(`decision ${position}: id must be a non-empty string`);
  const kind = fields?.kind;
  if (!isSidecarKind(kind)) {
    throw invalid(`decision ${id}: kind must be one of ${SIDECAR_KINDS.join(", ")}`);
  }
  const disposition = fields?.disposition;
  if (!isDisposition(disposition)) {
    throw invalid(`decision ${id}: disposition must be one of ${DISPOSITIONS.join(", ")}`);
  }
  if (!isOneLine(fields?.reason)) throw invalid(`decision ${id}: reason must be one non-empty line`);
  checkSha(fields?.sha, id, disposition);
  return raw as DecisionEntry;
}

/**
 * The entries of a decisions file — a JSON array, never an object. Throws
 * `WORKFLOW_DECISIONS_INVALID` on the first entry that does not validate, so a caller can refuse the
 * whole file before it writes anything.
 */
export function parseDecisionEntries(raw: unknown): DecisionEntry[] {
  if (!Array.isArray(raw)) throw invalid("decisions must be a JSON array");
  const entries: DecisionEntry[] = [];
  const seen = new Set<string>();
  for (const [position, value] of raw.entries()) {
    const entry = parseEntry(value, position + 1);
    if (seen.has(entry.id)) throw invalid(`decision ${entry.id} appears twice`);
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

/** An open item of kind `ruling` is an `advisor` entry; every other item kind is its own entry kind. */
export function sidecarKindFor(item: OpenItem): SidecarKind {
  return item.kind === "ruling" ? "advisor" : item.kind;
}

function openIds(items: readonly OpenItem[]): string {
  return items.length === 0 ? "none" : items.map((item) => item.id).join(", ");
}

/**
 * Every entry must name an open item of the run, and its kind must match that item's own. The one
 * exception is an entry of kind `ci` or `minor`: the finishing tool tracks live CI checks and
 * fix-now minors that the run's verdict does not list, so those two kinds may name an id that is no
 * open item. When such an entry does name one, the kind comparison still applies.
 */
export function checkEntriesAgainstItems(entries: readonly DecisionEntry[], items: readonly OpenItem[]): void {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  for (const entry of entries) {
    const item = byId.get(entry.id);
    if (item === undefined) {
      if (entry.kind === "ci" || entry.kind === "minor") continue;
      throw invalid(`unknown item ${entry.id}; open items: ${openIds(items)}`);
    }
    if (sidecarKindFor(item) !== entry.kind) {
      throw invalid(`decision ${entry.id} has kind ${entry.kind} but the open item is ${item.kind}`);
    }
  }
}

/** `incoming` by id over `existing`: a named entry replaces in place, an unseen one is appended. */
export function mergeDecisions(
  existing: readonly DecisionEntry[],
  incoming: readonly DecisionEntry[],
): DecisionEntry[] {
  const byId = new Map<string, DecisionEntry>();
  const order: string[] = [];
  for (const entry of [...existing, ...incoming]) {
    if (!byId.has(entry.id)) order.push(entry.id);
    byId.set(entry.id, entry);
  }
  return order.flatMap((id) => {
    const entry = byId.get(id);
    return entry === undefined ? [] : [entry];
  });
}

/** The `resumedAt` / file-name timestamp form: UTC ISO-8601 with ":" and "." replaced by "-". */
export function isoStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function sidecarFileName(date: Date): string {
  return `${SIDECAR_PREFIX}${isoStamp(date)}${SIDECAR_SUFFIX}`;
}

/** A persisted file that carries the sidecar name but not a sidecar: the path makes it actionable. */
function invalidSidecar(path: string, detail: string): NaxError {
  return invalid(`invalid decisions sidecar ${path}: ${detail}`);
}

/** The entries of a persisted sidecar, with the entry's own message kept and the file it sits in named. */
function parsePersistedEntries(raw: unknown, path: string): DecisionEntry[] {
  try {
    return parseDecisionEntries(raw);
  } catch (err) {
    throw invalidSidecar(path, errorMessage(err));
  }
}

/**
 * A persisted sidecar, every field checked before it is trusted. `newestSidecar` publishes what this
 * returns as a `DecisionsSidecar`, so a file that only looks like one — a hand-written entry, a
 * truncated write — must fail here: reading it back with a field missing would silently drop a
 * ruling, and reading an unchecked entry would let one reach the forge.
 */
function parseSidecar(raw: unknown, path: string): DecisionsSidecar {
  const fields = fieldsOf(raw);
  if (fields === null) throw invalidSidecar(path, "not a JSON object");
  const { artifact, feature, resumedAt, reasons, outcome, url } = fields;
  if (!isNonEmptyString(artifact)) throw invalidSidecar(path, "artifact must be a non-empty string");
  if (!isNonEmptyString(feature)) throw invalidSidecar(path, "feature must be a non-empty string");
  if (!isNonEmptyString(resumedAt)) throw invalidSidecar(path, "resumedAt must be a non-empty string");
  if (!isStringArray(reasons)) throw invalidSidecar(path, "reasons must be an array of strings");
  if (url !== undefined && typeof url !== "string") throw invalidSidecar(path, "url must be a string");
  if (!isOutcome(outcome)) throw invalidSidecar(path, `outcome must be one of ${SIDECAR_OUTCOMES.join(", ")}`);
  const decisions = parsePersistedEntries(fields.decisions, path);
  return { artifact, feature, resumedAt, reasons, decisions, outcome, ...(url === undefined ? {} : { url }) };
}

/** The parsed sidecar. Anything a matching file holds that is not one throws, rather than reading empty. */
async function readSidecar(path: string): Promise<DecisionsSidecar> {
  let parsed: unknown;
  try {
    parsed = await Bun.file(path).json();
  } catch {
    throw invalidSidecar(path, "unreadable or not valid JSON");
  }
  return parseSidecar(parsed, path);
}

/** The run's `decisions-*.json` names, newest first — the timestamp the name encodes is the order. */
async function sidecarNames(runDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await _sidecarDeps.readdir(runDir);
  } catch {
    return [];
  }
  const sidecars = names.filter((name) => name.startsWith(SIDECAR_PREFIX) && name.endsWith(SIDECAR_SUFFIX));
  return sidecars.sort((a, b) => byCodePoint(b, a));
}

/**
 * The newest sidecar of a run, or null when the run has none. The name carries the order, so the
 * newest match is the run's current sidecar and is the one read: a file that wears the name but
 * holds no valid sidecar is refused, never skipped — falling back to an older file would report
 * rulings the run no longer stands behind, and reading a broken one would hide a ruling that is
 * there. A caller that needs the entries checked against the run's own items calls
 * `checkEntriesAgainstItems` on what this returns.
 */
export async function newestSidecar(runDir: string): Promise<FoundSidecar | null> {
  const newest = (await sidecarNames(runDir))[0];
  if (newest === undefined) return null;
  const path = join(runDir, newest);
  return { path, sidecar: await readSidecar(path) };
}

/** No two writes may share a temporary name: one rename would publish the file the other is writing. */
const tempSibling = (path: string): string => `${path}${TMP_INFIX}${crypto.randomUUID()}`;

/** Best-effort removal of this call's temporary file; the write's own error is the one to report. */
async function discard(path: string): Promise<void> {
  try {
    await _sidecarDeps.unlink(path);
  } catch {
    // already gone, or the rename published it
  }
}

/**
 * Writes the sidecar through a temporary sibling and renames it over `path`. The sibling is unique
 * to this call, so concurrent writers never share a file — each publishes its own, whole — and a
 * failed write removes its own temporary file instead of leaving it in the run directory.
 */
export async function writeSidecar(path: string, sidecar: DecisionsSidecar): Promise<void> {
  await _sidecarDeps.mkdir(dirname(path), { recursive: true });
  const tmp = tempSibling(path);
  try {
    await Bun.write(tmp, `${JSON.stringify(sidecar, null, 2)}\n`);
    await _sidecarDeps.rename(tmp, path);
  } catch (err) {
    await discard(tmp);
    throw err;
  }
}

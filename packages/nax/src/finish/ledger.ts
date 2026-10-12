import type { Finding, FindingDisposition } from "./types";

/** A finding's stable identity across rounds: source, title and file (no message text). */
export function findingId(f: Finding): string {
  return `${f.source ?? "quality"}|${f.title}|${f.file ?? ""}`.toLowerCase();
}

export type LedgerState =
  | "open"
  | "fixed-unreviewed"
  | "fixed-reviewed"
  | "cleared"
  | "rejected"
  | "set-aside"
  | "waived"
  | "superseded"
  | "unresolved"
  | "accepted";

export interface LedgerEntry {
  id: string;
  finding: Finding;
  state: LedgerState;
  ref?: string;
}

export type LedgerEvent =
  | { kind: "raised"; findings: Finding[] }
  | { kind: "fixed"; findings: Finding[]; dispositions: FindingDisposition[]; sha: string }
  | { kind: "set-aside"; findings: Finding[]; handoff: string }
  | { kind: "ruled"; finding: Finding; state: "waived" | "superseded" | "unresolved"; ref?: string }
  | { kind: "full-round"; raised: Finding[]; round?: number }
  | { kind: "accepted"; findings: Finding[]; ref: string }
  /** 4.3: a continued attempt committed, so the handoff's findings (exact ledger ids) leave `set-aside` and follow the normal flow. */
  | { kind: "handoff-consumed"; ids: string[]; handoff: string };

export const OPEN_STATES: ReadonlySet<LedgerState> = new Set(["open", "rejected", "set-aside", "unresolved"]);
const STICKY: ReadonlySet<LedgerState> = new Set(["waived", "superseded", "accepted"]);

function upsert(ledger: readonly LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  const i = ledger.findIndex((e) => e.id === entry.id);
  return i < 0 ? [...ledger, entry] : ledger.map((e, j) => (j === i ? entry : e));
}

function set(ledger: readonly LedgerEntry[], f: Finding, state: LedgerState, ref?: string): LedgerEntry[] {
  return upsert(ledger, { id: findingId(f), finding: f, state, ...(ref !== undefined ? { ref } : {}) });
}

function raise(ledger: readonly LedgerEntry[], findings: Finding[]): LedgerEntry[] {
  return findings.reduce<LedgerEntry[]>(
    (acc, f) => {
      const prior = acc.find((e) => e.id === findingId(f));
      return prior && STICKY.has(prior.state) ? acc : set(acc, f, "open");
    },
    [...ledger],
  );
}

function fixed(ledger: readonly LedgerEntry[], ev: Extract<LedgerEvent, { kind: "fixed" }>): LedgerEntry[] {
  return ev.findings.reduce<LedgerEntry[]>(
    (acc, f, i) => {
      const d = ev.dispositions.find((x) => x.index === i + 1);
      if (d?.disposition === "fixed") return set(acc, f, "fixed-unreviewed", ev.sha);
      if (d?.disposition === "rejected") return set(acc, f, "rejected", d.evidence);
      return set(acc, f, "open");
    },
    [...ledger],
  );
}

/**
 * A full round (both lenses present) settles what it does not raise again: a fixed-unreviewed entry is
 * reviewed; an `open` or `rejected` one is `cleared` (it was never fixed, so `fixed-reviewed` would be
 * untrue). `set-aside`, `unresolved` and sticky entries are left alone.
 */
function fullRound(ledger: readonly LedgerEntry[], raised: Finding[], round?: number): LedgerEntry[] {
  const again = new Set(raised.map(findingId));
  const ref = round !== undefined ? `not re-raised by full round ${round}` : "not re-raised by a full round";
  return ledger.map((e) => {
    if (again.has(e.id)) return e;
    if (e.state === "fixed-unreviewed") return { ...e, state: "fixed-reviewed" as const };
    if (e.state === "open" || e.state === "rejected") return { ...e, state: "cleared" as const, ref };
    return e;
  });
}

const setAll = (ledger: readonly LedgerEntry[], findings: Finding[], state: LedgerState, ref: string): LedgerEntry[] =>
  findings.reduce<LedgerEntry[]>((acc, f) => set(acc, f, state, ref), [...ledger]);

/**
 * Only an entry still `set-aside` under this handoff moves (to `open`): a later ruling, an acceptance or a
 * different handoff's hold stays as it is. Matching is by exact ledger id, never by title.
 */
function handoffConsumed(
  ledger: readonly LedgerEntry[],
  ev: Extract<LedgerEvent, { kind: "handoff-consumed" }>,
): LedgerEntry[] {
  const ids = new Set(ev.ids);
  return ledger.map((e) => {
    if (e.state !== "set-aside" || e.ref !== ev.handoff || !ids.has(e.id)) return e;
    const { ref: _ref, ...rest } = e;
    return { ...rest, state: "open" as const };
  });
}

/** A hold never overwrites an earlier waive / supersede / accept of the same finding. */
function ruled(ledger: readonly LedgerEntry[], ev: Extract<LedgerEvent, { kind: "ruled" }>): LedgerEntry[] {
  const prior = ledger.find((e) => e.id === findingId(ev.finding));
  if (ev.state === "unresolved" && prior && STICKY.has(prior.state)) return [...ledger];
  return set(ledger, ev.finding, ev.state, ev.ref);
}

/** Pure: returns a new ledger; never mutates `ledger`. */
export function applyLedgerEvent(ledger: readonly LedgerEntry[], ev: LedgerEvent): LedgerEntry[] {
  switch (ev.kind) {
    case "raised":
      return raise(ledger, ev.findings);
    case "fixed":
      return fixed(ledger, ev);
    case "set-aside":
      return setAll(ledger, ev.findings, "set-aside", ev.handoff);
    case "ruled":
      return ruled(ledger, ev);
    case "full-round":
      return fullRound(ledger, ev.raised, ev.round);
    case "accepted":
      return setAll(ledger, ev.findings, "accepted", ev.ref);
    case "handoff-consumed":
      return handoffConsumed(ledger, ev);
  }
}

export function openFindings(ledger: readonly LedgerEntry[]): Finding[] {
  return ledger.filter((e) => OPEN_STATES.has(e.state)).map((e) => e.finding);
}

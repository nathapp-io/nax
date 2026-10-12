import type { Finding, FindingDisposition } from "./types";

/** A finding's stable identity across rounds: source, title and file (no message text). */
export function findingId(f: Finding): string {
  return `${f.source ?? "quality"}|${f.title}|${f.file ?? ""}`.toLowerCase();
}

export type LedgerState =
  | "open"
  | "fixed-unreviewed"
  | "fixed-reviewed"
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
  | { kind: "full-round"; raised: Finding[] }
  | { kind: "accepted"; findings: Finding[]; ref: string };

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

function fullRound(ledger: readonly LedgerEntry[], raised: Finding[]): LedgerEntry[] {
  const again = new Set(raised.map(findingId));
  return ledger.map((e) =>
    e.state === "fixed-unreviewed" && !again.has(e.id) ? { ...e, state: "fixed-reviewed" as const } : e,
  );
}

const setAll = (ledger: readonly LedgerEntry[], findings: Finding[], state: LedgerState, ref: string): LedgerEntry[] =>
  findings.reduce<LedgerEntry[]>((acc, f) => set(acc, f, state, ref), [...ledger]);

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
      return fullRound(ledger, ev.raised);
    case "accepted":
      return setAll(ledger, ev.findings, "accepted", ev.ref);
  }
}

export function openFindings(ledger: readonly LedgerEntry[]): Finding[] {
  return ledger.filter((e) => OPEN_STATES.has(e.state)).map((e) => e.finding);
}

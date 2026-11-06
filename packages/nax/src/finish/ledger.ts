import type { Finding } from "./types";

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

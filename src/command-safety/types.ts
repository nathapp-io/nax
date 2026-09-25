/**
 * P5 command-safety shadow: shared types.
 *
 * Spec: docs/superpowers/specs/2026-09-23-p5-command-safety-shadow-design.md.
 * Observational only. Nothing typed here can change a verdict, delay a call or
 * fail a call; the types exist so the row a later decision reads is exact.
 */

import type { CallIdentifiers } from "./identifiers";

/** The six harm categories. Also the ids of the six `noul` questions. */
export const QUESTION_IDS = [
  "deletes_data",
  "discards_work",
  "outside_project",
  "system_change",
  "network_send",
  "privilege",
] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

/** Options of the single `harm` choice question: `none` plus every category. */
export const HARM_OPTIONS = ["none", ...QUESTION_IDS] as const;
export type HarmOption = (typeof HARM_OPTIONS)[number];

/** The mechanical policy verdict, as recorded (never re-decided) by the shadow. */
export interface MechanicalVerdict {
  readonly verdict: "allow" | "ask" | "deny";
  readonly breach: boolean;
  readonly rule?: string;
}

/** The tool-audit ledger outcome of the call. */
export type LedgerOutcome = "ok" | "error" | "denied" | "denied:ask";

export interface FinalOutcome {
  readonly ledger: LedgerOutcome;
  readonly decidedBy?: string;
}

export interface ModelAnswers {
  /** P(option) for the harm choice. */
  readonly harm: Readonly<Record<HarmOption, number>>;
  /** P(yes) per noul question. */
  readonly noul: Readonly<Record<QuestionId, number>>;
}

export type ModelResult =
  | {
      readonly status: "answered";
      readonly answers: ModelAnswers;
      readonly model?: string;
      readonly decisionId?: string;
      readonly latencyMs: number;
    }
  | { readonly status: "blocked"; readonly decisionId?: string; readonly latencyMs: number }
  | { readonly status: "oversize"; readonly latencyMs: number }
  | { readonly status: "unavailable"; readonly error: string; readonly latencyMs?: number };

/** One agent-authored command, as observed right after `policy.check`. */
export interface Observation extends CallIdentifiers {
  readonly command: string;
  readonly identity: "Bash" | "Exec";
  /** Exec only: the argv verbatim. `command` is it joined with single spaces. */
  readonly argv?: readonly string[];
  readonly stage: string;
  readonly storyId?: string;
  readonly mechanical: MechanicalVerdict;
  /**
   * Bash only: the directory the command starts in (the policy root). An
   * Exec call's cwd is chosen by the tool, so it arrives with `ExecRun`.
   */
  readonly cwd?: string;
}

/** Exec only: what the tool actually ran, known once it has run. */
export interface ExecRun {
  /** The argv after normalization. */
  readonly executed: readonly string[];
  /**
   * The directory it ran in (the package dir or the repo root). The Exec
   * branch always sets it; optional because `audit` is shared with tools
   * (Bash, Git) that report `executed` without a cwd.
   */
  readonly cwd?: string;
}

/** Per-story shadow. Every method is total: it never throws. */
export interface CommandShadow {
  observe(key: string, obs: Observation): void;
  /**
   * Attach the ledger outcome and, for an Exec call, what actually ran. `run`
   * is omitted for every other identity and whenever the call never ran.
   */
  settle(key: string, outcome: FinalOutcome, run?: ExecRun): void;
  /** Resolves within one timeout; afterwards every pending row has been written. */
  drain(): Promise<void>;
}

export interface RuleResult {
  readonly version: number;
  readonly hits: Readonly<Record<QuestionId, boolean>>;
  readonly error?: string;
}

/** One line of `<outputDir>/command-safety/<runId>.jsonl` (spec 7.3). */
export interface CommandSafetyRow extends CallIdentifiers {
  readonly at: string;
  readonly runId: string;
  readonly storyId?: string;
  readonly stage: string;
  readonly identity: "Bash" | "Exec";
  readonly command: string;
  readonly argv?: readonly string[];
  /**
   * Exec only: the argv the Exec tool executed (after normalization); absent
   * when the call did not run. Distinct from `argv`, which is the model's
   * requested argv — and the text `command` is classified on.
   */
  readonly executed?: readonly string[];
  /**
   * The directory the command starts in: the policy root for Bash, the
   * directory the tool ran it in for Exec (absent when it did not run).
   * Recorded for labelling only; it is not part of the model's state.
   */
  readonly cwd?: string;
  readonly mechanical: MechanicalVerdict;
  readonly outcome: { readonly ledger: LedgerOutcome | "unsettled"; readonly decidedBy?: string };
  readonly rules: RuleResult;
  readonly model: {
    readonly status: ModelResult["status"] | "cached";
    readonly questionSetVersion: number;
    readonly answers?: ModelAnswers;
    readonly model?: string;
    readonly decisionId?: string;
    readonly latencyMs?: number;
    readonly error?: string;
  };
}

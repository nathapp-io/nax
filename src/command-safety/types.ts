/**
 * P5 command-safety shadow: shared types.
 *
 * Spec: docs/superpowers/specs/2026-09-23-p5-command-safety-shadow-design.md.
 * Observational only. Nothing typed here can change a verdict, delay a call or
 * fail a call; the types exist so the row a later decision reads is exact.
 */

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
export interface Observation {
  readonly command: string;
  readonly identity: "Bash" | "Exec";
  /** Exec only: the argv verbatim. `command` is it joined with single spaces. */
  readonly argv?: readonly string[];
  readonly stage: string;
  readonly storyId?: string;
  readonly mechanical: MechanicalVerdict;
}

/** Per-story shadow. Every method is total: it never throws. */
export interface CommandShadow {
  observe(key: string, obs: Observation): void;
  settle(key: string, outcome: FinalOutcome): void;
  /** Resolves within one timeout; afterwards every pending row has been written. */
  drain(): Promise<void>;
}

export interface RuleResult {
  readonly version: number;
  readonly hits: Readonly<Record<QuestionId, boolean>>;
  readonly error?: string;
}

/** One line of `<outputDir>/command-safety/<runId>.jsonl` (spec 7.3). */
export interface CommandSafetyRow {
  readonly at: string;
  readonly runId: string;
  readonly storyId?: string;
  readonly stage: string;
  readonly identity: "Bash" | "Exec";
  readonly command: string;
  readonly argv?: readonly string[];
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

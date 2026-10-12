/**
 * The feature workflow (spec §7) as a state machine. Pure orchestration over injected
 * steps, persisted after every step (P4-R1), so a crash resumes at `record.step`.
 * One branch review, exactly one fix pass, one scoped re-review, one adjudication.
 */
import { NaxError } from "@/errors";
import { featurePassed } from "./approval";
import type { BranchFixOutcome } from "./branch-fix";
import type { BranchReviewFacts } from "./branch-review";
import type { PublishOutcome } from "./finalize";
import { ledgerText } from "./ledger";
import type { LedgerItem } from "./ledger-items";
import type { RepoGateRun } from "./repo-gates";
import type { ReviewOutcome } from "./story-review";
import type {
  BranchReviewVerdict,
  FeatureStep,
  MinorItem,
  ReReviewVerdict,
  StorySummary,
  WorkflowFeatureRecord,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowRuling,
} from "./types";

export interface FeatureSteps {
  repoGates(): Promise<RepoGateRun>;
  branchReview(seed: string, facts: BranchReviewFacts): Promise<ReviewOutcome<BranchReviewVerdict>>;
  branchFix(findings: readonly WorkflowFinding[]): Promise<BranchFixOutcome>;
  branchReReview(findings: readonly WorkflowFinding[], fixBase: string): Promise<ReviewOutcome<ReReviewVerdict>>;
  adjudicate(items: readonly WorkflowFinding[]): Promise<readonly WorkflowRuling[]>;
  publish(record: WorkflowFeatureRecord): Promise<PublishOutcome>;
  head(): Promise<string>;
}

export interface FeatureSink {
  update(record: WorkflowFeatureRecord): Promise<void>;
  ledger(text: string): Promise<void>;
  step(step: FeatureStep, record: WorkflowFeatureRecord): void;
}

export interface FeatureFacts {
  readonly stories: readonly StorySummary[];
  readonly parked: readonly LedgerItem[];
  readonly cannotVerify: readonly LedgerItem[];
}

export interface FeatureEnv {
  readonly steps: FeatureSteps;
  readonly sink: FeatureSink;
  readonly facts: FeatureFacts;
  readonly record: WorkflowFeatureRecord;
  readonly aborted: () => boolean;
  readonly now: () => number;
}

type Patch = Partial<WorkflowFeatureRecord>;
type StepFn = (env: FeatureEnv, rec: WorkflowFeatureRecord) => Promise<Patch>;

const isBlocking = (f: WorkflowFindingDraft): boolean => f.severity !== "minor";
const minorIssues = (drafts: readonly WorkflowFindingDraft[]): string[] =>
  drafts.filter((f) => !isBlocking(f)).map((f) => f.issue);

function assign(
  rec: WorkflowFeatureRecord,
  drafts: readonly WorkflowFindingDraft[],
): { findings: WorkflowFinding[]; nextFindingId: number } {
  const findings = drafts.map((d, i) => ({ ...d, id: `B${rec.nextFindingId + i}` }));
  return { findings, nextFindingId: rec.nextFindingId + drafts.length };
}

function minorFinding(m: MinorItem): WorkflowFinding {
  return { id: m.id, kind: "quality", severity: "minor", issue: `${m.storyId}: ${m.text}` };
}

function fixNowMinors(rec: WorkflowFeatureRecord): WorkflowFinding[] {
  return rec.minors.filter((m) => m.triage === "fix-now").map(minorFinding);
}

function storyNote(s: StorySummary): string | undefined {
  const parts = [s.state === "complete" ? undefined : s.reason, s.unreviewed ? "unreviewed" : undefined];
  const kept = parts.filter((p): p is string => typeof p === "string" && p !== "");
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function reviewFacts(env: FeatureEnv, rec: WorkflowFeatureRecord): BranchReviewFacts {
  return {
    stories: env.facts.stories.map((s) => {
      const note = storyNote(s);
      return { id: s.id, state: s.state, ...(note ? { note } : {}) };
    }),
    minors: rec.minors.map((m) => ({ id: m.id, storyId: m.storyId, text: m.text })),
    parked: env.facts.parked,
    cannotVerify: env.facts.cannotVerify,
    gateFindings: rec.gateFindings,
  };
}

async function repoGatesStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const run = await env.steps.repoGates();
  const gateOpen: WorkflowFindingDraft[] = env.facts.stories
    .filter((s) => s.state === "complete-gate-open")
    .map((s) => ({
      kind: "gate",
      severity: "important",
      issue: `${s.id} ended with a red gate (${s.reason ?? "gate red"}). Make its gates green.`,
    }));
  const { findings, nextFindingId } = assign(rec, [...run.findings, ...gateOpen]);
  if (run.summary.failing.length > 0) {
    await env.sink.ledger(ledgerText.note(`repo gates red: ${run.summary.failing.join(", ")}`));
  }
  return { repoGates: run.summary, gateFindings: findings, nextFindingId, step: "branch-review" };
}

async function branchReviewStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (!rec.seed) {
    await env.sink.ledger(ledgerText.reviewSkipped("branch review: no seed"));
    return { reviewRan: false, step: "branch-fix" };
  }
  const out = await env.steps.branchReview(rec.seed, reviewFacts(env, rec));
  if (!out.ran) {
    await env.sink.ledger(ledgerText.reviewSkipped(`branch review: ${out.why}`));
    return { reviewRan: false, step: "branch-fix" };
  }
  for (const item of out.verdict.cannotVerify) await env.sink.ledger(ledgerText.note(`cannot-verify: ${item}`));
  const triage = new Map(out.verdict.minorTriage.map((t) => [t.id, t.decision]));
  const { findings, nextFindingId } = assign(rec, out.verdict.findings.filter(isBlocking));
  return {
    reviewRan: true,
    reviewOpen: findings,
    nextFindingId,
    minors: rec.minors.map((m) => ({ ...m, triage: triage.get(m.id) ?? "leave" })),
    newMinors: [...rec.newMinors, ...minorIssues(out.verdict.findings)],
    step: "branch-fix",
  };
}

async function branchFixStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const toFix = [...rec.reviewOpen, ...fixNowMinors(rec), ...rec.gateFindings];
  if (toFix.length === 0) return { step: "branch-rereview" };
  const fixBase = await env.steps.head();
  await env.sink.ledger(ledgerText.note(`branch fix: ${toFix.length} item(s): ${toFix.map((f) => f.id).join(", ")}`));
  const out = await env.steps.branchFix(toFix);
  if (out.failure) await env.sink.ledger(ledgerText.note(`branch fix session failed: ${out.failure}`));
  if (out.autoCommitted) await env.sink.ledger(ledgerText.note("auto-committed the branch fix's edits"));
  return { fixBase, fixRan: true, step: "branch-rereview" };
}

async function branchReReviewStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const items = [...rec.reviewOpen, ...fixNowMinors(rec)];
  if (items.length === 0 || !rec.fixBase) return { step: "adjudicate" };
  const out = await env.steps.branchReReview(items, rec.fixBase);
  if (!out.ran) {
    await env.sink.ledger(ledgerText.reviewSkipped(`branch re-review: ${out.why}`));
    return { step: "adjudicate" };
  }
  const stillOpen = new Set(out.verdict.verdicts.filter((v) => !v.addressed).map((v) => v.id));
  const { findings, nextFindingId } = assign(rec, out.verdict.newFindings.filter(isBlocking));
  return {
    reviewOpen: [...rec.reviewOpen.filter((f) => stillOpen.has(f.id)), ...findings],
    nextFindingId,
    minors: rec.minors.map((m) => (m.triage === "fix-now" && stillOpen.has(m.id) ? { ...m, triage: "leave" } : m)),
    newMinors: [...rec.newMinors, ...minorIssues(out.verdict.newFindings)],
    step: "adjudicate",
  };
}

async function adjudicateStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (rec.reviewOpen.length === 0) return { step: "final-gates" };
  return { rulings: await env.steps.adjudicate(rec.reviewOpen), step: "final-gates" };
}

async function finalGatesStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  if (!rec.fixRan) return { ...(rec.repoGates ? { finalGates: rec.repoGates } : {}), step: "publish" };
  const run = await env.steps.repoGates();
  if (run.summary.failing.length > 0) {
    await env.sink.ledger(ledgerText.note(`final gates red: ${run.summary.failing.join(", ")}`));
  }
  return { finalGates: run.summary, step: "publish" };
}

async function publishStep(env: FeatureEnv, rec: WorkflowFeatureRecord): Promise<Patch> {
  const out = await env.steps.publish(rec);
  const head = await env.steps.head();
  const why = out.reasons.length > 0 ? `: ${out.reasons.join("; ")}` : "";
  await env.sink.ledger(ledgerText.note(`feature ${out.outcome}${out.url ? ` ${out.url}` : ""}${why}`));
  return {
    outcome: out.outcome,
    ci: out.ci,
    reasons: out.reasons,
    ...(out.url ? { url: out.url } : {}),
    head,
    passed: featurePassed({ ...(rec.finalGates ? { finalGates: rec.finalGates } : {}), stories: env.facts.stories }),
    endedAt: new Date().toISOString(),
    step: "done",
  };
}

const STEPS: Readonly<Record<Exclude<FeatureStep, "done">, StepFn>> = {
  "repo-gates": repoGatesStep,
  "branch-review": branchReviewStep,
  "branch-fix": branchFixStep,
  "branch-rereview": branchReReviewStep,
  adjudicate: adjudicateStep,
  "final-gates": finalGatesStep,
  publish: publishStep,
};

export async function runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord> {
  let rec = env.record;
  for (;;) {
    const step = rec.step;
    if (step === "done") break;
    if (env.aborted()) {
      throw new NaxError("Run aborted during the feature workflow", "WORKFLOW_ABORTED", {
        stage: "workflow",
        storyId: "_run",
        step,
      });
    }
    env.sink.step(step, rec);
    const started = env.now();
    const patch = await STEPS[step](env, rec);
    rec = { ...rec, ...patch, timings: { ...rec.timings, [step]: (rec.timings[step] ?? 0) + (env.now() - started) } };
    await env.sink.update(rec);
  }
  env.sink.step("done", rec);
  return rec;
}

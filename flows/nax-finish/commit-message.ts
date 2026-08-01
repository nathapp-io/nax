/**
 * Commit messages for the flow's `commit_<phase>` checkpoints.
 *
 * These commits are shipped history — they land on the feature branch and a
 * human reviews them in the PR. Every one of them used to read
 * `fix(<feature>): nax-finish <phase> fixes` with an empty body, so a reviewer
 * looking at six such commits could not tell which one re-enabled a disabled
 * market gate and which one renamed a variable. The reviewer already produced
 * exactly the material needed to say so — severity, title, problem, fix — and
 * it was being discarded at the one moment it could have been recorded.
 *
 * Subject lines follow the repo's conventional-commit rule and the 72-column
 * git summary convention; the findings go in the body, one bullet each.
 */
import type { Finding, FinishPhase } from "./types";

/** Git's conventional soft cap for a commit summary line. */
const MAX_SUBJECT_LEN = 72;

/** Worst-first, so the subject of a mixed batch reports the severity that matters. */
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

/** How much gate output to quote in the body before it stops being a commit message. */
const MAX_GATE_OUTPUT_LINES = 20;

interface MessageCtx {
  outputs: Record<string, unknown>;
}

interface PhaseOutputs {
  findings?: Finding[];
  failing?: string[];
  output?: string;
}

function outputsFor(ctx: MessageCtx, nodeId: string): PhaseOutputs {
  return (ctx.outputs[nodeId] ?? {}) as PhaseOutputs;
}

function findingsFor(ctx: MessageCtx, phase: FinishPhase): Finding[] {
  const raw = outputsFor(ctx, `review_${phase}`).findings;
  return Array.isArray(raw) ? raw.filter((f): f is Finding => Boolean(f?.title)) : [];
}

function worstSeverity(findings: Finding[]): string {
  const present = new Set(findings.map((f) => f.severity));
  return SEVERITY_ORDER.find((s) => present.has(s)) ?? findings[0]?.severity ?? "LOW";
}

/**
 * Lowercase a finding title's leading word for the subject line.
 *
 * Reviewers write titles as sentences ("Market gate skip branch is
 * unreachable"); conventional-commit subjects read better in lower case. Only
 * the first character is touched — an all-caps leading token is an acronym
 * (`SSRF guard …`) and must survive intact.
 */
function subjectCase(title: string): string {
  const [first = "", ...rest] = title.split(" ");
  const isAcronym = first.length > 1 && first === first.toUpperCase();
  return isAcronym
    ? title
    : `${first.charAt(0).toLowerCase()}${first.slice(1)}${rest.length ? ` ${rest.join(" ")}` : ""}`;
}

function truncate(s: string): string {
  return s.length <= MAX_SUBJECT_LEN ? s : `${s.slice(0, MAX_SUBJECT_LEN - 3)}...`;
}

/** "lint and test", "lint, test and typecheck" — a readable list for the subject. */
function humanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function reviewSubject(phase: FinishPhase, findings: Finding[]): string {
  if (findings.length === 1) return subjectCase(findings[0].title);
  return `address ${findings.length} ${phase} review findings (worst: ${worstSeverity(findings)})`;
}

function subjectFor(phase: FinishPhase, ctx: MessageCtx): string {
  if (phase === "gate") {
    const failing = outputsFor(ctx, "quality_gates").failing ?? [];
    return failing.length > 0 ? `repair failing ${humanList(failing)} gates` : "repair failing quality gates";
  }
  if (phase === "acceptance") return "repair failing acceptance tests";
  const findings = findingsFor(ctx, phase);
  return findings.length > 0 ? reviewSubject(phase, findings) : `apply ${phase} review fixes`;
}

function bodyFor(phase: FinishPhase, ctx: MessageCtx): string[] {
  if (phase === "gate") {
    const gate = outputsFor(ctx, "quality_gates");
    const failing = gate.failing ?? [];
    const tail = (gate.output ?? "").trim().split("\n").slice(-MAX_GATE_OUTPUT_LINES).join("\n");
    return [...(failing.length > 0 ? [`Failing: ${failing.join(", ")}`] : []), ...(tail ? [tail] : [])];
  }
  if (phase === "acceptance") {
    const tail = (outputsFor(ctx, "acceptance").output ?? "")
      .trim()
      .split("\n")
      .slice(-MAX_GATE_OUTPUT_LINES)
      .join("\n");
    return tail ? [tail] : [];
  }
  const findings = findingsFor(ctx, phase);
  if (findings.length === 0) return [];
  return [
    findings
      .map((f) =>
        [`- [${f.severity}] ${f.title}`, f.problem ? `  ${f.problem}` : "", f.fix ? `  Fix: ${f.fix}` : ""]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n"),
  ];
}

/** Human-readable phase label for the attribution trailer. */
function phaseLabel(phase: FinishPhase): string {
  return phase === "gate" ? "quality gate" : phase === "acceptance" ? "acceptance" : `${phase} review`;
}

/**
 * Build the commit message for a `commit_<phase>` checkpoint.
 *
 * Never throws and never returns an empty subject: a missing or malformed
 * reviewer output degrades to the phase label. A commit that cannot be
 * described is still a commit that must happen — failing here would strand the
 * fix uncommitted and reintroduce the stale-diff bug (#1397).
 */
export function buildFixCommitMessage(phase: FinishPhase, feature: string, ctx: MessageCtx): string {
  const subject = truncate(`fix(${feature}): ${subjectFor(phase, ctx)}`);
  const body = bodyFor(phase, ctx);
  return [subject, ...body, `nax-finish: ${phaseLabel(phase)} fixes`].join("\n\n");
}

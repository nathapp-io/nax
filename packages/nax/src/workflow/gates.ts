/**
 * Deterministic gates (spec §6 steps 3 and 6). A red gate, or a gate command that
 * errors, becomes a finding; nothing here judges code. W-R11: lint/typecheck/scoped
 * after each turn, the full suite once the loop closes.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Finding } from "@/findings";
import {
  type FullSuiteGateOutput,
  fullSuiteGateOp,
  type LintCheckOutput,
  lintCheckOp,
  type TypecheckCheckOutput,
  typecheckCheckOp,
  type VerifyScopedOutput,
  verifyScopedOp,
} from "@/operations";
import { packageDirRelative } from "@/utils/paths";
import { _workflowDeps, type StepContext } from "./step-context";
import type { GateName, GateRunResult, GateState, WorkflowFindingDraft } from "./types";

export const MAX_GATE_FINDINGS = 25;

const SUITE_RED = new Set(["failed", "execution-failed", "timeout", "inconclusive"]);
const SUITE_SKIPPED = new Set(["skipped"]);

interface OneGate {
  readonly state: GateState;
  readonly findings: readonly WorkflowFindingDraft[];
}

function toDrafts(gate: GateName, findings: readonly Finding[]): WorkflowFindingDraft[] {
  const drafts = findings.slice(0, MAX_GATE_FINDINGS).map(
    (f): WorkflowFindingDraft => ({
      kind: "gate",
      gate,
      severity: "important",
      ...(f.file ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      issue: f.message,
    }),
  );
  const hidden = findings.length - drafts.length;
  return hidden > 0
    ? [...drafts, { kind: "gate", gate, severity: "important", issue: `${gate}: ${hidden} more findings not shown` }]
    : drafts;
}

function redWithoutDetail(gate: GateName, issue: string): OneGate {
  return { state: "red", findings: [{ kind: "gate", gate, severity: "important", issue }] };
}

async function guarded(gate: GateName, run: () => Promise<OneGate>): Promise<OneGate> {
  try {
    return await run();
  } catch (err) {
    return redWithoutDetail(gate, `${gate} gate errored: ${errorMessage(err)}`);
  }
}

function fromCheck(gate: GateName, out: LintCheckOutput | TypecheckCheckOutput): OneGate {
  if (out.success) return { state: out.status === "skipped" ? "skipped" : "green", findings: [] };
  return out.findings.length > 0
    ? { state: "red", findings: toDrafts(gate, out.findings) }
    : redWithoutDetail(gate, `${gate} gate failed with no parsed findings`);
}

function combine(entries: readonly (readonly [GateName, OneGate])[]): GateRunResult {
  const states: Partial<Record<GateName, GateState>> = {};
  for (const [name, g] of entries) states[name] = g.state;
  return {
    red: entries.some(([, g]) => g.state === "red"),
    states,
    findings: entries.flatMap(([, g]) => g.findings),
  };
}

export async function runStoryGates(sc: StepContext): Promise<GateRunResult> {
  // The ops resolve their own command (config, then manifest detection) and report
  // status "skipped" when none exists; never pre-skip here or a detected gate goes unrun.
  const checkInput = { workdir: sc.workdir, storyId: sc.story.id, sessionScratchDir: sc.sessionScratchDir };
  const lint = await guarded("lint", async () =>
    fromCheck("lint", await _workflowDeps.callOp(sc.callCtx, lintCheckOp, checkInput)),
  );
  const typecheck = await guarded("typecheck", async () =>
    fromCheck("typecheck", await _workflowDeps.callOp(sc.callCtx, typecheckCheckOp, checkInput)),
  );
  const scoped = await guarded("scoped", async () => {
    const out: VerifyScopedOutput = await _workflowDeps.callOp(sc.callCtx, verifyScopedOp, {
      workdir: sc.workdir,
      storyId: sc.story.id,
      storyGitRef: sc.base,
      naxIgnoreIndex: sc.naxIgnoreIndex,
      regressionMode: "deferred",
      repoRoot: sc.projectDir,
      packagePrefix: packageDirRelative(sc.projectDir, sc.workdir),
      resolvedTestPatterns: sc.resolvedTestPatterns,
      sessionScratchDir: sc.sessionScratchDir,
    });
    if (out.status === "passed") return { state: "green", findings: [] };
    if (out.status === "skipped") return { state: "skipped", findings: [] };
    return out.findings.length > 0
      ? { state: "red", findings: toDrafts("scoped", out.findings) }
      : redWithoutDetail("scoped", `scoped gate ${out.status} with no parsed findings`);
  });
  return combine([
    ["lint", lint],
    ["typecheck", typecheck],
    ["scoped", scoped],
  ]);
}

export async function runFullSuiteGate(sc: StepContext): Promise<GateRunResult> {
  const suite = await guarded("full-suite", async () => {
    const out: FullSuiteGateOutput = await _workflowDeps.callOp(sc.callCtx, fullSuiteGateOp, {
      story: sc.story,
      workdir: sc.workdir,
      featureName: sc.feature,
      projectDir: sc.projectDir,
      executionMode: "sequential",
      resolvedTestPatterns: sc.resolvedTestPatterns,
    });
    if (SUITE_SKIPPED.has(out.status)) return { state: "skipped", findings: [] };
    if (!SUITE_RED.has(out.status)) return { state: "green", findings: [] };
    return out.findings.length > 0
      ? { state: "red", findings: toDrafts("full-suite", out.findings) }
      : redWithoutDetail("full-suite", `full suite ${out.status} with no parsed failures`);
  });
  return combine([["full-suite", suite]]);
}

/**
 * Shared fixtures for the rectification revalidation tests.
 *
 * Split out when `story-orchestrator-revalidation.test.ts` crossed the 800-line test
 * limit: the phase ops and finding shapes are identical across the phase-selection
 * suite and the verifier-SSOT carve-out suite, and duplicating them would leave two
 * definitions to keep in sync.
 *
 * Not a `.test.ts` file — the runner only collects tests, so this holds no assertions.
 */
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { Finding } from "@/findings/types";
import type { RunOperation } from "@/operations";

const testSel = pickSelector("test-revalidation-sel", "execution");

export const mockImplementerOp: RunOperation<{ story: string }, { success: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  // biome-ignore lint/suspicious/noExplicitAny: test double for a heterogeneous op config slice
  config: testSel as any,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "impl", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

export function makePhaseOp(
  name: string,
  stage: string,
  role: string,
): RunOperation<{ story: string }, { success: boolean; findings: Finding[] }, typeof DEFAULT_CONFIG> {
  return {
    kind: "run",
    name,
    // biome-ignore lint/suspicious/noExplicitAny: test double for a heterogeneous op stage
    stage: stage as any,
    // biome-ignore lint/suspicious/noExplicitAny: test double for a heterogeneous op config slice
    config: testSel as any,
    // biome-ignore lint/suspicious/noExplicitAny: test double for a heterogeneous session role
    session: { role: role as any, lifetime: "fresh" },
    build: () => ({
      role: { id: "r", content: name, overridable: false },
      task: { id: "t", content: "", overridable: false },
    }),
    parse: () => ({ success: false, findings: [] }),
  };
}

export const mockVerifierOp = makePhaseOp("verifier", "verify", "verifier");
export const mockFullSuiteGateOp = makePhaseOp("full-suite-gate", "verify", "verifier");
export const mockVerifyScopedOp = makePhaseOp("verify-scoped", "verify", "verifier");
export const mockLintCheckOp = makePhaseOp("lint-check", "verify", "verifier");
export const mockTypecheckCheckOp = makePhaseOp("typecheck-check", "verify", "verifier");
export const mockSemanticReviewOp = makePhaseOp("semantic-review", "review", "reviewer-semantic");
export const mockAdversarialReviewOp = makePhaseOp("adversarial-review", "review", "reviewer-adversarial");

export const ADVISORY = {
  source: "adversarial-review",
  severity: "warning",
  category: "style",
  message: "advisory — seeds the nbf pass",
} as unknown as Finding;

/** The regression a rectification pass introduces: a test-runner failure with a stable identity. */
export const GATE_FAILURE = {
  source: "test-runner",
  severity: "error",
  category: "",
  message: "the regression the nbf pass introduced",
  file: "test/integration/tdd/story-orchestrator-verdict.test.ts",
  rule: "verifier session fails",
} as unknown as Finding;

/** Identity key for {@link GATE_FAILURE}, matching `gateFindingKey`. */
export const GATE_FAILURE_KEY = `${GATE_FAILURE.file}::${GATE_FAILURE.rule}`;

export const LINT_FINDING: Finding = {
  source: "lint",
  tool: "biome",
  severity: "error",
  message: "Unused variable",
  file: "src/foo.ts",
  line: 5,
  category: "",
};
